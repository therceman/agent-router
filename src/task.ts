import { randomUUID } from 'node:crypto';
import { readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ReviewRecord, TaskKind, TaskProfile, TaskRecord, TaskState } from './models.js';
import { PROFILE_DEFINITIONS, ROLE_IDS, type RoleId } from './config.js';
import { pathExists, readJson, removeIfExists, writeJson } from './lib/fs.js';
import { transitionEvent, appendEvent } from './events.js';
import { routeTask } from './router.js';
import { resolveProjectRuntime } from './state.js';

const TASK_EXTENSION = '.json';
const LEGACY_TASK_EXTENSION = '.yaml';

const STATE_DIR: Record<TaskState, string> = {
  draft: 'draft', ready: 'ready', routed: 'active', context_ready: 'active', dispatched: 'active', in_progress: 'active',
  worker_complete: 'review', review_pending: 'review', accepted: 'review', done: 'done', blocked: 'blocked', rejected: 'ready', cancelled: 'cancelled', superseded: 'cancelled',
};

const ALLOWED: Record<TaskState, TaskState[]> = {
  draft: ['ready', 'cancelled', 'superseded'],
  ready: ['routed', 'blocked', 'cancelled', 'superseded'],
  routed: ['context_ready', 'blocked', 'cancelled', 'superseded'],
  context_ready: ['dispatched', 'blocked', 'cancelled', 'superseded'],
  dispatched: ['in_progress', 'worker_complete', 'blocked', 'cancelled', 'superseded'],
  in_progress: ['worker_complete', 'blocked', 'cancelled', 'superseded'],
  worker_complete: ['review_pending', 'rejected', 'blocked', 'superseded'],
  review_pending: ['accepted', 'rejected', 'blocked', 'superseded'],
  accepted: ['done'],
  done: [], blocked: ['ready', 'cancelled', 'superseded'], rejected: ['ready', 'cancelled', 'superseded'], cancelled: [], superseded: [],
};

export function defaultProfile(kind: TaskKind): TaskProfile {
  const base: TaskProfile = {
    task_kind: kind, ambiguity: 1, semantic_complexity: 1, security_criticality: 0, blast_radius: 1,
    novelty: 1, verification_strength: 3, context_scope: 1, destructive_potential: 0, historical_data_impact: 0,
  };
  if (kind === 'orchestration' || kind === 'mechanical') return { ...base, ambiguity: 0, semantic_complexity: 0, blast_radius: 0, context_scope: 0 };
  if (kind === 'repository_hygiene') return { ...base, semantic_complexity: 1, destructive_potential: 1, verification_strength: 2 };
  if (kind === 'exploration') return { ...base, semantic_complexity: 1, context_scope: 2, verification_strength: 2 };
  if (kind === 'architecture') return { ...base, ambiguity: 3, semantic_complexity: 3, blast_radius: 2, novelty: 2, verification_strength: 1, context_scope: 2 };
  if (kind === 'migration') return { ...base, semantic_complexity: 3, blast_radius: 2, historical_data_impact: 2, context_scope: 2 };
  if (kind === 'verification') return { ...base, semantic_complexity: 2, security_criticality: 2, blast_radius: 2 };
  if (kind === 'security_sensitive_development') return { ...base, semantic_complexity: 3, security_criticality: 3, blast_radius: 2, context_scope: 2 };
  if (kind === 'security_research') return { ...base, ambiguity: 3, semantic_complexity: 3, security_criticality: 4, blast_radius: 2, novelty: 3, verification_strength: 1, context_scope: 2 };
  if (kind === 'security_verification') return { ...base, semantic_complexity: 3, security_criticality: 3, blast_radius: 2, destructive_potential: 2, verification_strength: 2, context_scope: 2 };
  return { ...base, semantic_complexity: 2, blast_radius: 1 };
}

export function validateTaskId(taskId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(taskId)) throw new Error(`Invalid task ID: ${taskId}`);
}

export function validateTask(task: TaskRecord): void {
  if (task.schema_version !== 1) throw new Error('Unsupported task schema version');
  validateTaskId(task.task_id);
  if (!task.title.trim() || !task.objective.trim()) throw new Error('Task title and objective are required');
  if (task.superseded_by !== undefined) validateTaskId(task.superseded_by);
  if (task.execution) {
    if (!['default', 'escalated'].includes(task.execution.implementation_tier)) throw new Error('Invalid implementation tier');
    if (!Number.isInteger(task.execution.attempt) || task.execution.attempt < 1) throw new Error('Invalid implementation attempt');
  }
  if (task.state === 'superseded' && !task.superseded_by) throw new Error('Superseded task must identify its replacement');
  for (const [key, max] of Object.entries({ ambiguity: 3, semantic_complexity: 3, security_criticality: 4, blast_radius: 3, novelty: 3, verification_strength: 3, context_scope: 3, destructive_potential: 3, historical_data_impact: 3 })) {
    const value = task.task_profile[key as keyof TaskProfile] as number;
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`Invalid task profile field ${key}`);
  }
  if (task.scope.allowed_paths.length > task.budgets.maximum_files_read) throw new Error('Allowed path count exceeds file budget');
  if (!Array.isArray(task.review.required_roles) || !Array.isArray(task.review.sequence)) throw new Error('Task review roles and sequence are required');
  if (task.review.required_roles.join('|') !== task.review.sequence.join('|')) throw new Error('Task review sequence must contain every required role in order');
}

function taskPath(stateRoot: string, state: TaskState, taskId: string): string {
  return resolve(stateRoot, 'tasks', STATE_DIR[state], `${taskId}${TASK_EXTENSION}`);
}

async function locateTaskCandidates(stateRoot: string, taskId: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const dir of new Set(Object.values(STATE_DIR))) {
    for (const extension of [TASK_EXTENSION, LEGACY_TASK_EXTENSION]) {
      const path = resolve(stateRoot, 'tasks', dir, `${taskId}${extension}`);
      if (await pathExists(path)) candidates.push(path);
    }
  }
  return candidates;
}

async function migrateLegacyTask(path: string, task: TaskRecord): Promise<string> {
  if (!path.endsWith(LEGACY_TASK_EXTENSION)) return path;
  const destination = `${path.slice(0, -LEGACY_TASK_EXTENSION.length)}${TASK_EXTENSION}`;
  if (await pathExists(destination)) throw new Error(`Duplicate task records exist: ${path}, ${destination}`);
  await writeJson(destination, task);
  await rm(path, { force: true });
  return destination;
}

async function locateTask(stateRoot: string, taskId: string): Promise<{ path: string; task: TaskRecord }> {
  validateTaskId(taskId);
  const candidates = await locateTaskCandidates(stateRoot, taskId);
  if (!candidates.length) throw new Error(`Task not found: ${taskId}`);
  if (candidates.length > 1) throw new Error(`Duplicate task records exist for ${taskId}: ${candidates.join(', ')}`);
  const originalPath = candidates[0]!;
  const task = await readJson<TaskRecord>(originalPath);
  const path = await migrateLegacyTask(originalPath, task);
  return { path, task };
}

function requiredReviews(kind: TaskKind, profileRoles: string[]): string[] {
  if (kind === 'orchestration' || kind === 'mechanical' || kind === 'repository_hygiene' || kind === 'exploration') return [];
  if (kind === 'architecture') return ['external_reviewer'];
  return [...profileRoles];
}

export async function createTask(input: {
  cwd?: string;
  id: string;
  title: string;
  objective: string;
  kind: TaskKind;
  planRef?: string;
  allowedPaths?: string[];
  acceptance?: string[];
  targetedTests?: string[];
  checkpointTests?: string[];
}): Promise<TaskRecord> {
  const runtime = await resolveProjectRuntime(input.cwd);
  try {
    await locateTask(runtime.stateRoot, input.id);
    throw new Error(`Task already exists: ${input.id}`);
  } catch (error) {
    if ((error as Error).message.startsWith('Task already exists')) throw error;
    if (!(error as Error).message.startsWith('Task not found')) throw error;
  }
  const now = new Date().toISOString();
  const definition = PROFILE_DEFINITIONS[runtime.project.profile];
  const reviews = requiredReviews(input.kind, definition.required_review_roles);
  const task: TaskRecord = {
    schema_version: 1,
    task_id: input.id,
    title: input.title,
    profile: runtime.project.profile,
    state: 'draft',
    objective: input.objective,
    ...(input.planRef ? { plan_ref: input.planRef } : {}),
    execution: { implementation_tier: 'default', attempt: 1 },
    task_profile: defaultProfile(input.kind),
    scope: { allowed_paths: input.allowedPaths ?? [], forbidden_paths: ['.git', 'node_modules', 'dist', 'build', 'coverage', '.agent-router', '.codex'] },
    budgets: { maximum_files_read: 12, maximum_context_bytes: 150000, maximum_single_file_bytes: 50000, maximum_tool_output_chars: 16000, repository_wide_scan: false, full_test_suite: false, recursive_delegation: false },
    acceptance: input.acceptance ?? [],
    tests: { targeted: input.targetedTests ?? [], checkpoint: input.checkpointTests ?? [] },
    manual_verification: [],
    outputs: ['structured_handoff', 'test_summary', 'manual_verification_summary', 'changed_file_list'],
    review: { required: reviews.length > 0, required_roles: reviews, sequence: reviews },
    created_at: now,
    updated_at: now,
  };
  validateTask(task);
  await writeJson(taskPath(runtime.stateRoot, 'draft', task.task_id), task);
  await appendEvent(runtime.stateRoot, { task_id: task.task_id, type: 'task_created', details: { title: task.title, profile: task.profile, plan_ref: task.plan_ref ?? null } });
  return task;
}

export async function getTask(taskId: string, cwd?: string): Promise<{ root: string; stateRoot: string; projectId: string; path: string; task: TaskRecord }> {
  const runtime = await resolveProjectRuntime(cwd);
  const found = await locateTask(runtime.stateRoot, taskId);
  validateTask(found.task);
  return { root: runtime.repoRoot, stateRoot: runtime.stateRoot, projectId: runtime.projectId, ...found };
}

export async function listTasks(cwd?: string): Promise<TaskRecord[]> {
  const runtime = await resolveProjectRuntime(cwd);
  const ids = new Set<string>();
  for (const dir of new Set(Object.values(STATE_DIR))) {
    const path = resolve(runtime.stateRoot, 'tasks', dir);
    if (!(await pathExists(path))) continue;
    for (const name of await readdir(path)) {
      if (name.endsWith(TASK_EXTENSION)) ids.add(name.slice(0, -TASK_EXTENSION.length));
      else if (name.endsWith(LEGACY_TASK_EXTENSION)) ids.add(name.slice(0, -LEGACY_TASK_EXTENSION.length));
    }
  }
  const out: TaskRecord[] = [];
  for (const id of [...ids].sort()) out.push((await locateTask(runtime.stateRoot, id)).task);
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function persistTransition(
  taskId: string,
  to: TaskState,
  cwd?: string,
  details?: Record<string, unknown>,
  mutate?: (task: TaskRecord) => void,
): Promise<TaskRecord> {
  const { root, stateRoot, path, task } = await getTask(taskId, cwd);
  if (!ALLOWED[task.state].includes(to)) throw new Error(`Illegal task transition: ${task.state} -> ${to}`);
  const from = task.state;
  mutate?.(task);
  task.state = to;
  task.updated_at = new Date().toISOString();
  validateTask(task);
  const destination = taskPath(stateRoot, to, taskId);
  if (destination === path) {
    await writeJson(path, task);
  } else {
    const staged = `${path}.moving-${randomUUID()}`;
    await rename(path, staged);
    try {
      await writeJson(destination, task);
      await rm(staged, { force: true });
    } catch (error) {
      await rm(destination, { force: true }).catch(() => undefined);
      await rename(staged, path).catch(() => undefined);
      throw error;
    }
  }
  await transitionEvent(stateRoot, taskId, from, to, details);
  void root;
  return task;
}

export async function transitionTask(taskId: string, to: TaskState, cwd?: string, details?: Record<string, unknown>): Promise<TaskRecord> {
  return persistTransition(taskId, to, cwd, details);
}

export async function activateTask(taskId: string, cwd?: string): Promise<TaskRecord> {
  const { task } = await getTask(taskId, cwd);
  if (task.state !== 'draft') throw new Error(`Task activation is only for draft tasks; current state is ${task.state}. Use task retry for blocked or rejected tasks.`);
  return transitionTask(taskId, 'ready', cwd);
}

export async function startTask(taskId: string, cwd?: string): Promise<TaskRecord> {
  const { task } = await getTask(taskId, cwd);
  if (task.state !== 'dispatched') throw new Error(`Task must be dispatched before start; current state is ${task.state}`);
  return transitionTask(taskId, 'in_progress', cwd);
}

export async function retryTask(taskId: string, cwd?: string): Promise<TaskRecord> {
  const { root, stateRoot, task } = await getTask(taskId, cwd);
  if (!['blocked', 'rejected'].includes(task.state)) throw new Error(`Task can only be retried from blocked or rejected; current state is ${task.state}`);
  if (task.state === 'rejected' && task.execution?.implementation_tier === 'escalated') {
    throw new Error('Task already used the Terra-high escalation attempt; create an architect review task instead of retrying again.');
  }
  await removeIfExists(resolve(stateRoot, 'generated', `${taskId}.route.json`));
  await removeIfExists(resolve(stateRoot, 'contexts', `${taskId}.json`));
  await removeIfExists(resolve(stateRoot, 'handoffs', `${taskId}.json`));
  await removeIfExists(resolve(stateRoot, 'reviews', taskId));
  return persistTransition(taskId, 'ready', root, {
    reset_execution_artifacts: true,
    escalated_to_terra: task.state === 'rejected',
  }, (record) => {
    const current = record.execution ?? { implementation_tier: 'default' as const, attempt: 1 };
    record.execution = {
      implementation_tier: task.state === 'rejected' ? 'escalated' : current.implementation_tier,
      attempt: current.attempt + 1,
      ...(task.state === 'rejected' ? { escalation_reason: 'implementation_rejected' } : current.escalation_reason ? { escalation_reason: current.escalation_reason } : {}),
    };
  });
}

export async function supersedeTask(taskId: string, replacementTaskId: string, cwd?: string): Promise<TaskRecord> {
  validateTaskId(replacementTaskId);
  if (taskId === replacementTaskId) throw new Error('Task cannot supersede itself');
  const { root, task } = await getTask(taskId, cwd);
  if (['accepted', 'done', 'cancelled', 'superseded'].includes(task.state)) throw new Error(`Task in state ${task.state} cannot be superseded`);
  let replacement: TaskRecord;
  try {
    replacement = (await getTask(replacementTaskId, root)).task;
  } catch (error) {
    if ((error as Error).message.startsWith('Task not found')) throw new Error(`Superseding replacement task does not exist: ${replacementTaskId}`);
    throw error;
  }
  if (['done', 'cancelled', 'superseded'].includes(replacement.state)) throw new Error(`Replacement task ${replacementTaskId} is not active`);
  return persistTransition(taskId, 'superseded', root, { superseded_by: replacementTaskId }, (record) => {
    record.superseded_by = replacementTaskId;
  });
}

export async function routeAndPersist(taskId: string, cwd?: string): Promise<ReturnType<typeof routeTask>> {
  const { root, stateRoot, task } = await getTask(taskId, cwd);
  if (task.state !== 'ready') throw new Error(`Task must be ready before routing; current state is ${task.state}`);
  const project = await readJson<{ enabled_roles?: RoleId[]; profile: TaskRecord['profile'] }>(resolve(stateRoot, 'project.yaml'));
  const definition = PROFILE_DEFINITIONS[project.profile];
  const planExempt = ['architecture', 'orchestration', 'mechanical', 'repository_hygiene', 'exploration'].includes(task.task_profile.task_kind);
  if (definition.requires_plan && !planExempt) {
    if (!task.plan_ref) throw new Error(`Profile ${project.profile} requires --plan for ${task.task_profile.task_kind} tasks`);
    if (!(await pathExists(resolve(stateRoot, 'plans', `${task.plan_ref}.json`)))) throw new Error(`Task plan does not exist: ${task.plan_ref}`);
  }
  const route = routeTask(task);
  const enabledRoles = project.enabled_roles ?? [...ROLE_IDS];
  if (!enabledRoles.includes(route.role as RoleId)) {
    throw new Error(`Route requires disabled role ${route.role}. Enabled roles: ${enabledRoles.join(', ')}. Reclassify the task or register the project with the required profile.`);
  }
  await writeJson(resolve(stateRoot, 'generated', `${taskId}.route.json`), route);
  await transitionTask(taskId, 'routed', root, { route: route.role, model: route.provider_model });
  return route;
}

export async function dispatchTask(taskId: string, cwd?: string): Promise<TaskRecord> {
  const { task } = await getTask(taskId, cwd);
  if (task.state !== 'context_ready') throw new Error(`Task must have a valid context before dispatch; current state is ${task.state}`);
  return transitionTask(taskId, 'dispatched', cwd);
}

function reviewFileName(role: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(role)) throw new Error(`Invalid review role: ${role}`);
  return `${role}.json`;
}

export async function acceptTask(taskId: string, cwd?: string): Promise<TaskRecord> {
  const { root, stateRoot, task } = await getTask(taskId, cwd);
  if (task.state !== 'review_pending') throw new Error(`Task must be review_pending before acceptance; current state is ${task.state}`);
  const accepted: string[] = [];
  for (const role of task.review.required_roles) {
    const reviewPath = resolve(stateRoot, 'reviews', taskId, reviewFileName(role));
    if (!(await pathExists(reviewPath))) throw new Error(`Required review is missing: ${role}`);
    const review = await readJson<ReviewRecord>(reviewPath);
    if (!['accepted', 'accepted_with_followup'].includes(review.verdict)) throw new Error(`Review ${role} does not permit acceptance: ${review.verdict}`);
    accepted.push(role);
  }
  await transitionTask(taskId, 'accepted', root, { accepted_reviews: accepted });
  return transitionTask(taskId, 'done', root);
}

export async function nextTask(cwd?: string): Promise<TaskRecord | null> {
  const tasks = await listTasks(cwd);
  return tasks.find((task) => task.state === 'ready') ?? tasks.find((task) => task.state === 'draft') ?? null;
}
