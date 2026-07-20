import { readFile, readdir } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { AGENTS_END, AGENTS_START, VERSION } from './constants.js';
import {
  DEFAULT_MODEL_MAP,
  PROFILE_DEFINITIONS,
  globalPaths,
  policyForProfile,
  type ProfileId,
  type RoleId,
} from './config.js';
import { pathExists, readJson, writeJson } from './lib/fs.js';
import { codexSetupStatus } from './provider/codex.js';
import { CONTEXT_DOC, HANDOFF_DOC, MAIN_CONTRACT, PROFILE_DOCS, REVIEW_DOC, ROLE_DOCS, ROUTING_DOC, WORKFLOW_DOC } from './templates.js';
import {
  bindProject,
  listRegisteredProjects,
  readBindings,
  registerProject,
  resolveProjectRuntime,
  unbindProject,
  writeRuntimeFiles,
} from './state.js';

function roleDocKey(role: RoleId): string {
  return role.replaceAll('_', '-');
}

export async function syncProject(options: { cwd?: string; check?: boolean; dryRun?: boolean } = {}): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(options.cwd);
  const project = runtime.project;
  const stale: string[] = [];
  if (project.version !== VERSION) stale.push('project.yaml:version');
  const expected: Array<[string, string]> = [
    ['policy.yaml', `${JSON.stringify(policyForProfile(project.profile), null, 2)}\n`],
    ['model-map.yaml', `${JSON.stringify(DEFAULT_MODEL_MAP, null, 2)}\n`],
    ['runtime/MAIN_SESSION.md', MAIN_CONTRACT],
    ['runtime/WORKFLOW.md', WORKFLOW_DOC],
    ['runtime/ROUTING.md', ROUTING_DOC],
    ['runtime/CONTEXT_POLICY.md', CONTEXT_DOC],
    ['runtime/HANDOFF_PROTOCOL.md', HANDOFF_DOC],
    ['runtime/REVIEW_PROTOCOL.md', REVIEW_DOC],
    ['runtime/PROFILE.md', PROFILE_DOCS[project.profile]!],
  ];
  for (const role of project.enabled_roles) {
    const key = roleDocKey(role);
    expected.push([`roles/${key}.md`, ROLE_DOCS[key]!]);
  }
  for (const [rel, content] of expected) {
    const path = resolve(runtime.stateRoot, rel);
    if (!(await pathExists(path)) || await readFile(path, 'utf8') !== content) stale.push(rel);
  }
  if (options.check) return { root: runtime.repoRoot, state_root: runtime.stateRoot, profile: project.profile, stale, current: stale.length === 0 };
  if (!options.dryRun) {
    project.version = VERSION;
    project.updated_at = new Date().toISOString();
    await writeJson(resolve(runtime.stateRoot, 'project.yaml'), project);
    await writeJson(resolve(runtime.stateRoot, 'policy.yaml'), policyForProfile(project.profile));
    await writeJson(resolve(runtime.stateRoot, 'model-map.yaml'), DEFAULT_MODEL_MAP);
    await writeRuntimeFiles(runtime.stateRoot, project.profile, project.enabled_roles);
  }
  return { root: runtime.repoRoot, state_root: runtime.stateRoot, profile: project.profile, updated: stale, dry_run: Boolean(options.dryRun) };
}

export async function ejectProject(options: { cwd?: string; dryRun?: boolean } = {}): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(options.cwd);
  if (options.dryRun) {
    return {
      root: runtime.repoRoot,
      state_root: runtime.stateRoot,
      project_id: runtime.projectId,
      action: 'unbind',
      history_preserved: true,
      work_repository_writes: [],
      dry_run: true,
    };
  }
  return {
    root: runtime.repoRoot,
    state_root: runtime.stateRoot,
    ...(await unbindProject(runtime.projectId)),
    history_preserved: true,
    work_repository_writes: [],
  };
}

export async function projectStatus(cwd?: string): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd);
  const taskCounts: Record<string, number> = {};
  for (const state of ['draft', 'ready', 'active', 'review', 'blocked', 'done', 'cancelled']) {
    const dir = resolve(runtime.stateRoot, 'tasks', state);
    taskCounts[state] = (await pathExists(dir)) ? (await readdir(dir)).filter((n) => n.endsWith('.json') || n.endsWith('.yaml')).length : 0;
  }
  return {
    root: runtime.repoRoot,
    state_root: runtime.stateRoot,
    project_id: runtime.projectId,
    profile: runtime.project.profile,
    profile_definition: PROFILE_DEFINITIONS[runtime.project.profile],
    initialized: true,
    project: runtime.project,
    tasks: taskCounts,
  };
}

export async function doctorProject(cwd?: string): Promise<{
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string; severity?: 'error' | 'warning' }>;
}> {
  const runtime = await resolveProjectRuntime(cwd);
  const checks: Array<{ name: string; ok: boolean; detail: string; severity?: 'error' | 'warning' }> = [];
  const add = (name: string, ok: boolean, detail: string, severity: 'error' | 'warning' = 'error') => checks.push({ name, ok, detail, severity });
  add('node_version', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node);
  const stateRelation = relative(resolve(runtime.repoRoot), resolve(runtime.stateRoot));
  const stateOutsideRepository = stateRelation === '..' || stateRelation.startsWith('../') || isAbsolute(stateRelation);
  add('home_state_root', stateOutsideRepository, `${runtime.stateRoot} must remain outside the work repository`);
  add('project_manifest', await pathExists(resolve(runtime.stateRoot, 'project.yaml')), resolve(runtime.stateRoot, 'project.yaml'));
  add('policy', await pathExists(resolve(runtime.stateRoot, 'policy.yaml')), resolve(runtime.stateRoot, 'policy.yaml'));
  add('model_map', await pathExists(resolve(runtime.stateRoot, 'model-map.yaml')), resolve(runtime.stateRoot, 'model-map.yaml'));
  add('events_log', await pathExists(resolve(runtime.stateRoot, 'events/events.jsonl')), resolve(runtime.stateRoot, 'events/events.jsonl'));
  add('zero_footprint_agent_router', !(await pathExists(resolve(runtime.repoRoot, '.agent-router'))), `${runtime.repoRoot}/.agent-router must not exist`);
  add('zero_footprint_codex', !(await pathExists(resolve(runtime.repoRoot, '.codex'))), `${runtime.repoRoot}/.codex must not exist`);
  const agentsPath = resolve(runtime.repoRoot, 'AGENTS.md');
  const agents = (await pathExists(agentsPath)) ? await readFile(agentsPath, 'utf8') : '';
  add('zero_footprint_agents_block', !(agents.includes(AGENTS_START) || agents.includes(AGENTS_END)), 'No Agent Router managed block in repository AGENTS.md');
  const bindings = await readBindings();
  add('machine_binding', Boolean(bindings.projects[runtime.projectId]), `${globalPaths().bindings}/machine.json`);
  const provider = await codexSetupStatus() as {
    profile_exists?: boolean;
    global_agents_managed?: boolean;
    global_override_exists?: boolean;
    agents?: string[];
  };
  add('codex_profile', Boolean(provider.profile_exists), '~/.codex/agent-router.config.toml');
  add('global_agents', Boolean(provider.global_agents_managed), '~/.codex/AGENTS.md');
  add('global_agents_effective', !provider.global_override_exists, '~/.codex/AGENTS.override.md must not shadow AGENTS.md', 'warning');
  const expectedAgents = runtime.project.enabled_roles
    .filter((role) => role !== 'main')
    .map((role) => `agent-router-${role.replaceAll('_', '-')}.toml`);
  const availableAgents = new Set(provider.agents ?? []);
  const missingAgents = expectedAgents.filter((name) => !availableAgents.has(name));
  add('codex_agents_available', missingAgents.length === 0, missingAgents.length ? `missing: ${missingAgents.join(', ')}` : expectedAgents.join(', '));
  const sync = await syncProject({ cwd: runtime.repoRoot, check: true });
  add('managed_files_current', (sync as { current: boolean }).current, `${((sync as { stale: string[] }).stale).length} stale`);
  return { ok: checks.filter((c) => c.severity !== 'warning').every((c) => c.ok), checks };
}

export { bindProject, unbindProject, listRegisteredProjects, registerProject };
