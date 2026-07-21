import { basename, resolve } from 'node:path';
import { realpath, readdir } from 'node:fs/promises';
import { VERSION } from './constants.js';
import {
  DEFAULT_MODEL_MAP,
  PROFILE_DEFINITIONS,
  ROLE_IDS,
  globalPaths,
  parseProfile,
  policyForProfile,
  type ProfileId,
  type RoleId,
} from './config.js';
import { ensureDir, pathExists, readJson, writeJson, atomicWrite, removeIfExists } from './lib/fs.js';
import { findGitRoot } from './lib/path.js';
import { run } from './lib/process.js';
import { sha256 } from './lib/hash.js';
import { CONTEXT_DOC, HANDOFF_DOC, MAIN_CONTRACT, PROFILE_DOCS, REVIEW_DOC, ROLE_DOCS, ROUTING_DOC, WORKFLOW_DOC } from './templates.js';

export interface ProjectRecord {
  [key: string]: unknown;
  schema_version: 1;
  version: string;
  project_id: string;
  name: string;
  profile: ProfileId;
  provider: 'codex';
  enabled_roles: RoleId[];
  repository: {
    identity: string;
    remote: string | null;
  };
  created_at: string;
  updated_at: string;
}

export interface RegisterProjectResult {
  repo_root: string;
  state_root: string;
  project: ProjectRecord;
  work_repo_writes: string[];
  dry_run: boolean;
}

export interface MachineBindings {
  schema_version: 1;
  projects: Record<string, { repository_path: string; updated_at: string }>;
}

export interface ProjectRuntime {
  repoRoot: string;
  stateRoot: string;
  projectId: string;
  project: ProjectRecord;
}

const PROJECT_RECORD_KEYS = new Set([
  'schema_version', 'version', 'project_id', 'name', 'profile', 'provider',
  'enabled_roles', 'repository', 'created_at', 'updated_at',
]);

async function readProjectRecord(path: string): Promise<ProjectRecord> {
  const value = await readJson<Record<string, unknown>>(path);
  const unknown = Object.keys(value).filter((key) => !PROJECT_RECORD_KEYS.has(key));
  if (unknown.length) throw new Error(`Project state contains unknown fields in ${path}: ${unknown.join(', ')}`);
  if (value.schema_version !== 1) throw new Error(`Unsupported project schema version in ${path}`);
  if (typeof value.version !== 'string' || !value.version) throw new Error(`Invalid project version in ${path}`);
  if (typeof value.project_id !== 'string') throw new Error(`Invalid project ID in ${path}`);
  validateProjectId(value.project_id);
  if (typeof value.name !== 'string' || !value.name) throw new Error(`Invalid project name in ${path}`);
  if (typeof value.profile !== 'string') throw new Error(`Invalid project profile in ${path}`);
  const profile = parseProfile(value.profile);
  const definition = PROFILE_DEFINITIONS[profile];
  if (value.provider !== 'codex') throw new Error(`Unsupported project provider in ${path}`);
  if (!Array.isArray(value.enabled_roles) || !value.enabled_roles.every((role) => typeof role === 'string' && ROLE_IDS.includes(role as RoleId))) {
    throw new Error(`Invalid enabled roles in ${path}`);
  }
  const enabledRoles = value.enabled_roles as RoleId[];
  if (!enabledRoles.includes('main')) throw new Error(`Project roles must include main in ${path}`);
  const disallowed = enabledRoles.filter((role) => !definition.roles.includes(role));
  if (disallowed.length) throw new Error(`Project profile ${profile} does not permit roles: ${disallowed.join(', ')}`);
  const missingRequired = definition.roles.filter((role) => !enabledRoles.includes(role));
  if (missingRequired.length) throw new Error(`Project profile ${profile} requires roles: ${missingRequired.join(', ')}`);
  const repository = value.repository;
  if (!repository || typeof repository !== 'object' || typeof (repository as Record<string, unknown>).identity !== 'string') {
    throw new Error(`Invalid repository identity in ${path}`);
  }
  const remote = (repository as Record<string, unknown>).remote;
  if (remote !== null && typeof remote !== 'string') throw new Error(`Invalid repository remote in ${path}`);
  if (typeof value.created_at !== 'string' || typeof value.updated_at !== 'string') throw new Error(`Invalid project timestamps in ${path}`);
  return { ...value, profile } as unknown as ProjectRecord;
}

function roleDocKey(role: RoleId): string {
  return role.replaceAll('_', '-');
}

function normalizeRemote(remote: string): string {
  const trimmed = remote.trim();
  if (!trimmed) return '';
  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  let normalized: string;
  if (scp && !trimmed.includes('://')) normalized = `${scp[1]}/${scp[2]}`;
  else {
    try {
      const url = new URL(trimmed);
      normalized = `${url.hostname}${url.pathname}`;
    } catch {
      normalized = trimmed;
    }
  }
  return normalized.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').toLowerCase();
}

function slugify(value: string): string {
  const parts = value.split('/').filter(Boolean);
  const candidate = parts.slice(-2).join('-') || value;
  return candidate.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'project';
}

export async function repositoryIdentity(repoRoot: string): Promise<{ identity: string; remote: string | null; projectId: string }> {
  const result = run('git', ['config', '--get', 'remote.origin.url'], repoRoot);
  const remote = result.status === 0 ? result.stdout.trim() : '';
  if (remote) {
    const identity = `git:${normalizeRemote(remote)}`;
    return { identity, remote, projectId: `${slugify(identity.slice(4))}-${sha256(identity).slice(0, 8)}` };
  }
  const rootReal = await realpath(repoRoot);
  const identity = `local:${rootReal}`;
  return { identity, remote: null, projectId: `${slugify(basename(rootReal))}-${sha256(identity).slice(0, 8)}` };
}

export function validateProjectId(projectId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{2,79}$/.test(projectId)) throw new Error(`Invalid project ID: ${projectId}`);
}

export function projectStateRoot(projectId: string): string {
  validateProjectId(projectId);
  return resolve(globalPaths().projects, projectId);
}

function bindingsPath(): string {
  return resolve(globalPaths().bindings, 'machine.json');
}

export async function readBindings(): Promise<MachineBindings> {
  const path = bindingsPath();
  if (!(await pathExists(path))) return { schema_version: 1, projects: {} };
  const value = await readJson<MachineBindings>(path);
  if (value.schema_version !== 1 || !value.projects || typeof value.projects !== 'object') throw new Error(`Invalid machine bindings: ${path}`);
  return value;
}

async function writeBindings(value: MachineBindings): Promise<void> {
  await writeJson(bindingsPath(), value);
}

async function createStateDirectories(stateRoot: string): Promise<void> {
  const directories = [
    'plans',
    'tasks/draft', 'tasks/ready', 'tasks/active', 'tasks/review', 'tasks/blocked', 'tasks/done', 'tasks/cancelled',
    'contexts', 'handoffs', 'reviews', 'events', 'generated', 'manifests', 'runtime', 'roles', 'logs',
    'tasks/amendments', 'sessions/active', 'sessions/retired', 'assignments/active', 'assignments/history', 'locks',
  ];
  for (const dir of directories) await ensureDir(resolve(stateRoot, dir));
  const events = resolve(stateRoot, 'events/events.jsonl');
  if (!(await pathExists(events))) await atomicWrite(events, '');
  const sessionEvents = resolve(stateRoot, 'sessions/events.jsonl');
  if (!(await pathExists(sessionEvents))) await atomicWrite(sessionEvents, '');
}

export async function writeRuntimeFiles(stateRoot: string, profile: ProfileId, roles: RoleId[]): Promise<void> {
  const files: Array<[string, string]> = [
    ['runtime/MAIN_SESSION.md', MAIN_CONTRACT],
    ['runtime/WORKFLOW.md', WORKFLOW_DOC],
    ['runtime/ROUTING.md', ROUTING_DOC],
    ['runtime/CONTEXT_POLICY.md', CONTEXT_DOC],
    ['runtime/HANDOFF_PROTOCOL.md', HANDOFF_DOC],
    ['runtime/REVIEW_PROTOCOL.md', REVIEW_DOC],
    ['runtime/PROFILE.md', PROFILE_DOCS[profile]!],
  ];
  for (const role of roles) {
    const key = roleDocKey(role);
    const content = ROLE_DOCS[key];
    if (!content) throw new Error(`Missing role documentation for ${role}`);
    files.push([`roles/${key}.md`, content]);
  }
  for (const [rel, content] of files) await atomicWrite(resolve(stateRoot, rel), content);

  const roleDir = resolve(stateRoot, 'roles');
  const enabled = new Set(roles.map(roleDocKey));
  for (const name of await readdir(roleDir)) {
    if (name.endsWith('.md') && !enabled.has(name.slice(0, -3))) await removeIfExists(resolve(roleDir, name));
  }
}

export async function registerProject(options: {
  cwd?: string;
  name?: string;
  projectId?: string;
  profile?: ProfileId;
  roles?: RoleId[];
  dryRun?: boolean;
} = {}): Promise<RegisterProjectResult> {
  const repoRoot = await findGitRoot(options.cwd);
  const identity = await repositoryIdentity(repoRoot);
  const projectId = options.projectId ?? identity.projectId;
  validateProjectId(projectId);
  const stateRoot = projectStateRoot(projectId);
  const profile = parseProfile(options.profile);
  const definition = PROFILE_DEFINITIONS[profile];
  const roles = options.roles ?? [...definition.roles];
  const invalid = roles.filter((role) => !ROLE_IDS.includes(role));
  if (invalid.length) throw new Error(`Unknown roles: ${invalid.join(', ')}`);
  const normalizedRoles = (roles.includes('main') ? [...new Set(roles)] : ['main', ...new Set(roles)]) as RoleId[];
  const missingRequired = definition.roles.filter((role) => !normalizedRoles.includes(role));
  if (missingRequired.length) throw new Error(`Profile ${profile} requires roles: ${missingRequired.join(', ')}`);
  const disallowed = normalizedRoles.filter((role) => !definition.roles.includes(role));
  if (disallowed.length) throw new Error(`Profile ${profile} does not permit roles: ${disallowed.join(', ')}`);

  const now = new Date().toISOString();
  const existingPath = resolve(stateRoot, 'project.yaml');
  const existing = (await pathExists(existingPath)) ? await readProjectRecord(existingPath) : null;
  if (existing && existing.repository.identity !== identity.identity) {
    throw new Error(`Project ID ${projectId} is already registered for a different repository identity`);
  }
  const record: ProjectRecord = {
    schema_version: 1,
    version: VERSION,
    project_id: projectId,
    name: options.name ?? existing?.name ?? basename(repoRoot),
    profile,
    provider: 'codex',
    enabled_roles: normalizedRoles,
    repository: { identity: identity.identity, remote: identity.remote },
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const plan = { repo_root: repoRoot, state_root: stateRoot, project: record, work_repo_writes: [] as string[], dry_run: Boolean(options.dryRun) };
  if (options.dryRun) return plan;

  await createStateDirectories(stateRoot);
  await writeJson(existingPath, record);
  await writeJson(resolve(stateRoot, 'policy.yaml'), policyForProfile(profile));
  await writeJson(resolve(stateRoot, 'model-map.yaml'), DEFAULT_MODEL_MAP);
  await writeRuntimeFiles(stateRoot, profile, record.enabled_roles);
  await writeJson(resolve(stateRoot, 'manifests/runtime.json'), {
    schema_version: 1,
    version: VERSION,
    profile,
    repository_path_written: false,
    managed_state_root: stateRoot,
    generated_at: now,
  });
  const bindings = await readBindings();
  bindings.projects[projectId] = { repository_path: await realpath(repoRoot), updated_at: now };
  await writeBindings(bindings);
  return plan;
}

export async function bindProject(projectId: string, repositoryPath: string): Promise<Record<string, unknown>> {
  const repoRoot = await findGitRoot(repositoryPath);
  const stateRoot = projectStateRoot(projectId);
  if (!(await pathExists(resolve(stateRoot, 'project.yaml')))) throw new Error(`Unknown project: ${projectId}`);
  const project = await readProjectRecord(resolve(stateRoot, 'project.yaml'));
  const identity = await repositoryIdentity(repoRoot);
  if (project.repository.remote && !identity.remote) {
    throw new Error(`Repository has no origin remote but project ${projectId} is bound to ${project.repository.remote}`);
  }
  if (project.repository.remote && identity.remote && normalizeRemote(project.repository.remote) !== normalizeRemote(identity.remote)) {
    throw new Error(`Repository remote does not match project ${projectId}`);
  }
  const bindings = await readBindings();
  bindings.projects[projectId] = { repository_path: await realpath(repoRoot), updated_at: new Date().toISOString() };
  await writeBindings(bindings);
  return { project_id: projectId, repository_path: repoRoot, state_root: stateRoot };
}

export async function unbindProject(projectId: string): Promise<Record<string, unknown>> {
  validateProjectId(projectId);
  const bindings = await readBindings();
  const existed = Boolean(bindings.projects[projectId]);
  delete bindings.projects[projectId];
  await writeBindings(bindings);
  return { project_id: projectId, unbound: existed, work_repository_writes: [] };
}

export async function listRegisteredProjects(): Promise<Array<Record<string, unknown>>> {
  const paths = globalPaths();
  const bindings = await readBindings();
  if (!(await pathExists(paths.projects))) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const name of (await readdir(paths.projects)).sort()) {
    const projectPath = resolve(paths.projects, name, 'project.yaml');
    if (!(await pathExists(projectPath))) continue;
    const project = await readProjectRecord(projectPath);
    out.push({ ...project, repository_path: bindings.projects[project.project_id]?.repository_path ?? null });
  }
  return out;
}

export async function resolveProjectRuntime(cwd?: string): Promise<ProjectRuntime> {
  const repoRoot = await findGitRoot(cwd);
  const rootReal = await realpath(repoRoot);
  const bindings = await readBindings();
  const bound = Object.entries(bindings.projects).find(([, value]) => resolve(value.repository_path) === resolve(rootReal));
  const projectId = bound?.[0];
  if (!projectId) throw new Error(`Repository is not registered with Agent Router on this machine: ${repoRoot}. Run: agent-router project register --profile development, or agent-router project bind <project-id> <repository-path>`);
  const stateRoot = projectStateRoot(projectId);
  const project = await readProjectRecord(resolve(stateRoot, 'project.yaml'));
  return { repoRoot, stateRoot, projectId, project };
}

export async function bootstrapSession(cwd?: string): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd);
  const taskStates = ['ready', 'draft', 'active', 'review', 'blocked'] as const;
  let nextTask: string | null = null;
  for (const state of taskStates) {
    const dir = resolve(runtime.stateRoot, 'tasks', state);
    if (!(await pathExists(dir))) continue;
    const name = (await readdir(dir)).filter((item) => item.endsWith('.json') || item.endsWith('.yaml')).sort()[0];
    if (name) { nextTask = name.replace(/\.(json|yaml)$/, ''); break; }
  }
  const plansDir = resolve(runtime.stateRoot, 'plans');
  const plans = (await pathExists(plansDir)) ? (await readdir(plansDir)).filter((name) => name.endsWith('.json')).sort().map((name) => name.slice(0, -5)) : [];
  const definition = PROFILE_DEFINITIONS[runtime.project.profile];
  const storedPolicy = await readJson<Record<string, unknown>>(resolve(runtime.stateRoot, 'policy.yaml')).catch(() => policyForProfile(runtime.project.profile));
  const sessionPolicy = (storedPolicy.session_policy ?? policyForProfile(runtime.project.profile).session_policy) as { enabled: boolean; maximum_tasks_per_session: number };
  const sessionCounts: Record<string, number> = { idle: 0, busy: 0, stale: 0 };
  const activeSessionsDir = resolve(runtime.stateRoot, 'sessions/active');
  if (await pathExists(activeSessionsDir)) {
    for (const name of (await readdir(activeSessionsDir)).filter((item) => item.endsWith('.json'))) {
      try { const record = await readJson<{ status?: string }>(resolve(activeSessionsDir, name)); if (record.status && Object.hasOwn(sessionCounts, record.status)) sessionCounts[record.status] = (sessionCounts[record.status] ?? 0) + 1; } catch { /* doctor/reconcile reports corrupt records */ }
    }
  }
  const requiredAction = nextTask ? (await pathExists(resolve(runtime.stateRoot, 'generated', `${nextTask}.route.json`)) ? (await pathExists(resolve(runtime.stateRoot, 'contexts', `${nextTask}.json`)) ? (await pathExists(resolve(runtime.stateRoot, 'tasks/active', `${nextTask}.json`)) ? 'acquire' : 'dispatch') : 'context') : 'route') : 'none';
  const repoFootprint = {
    agent_router_dir: await pathExists(resolve(runtime.repoRoot, '.agent-router')),
    codex_dir: await pathExists(resolve(runtime.repoRoot, '.codex')),
  };
  let instruction: string;
  if (definition.requires_plan && plans.length === 0) {
    instruction = definition.brain === 'local-sol'
      ? 'Create one bounded architecture task for the Sol architect, import the approved plan, then create implementation tasks.'
      : 'Import the external approved plan before creating or routing implementation tasks.';
  } else {
    instruction = nextTask ? `Continue task ${nextTask} through the ${runtime.project.profile} workflow.` : 'Create one bounded task from the active plan.';
  }
  return {
    schema_version: 1,
    active: true,
    project_id: runtime.projectId,
    repository: runtime.repoRoot,
    state_root: runtime.stateRoot,
    profile: runtime.project.profile,
    brain: definition.brain,
    enabled_roles: runtime.project.enabled_roles,
    required_review_roles: definition.required_review_roles,
    review_pack_purpose: definition.review_pack_purpose,
    plans,
    next_task: nextTask,
    repository_footprint: repoFootprint,
    main_contract: resolve(runtime.stateRoot, 'runtime/MAIN_SESSION.md'),
    profile_contract: resolve(runtime.stateRoot, 'runtime/PROFILE.md'),
    policy: resolve(runtime.stateRoot, 'policy.yaml'),
    instruction,
    session_policy: { enabled: sessionPolicy.enabled, maximum_tasks_per_session: sessionPolicy.maximum_tasks_per_session },
    active_sessions: sessionCounts,
    required_action: requiredAction,
  };
}
