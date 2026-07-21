import { randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AssignmentRecord, SessionEventRecord, SessionPolicy, SessionRecord, SessionRetireReason, SessionStatus, TaskRecord } from './models.js';
import { PROFILE_DEFINITIONS, ROLE_IDS, ROLE_METADATA, defaultSessionPolicy, validateSessionPolicy, type RoleId } from './config.js';
import { appendEvent } from './events.js';
import { getTask, validateTask } from './task.js';
import { canonicalJson, canonicalSha256, sha256 } from './lib/hash.js';
import { ensureDir, pathExists, readJson, withFileLock, writeJson } from './lib/fs.js';
import { validateProjectId, resolveProjectRuntime } from './state.js';
import { buildContext, readContext } from './context.js';
import { providerCapabilities } from './provider-capabilities.js';
import { loadAmendments, materializeEffectiveTaskContract } from './amendment.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const SESSION_ID = /^SES-[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const ASSIGNMENT_ID = /^ASN-[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const ACTIVE_ASSIGNMENT = new Set(['pending_transport', 'transport_confirmed', 'acknowledged']);
const RETIRE_REASONS: SessionRetireReason[] = ['explicit', 'task_limit', 'failure_limit', 'idle_timeout', 'implementation_rejected', 'scope_violation', 'handoff_validation_failed', 'model_changed', 'reasoning_changed', 'role_changed', 'repository_changed', 'sandbox_changed', 'approval_policy_changed', 'provider_agent_unavailable', 'resume_failed', 'session_corrupt', 'project_unbound', 'project_ejected', 'campaign_complete', 'critical_freshness_policy'];
const TRANSITIONS: Record<SessionStatus, SessionStatus[]> = {
  pending_spawn: ['reserved', 'busy', 'stale', 'retiring', 'retired', 'failed'],
  idle: ['reserved', 'retiring', 'retired', 'stale'],
  reserved: ['busy', 'idle', 'stale', 'retiring', 'retired'],
  busy: ['idle', 'stale', 'retiring', 'failed'],
  stale: ['reserved', 'retiring', 'retired', 'failed'],
  retiring: ['retired', 'failed'],
  retired: [],
  failed: [],
};

export interface SessionAcquireResult {
  action: 'spawn' | 'send_input' | 'resume';
  project_id: string;
  session_id: string;
  task_id: string;
  task_revision: number;
  role: RoleId;
  provider_model: string;
  reasoning: SessionRecord['reasoning'];
  assignment_id: string;
  dispatch_command: string;
  dispatch_message: string;
  provider_agent_id?: string;
}

function revisionOf(task: TaskRecord): number { return task.revision ?? 1; }
function activeSessionPath(stateRoot: string, id: string): string { return resolve(stateRoot, 'sessions/active', `${id}.json`); }
function retiredSessionPath(stateRoot: string, id: string): string { return resolve(stateRoot, 'sessions/retired', `${id}.json`); }
function activeAssignmentPath(stateRoot: string, taskId: string): string { return resolve(stateRoot, 'assignments/active', `${taskId}.json`); }
function assignmentHistoryDir(stateRoot: string, taskId: string): string { return resolve(stateRoot, 'assignments/history', taskId); }
function sessionLockPath(stateRoot: string): string { return resolve(stateRoot, 'locks/session-state.lock'); }
function taskLockPath(stateRoot: string, taskId: string): string { return resolve(stateRoot, 'locks/task-TASK.lock'.replace('TASK', taskId)); }

export function validateSessionId(id: string): void { if (!SESSION_ID.test(id)) throw new Error(`Invalid session ID: ${id}`); }
export function validateAssignmentId(id: string): void { if (!ASSIGNMENT_ID.test(id)) throw new Error(`Invalid assignment ID: ${id}`); }

export function buildDispatchMessage(input: { operation: 'open' | 'sync' | 'reopen'; taskId: string; sessionId: string }): string {
  if (!['open', 'sync', 'reopen'].includes(input.operation)) throw new Error(`Invalid dispatch operation: ${input.operation}`);
  if (!ID.test(input.taskId)) throw new Error(`Invalid task ID: ${input.taskId}`);
  validateSessionId(input.sessionId);
  const command = `agent-router work ${input.operation} ${input.taskId} --session ${input.sessionId}`;
  if (command.length > 240) throw new Error('Dispatch command exceeds bounded length');
  return `Execute:\n${command}`;
}

export function dispatchCommand(message: string): string {
  const lines = message.replaceAll('\r\n', '\n').split('\n');
  if (lines.length !== 2 || lines[0] !== 'Execute:' || !lines[1]?.startsWith('agent-router work ')) throw new Error('Invalid generated dispatch message');
  return lines[1];
}

export function compatibilityKey(input: { project_id: string; role: RoleId; provider: 'codex'; provider_model: string; reasoning: SessionRecord['reasoning']; repository_root: string; sandbox_mode: SessionRecord['sandbox_mode']; approval_policy: string }): string {
  validateProjectId(input.project_id);
  if (!ROLE_IDS.includes(input.role)) throw new Error(`Invalid session role: ${input.role}`);
  return canonicalSha256({ project_id: input.project_id, role: input.role, provider: input.provider, provider_model: input.provider_model, reasoning: input.reasoning, repository_root: resolve(input.repository_root), sandbox_mode: input.sandbox_mode, approval_policy: input.approval_policy });
}

function validateSession(record: SessionRecord): void {
  if (record.schema_version !== 1) throw new Error('Unsupported session schema version');
  validateSessionId(record.session_id);
  validateProjectId(record.project_id);
  if (record.provider !== 'codex' || !ROLE_IDS.includes(record.role) || record.role === 'main') throw new Error('Invalid session provider or role');
  if (!['cheap', 'balanced', 'expert'].includes(record.model_class) || !['low', 'medium', 'high', 'xhigh'].includes(record.reasoning)) throw new Error('Invalid session model or reasoning');
  if (!resolve(record.repository_root).startsWith('/') || resolve(record.repository_root) !== record.repository_root) throw new Error('Session repository root must be absolute and normalized');
  if (!['read-only', 'workspace-write'].includes(record.sandbox_mode) || typeof record.approval_policy !== 'string' || !record.approval_policy) throw new Error('Invalid session sandbox or approval policy');
  if (!Object.keys(TRANSITIONS).includes(record.status)) throw new Error(`Invalid session status: ${record.status}`);
  if (!/^[a-f0-9]{64}$/.test(record.compatibility_key)) throw new Error('Invalid session compatibility key');
  for (const key of ['tasks_completed', 'failed_tasks', 'rejected_tasks'] as const) if (!Number.isInteger(record[key]) || record[key] < 0) throw new Error(`Invalid session counter: ${key}`);
  for (const key of ['created_at', 'updated_at', 'last_used_at'] as const) if (!Number.isFinite(Date.parse(record[key]))) throw new Error(`Invalid session timestamp: ${key}`);
  if (record.status === 'retired' && (!record.retire_reason || !record.retired_at)) throw new Error('Retired session requires reason and retired_at');
  if ((record.status === 'reserved' || record.status === 'busy') && (!record.current_assignment_id || !record.assigned_task || !record.assigned_revision)) throw new Error(`${record.status} session requires active assignment fields`);
  if (record.status === 'idle' && !record.provider_agent_id) throw new Error('Idle session requires provider agent ID');
  if (record.status === 'idle' && (record.current_assignment_id || record.assigned_task || record.assigned_revision !== undefined)) throw new Error('Idle session cannot have active assignment fields');
}

function validateAssignment(record: AssignmentRecord): void {
  if (record.schema_version !== 1) throw new Error('Unsupported assignment schema version');
  validateAssignmentId(record.assignment_id);
  validateProjectId(record.project_id); validateSessionId(record.session_id);
  if (!ID.test(record.task_id) || !ROLE_IDS.includes(record.role) || record.role === 'main') throw new Error('Invalid assignment identity or role');
  if (!Number.isInteger(record.task_revision) || record.task_revision < 1) throw new Error('Invalid assignment revision');
  if (!/^[a-f0-9]{64}$/.test(record.route_sha256) || !/^[a-f0-9]{64}$/.test(record.context_sha256)) throw new Error('Invalid assignment record hash');
  dispatchCommand(record.dispatch_message);
  if (record.dispatch_command !== dispatchCommand(record.dispatch_message)) throw new Error('Assignment dispatch command mismatch');
  if (!new RegExp(`^agent-router work (open|sync|reopen) ${record.task_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --session ${record.session_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(record.dispatch_command)) throw new Error('Assignment dispatch identity mismatch');
  if (!Number.isFinite(Date.parse(record.created_at)) || !Number.isFinite(Date.parse(record.updated_at))) throw new Error('Invalid assignment timestamps');
}

async function appendSessionEvent(stateRoot: string, input: Omit<SessionEventRecord, 'schema_version' | 'event_id' | 'at'>): Promise<SessionEventRecord> {
  const event: SessionEventRecord = { schema_version: 1, event_id: `sev_${randomUUID()}`, at: new Date().toISOString(), ...input };
  await ensureDir(resolve(stateRoot, 'sessions'));
  await import('node:fs/promises').then(({ appendFile }) => appendFile(resolve(stateRoot, 'sessions/events.jsonl'), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 }));
  return event;
}

async function readSession(stateRoot: string, id: string): Promise<{ path: string; session: SessionRecord }> {
  validateSessionId(id);
  const active = activeSessionPath(stateRoot, id);
  const retired = retiredSessionPath(stateRoot, id);
  if (await pathExists(active)) { const session = await readJson<SessionRecord>(active); validateSession(session); return { path: active, session }; }
  if (await pathExists(retired)) { const session = await readJson<SessionRecord>(retired); validateSession(session); return { path: retired, session }; }
  throw new Error(`Session not found: ${id}`);
}

async function readActiveAssignments(stateRoot: string): Promise<AssignmentRecord[]> {
  const dir = resolve(stateRoot, 'assignments/active');
  if (!(await pathExists(dir))) return [];
  const values: AssignmentRecord[] = [];
  for (const name of (await readdir(dir)).filter((item) => item.endsWith('.json')).sort()) {
    const value = await readJson<AssignmentRecord>(resolve(dir, name)); validateAssignment(value); values.push(value);
  }
  return values;
}

async function archiveAssignment(stateRoot: string, assignment: AssignmentRecord): Promise<void> {
  await ensureDir(assignmentHistoryDir(stateRoot, assignment.task_id));
  const historyDir = assignmentHistoryDir(stateRoot, assignment.task_id);
  const names = (await readdir(historyDir).catch(() => [])).filter((name) => /^\d{4}\.json$/.test(name));
  await writeJson(resolve(historyDir, `${String(names.length + 1).padStart(4, '0')}.json`), assignment);
  await rm(activeAssignmentPath(stateRoot, assignment.task_id), { force: true });
}

async function readPolicy(stateRoot: string): Promise<SessionPolicy> {
  const path = resolve(stateRoot, 'policy.yaml');
  if (!(await pathExists(path))) return defaultSessionPolicy();
  const value = await readJson<Record<string, unknown>>(path);
  const policy = (value.session_policy ?? defaultSessionPolicy()) as SessionPolicy;
  validateSessionPolicy(policy);
  return policy;
}

async function routeAndContext(stateRoot: string, taskId: string): Promise<{ route: Record<string, unknown>; routeHash: string; context: Awaited<ReturnType<typeof readContext>>; contextHash: string }> {
  const routePath = resolve(stateRoot, 'generated', `${taskId}.route.json`);
  const contextPath = resolve(stateRoot, 'contexts', `${taskId}.json`);
  if (!(await pathExists(routePath)) || !(await pathExists(contextPath))) throw new Error('Route and context are required before session acquisition');
  const route = await readJson<Record<string, unknown>>(routePath);
  const context = await readJson<Awaited<ReturnType<typeof readContext>>>(contextPath);
  return { route, routeHash: canonicalSha256(route), context, contextHash: canonicalSha256(context) };
}

function policyFor(sessionPolicy: SessionPolicy, role: RoleId): { maximumTasks: number; maximumIdleMinutes: number; persistent: boolean; fresh: boolean } {
  const rolePolicy = sessionPolicy.role_policies[role];
  return { maximumTasks: rolePolicy?.maximum_tasks_per_session ?? sessionPolicy.maximum_tasks_per_session, maximumIdleMinutes: rolePolicy?.maximum_idle_minutes ?? sessionPolicy.maximum_idle_minutes, persistent: rolePolicy?.persistent ?? true, fresh: rolePolicy?.fresh_session_required ?? false };
}

function sessionReusable(session: SessionRecord, expectedKey: string, policy: SessionPolicy, role: RoleId): boolean {
  const rolePolicy = policyFor(policy, role);
  if (rolePolicy.fresh || session.status !== 'idle' || !session.provider_agent_id || session.compatibility_key !== expectedKey) return false;
  if (session.tasks_completed >= rolePolicy.maximumTasks || session.failed_tasks >= policy.maximum_failed_tasks || session.rejected_tasks >= policy.maximum_rejected_tasks) return false;
  if (session.idle_since && Date.now() - Date.parse(session.idle_since) > rolePolicy.maximumIdleMinutes * 60_000) return false;
  return !session.current_assignment_id && !session.assigned_task;
}

async function persistSession(stateRoot: string, session: SessionRecord, from?: SessionStatus, details?: Record<string, unknown>): Promise<void> {
  validateSession(session);
  await writeJson(activeSessionPath(stateRoot, session.session_id), session);
  if (from && from !== session.status) await appendSessionEvent(stateRoot, { project_id: session.project_id, session_id: session.session_id, type: `session_${session.status}`, from_status: from, to_status: session.status, task_id: session.assigned_task, assignment_id: session.current_assignment_id, details });
}

async function transitionSession(stateRoot: string, session: SessionRecord, to: SessionStatus, details?: Record<string, unknown>): Promise<void> {
  if (!TRANSITIONS[session.status].includes(to)) throw new Error(`Illegal session transition: ${session.status} -> ${to}`);
  const from = session.status; session.status = to; session.updated_at = new Date().toISOString(); session.last_used_at = session.updated_at;
  await persistSession(stateRoot, session, from, details);
}

async function retireInternal(stateRoot: string, session: SessionRecord, reason: SessionRetireReason, details?: Record<string, unknown>): Promise<{ action: 'close'; session_id: string; provider_agent_id?: string }> {
  if (session.status !== 'retiring') await transitionSession(stateRoot, session, 'retiring', { reason, ...details });
  session.retire_reason = reason; session.retired_at = new Date().toISOString(); session.updated_at = session.retired_at; session.status = 'retired';
  validateSession(session);
  const active = activeSessionPath(stateRoot, session.session_id);
  const retired = retiredSessionPath(stateRoot, session.session_id);
  await ensureDir(resolve(stateRoot, 'sessions/retired'));
  await writeJson(retired, session); await rm(active, { force: true });
  await appendSessionEvent(stateRoot, { project_id: session.project_id, session_id: session.session_id, type: 'session_retired', from_status: 'retiring', to_status: 'retired', details: { reason, ...details } });
  return { action: 'close', session_id: session.session_id, ...(session.provider_agent_id ? { provider_agent_id: session.provider_agent_id } : {}) };
}

export async function acquireSession(taskId: string, cwd?: string, requestedRole?: RoleId): Promise<SessionAcquireResult> {
  const runtime = await resolveProjectRuntime(cwd);
  const initial = await getTask(taskId, runtime.repoRoot);
  if (initial.task.state !== 'dispatched') throw new Error(`Session acquisition requires a dispatched task; current state is ${initial.task.state}`);
  const currentRevision = revisionOf(initial.task);
  const { route, routeHash, context, contextHash } = await routeAndContext(runtime.stateRoot, taskId);
  const amendments = await loadAmendments(runtime.stateRoot, taskId);
  const operation: 'open' | 'reopen' = amendments.some((item) => item.amendment_kind === 'retry') ? 'reopen' : 'open';
  const role = (requestedRole ?? route.role) as RoleId;
  if (!ROLE_IDS.includes(role) || role === 'main') throw new Error(`Invalid worker route role: ${role}`);
  if (route.role !== role) throw new Error(`Requested role ${role} does not match route role ${route.role}`);
  const definition = PROFILE_DEFINITIONS[runtime.project.profile];
  if (!definition.roles.includes(role) || !runtime.project.enabled_roles.includes(role)) throw new Error(`Role ${role} is not authorized by project profile ${runtime.project.profile}`);
  if (context.task_id !== taskId) throw new Error('Context task identity mismatch');
  const policy = await readPolicy(runtime.stateRoot);
  if (!policy.enabled) throw new Error('Session policy is disabled');
  return withFileLock(sessionLockPath(runtime.stateRoot), { command: 'session acquire', project_id: runtime.projectId }, async () => withFileLock(taskLockPath(runtime.stateRoot, taskId), { command: 'session acquire', project_id: runtime.projectId }, async () => {
    const taskFound = await getTask(taskId, runtime.repoRoot);
    if (taskFound.task.state !== 'dispatched' || revisionOf(taskFound.task) !== currentRevision) throw new Error('Task changed while acquiring a session');
    const activeAssignments = await readActiveAssignments(runtime.stateRoot);
    const existing = activeAssignments.find((item) => item.task_id === taskId && ACTIVE_ASSIGNMENT.has(item.status));
    if (existing) throw new Error(`Task already has an active assignment: ${existing.assignment_id}`);
    const modelClass = route.model_class as SessionRecord['model_class'];
    const reasoning = route.reasoning as SessionRecord['reasoning'];
    const providerModel = String(route.provider_model);
    const repositoryRoot = resolve(runtime.repoRoot);
    const sandbox = ROLE_METADATA[role].sandbox_mode;
    const approval = typeof route.approval_policy === 'string' ? route.approval_policy : 'on-request';
    const key = compatibilityKey({ project_id: runtime.projectId, role, provider: 'codex', provider_model: providerModel, reasoning, repository_root: repositoryRoot, sandbox_mode: sandbox, approval_policy: approval });
    const sessions: SessionRecord[] = [];
    const activeDir = resolve(runtime.stateRoot, 'sessions/active');
    if (await pathExists(activeDir)) for (const name of (await readdir(activeDir)).filter((item) => item.endsWith('.json')).sort()) { const item = await readJson<SessionRecord>(resolve(activeDir, name)); validateSession(item); sessions.push(item); }
    const caps = await providerCapabilities();
    for (const candidate of sessions) {
      const candidatePolicy = policyFor(policy, candidate.role);
      const idleExpired = candidate.status === 'idle' && candidate.idle_since && Date.now() - Date.parse(candidate.idle_since) > candidatePolicy.maximumIdleMinutes * 60_000;
      const overLimit = candidate.status === 'idle' && (candidate.tasks_completed >= candidatePolicy.maximumTasks || candidate.failed_tasks >= policy.maximum_failed_tasks || candidate.rejected_tasks >= policy.maximum_rejected_tasks);
      if (candidate.status === 'idle' && (!candidate.provider_agent_id || idleExpired || overLimit)) await retireInternal(runtime.stateRoot, candidate, !candidate.provider_agent_id ? 'session_corrupt' : idleExpired ? 'idle_timeout' : candidate.failed_tasks >= policy.maximum_failed_tasks ? 'failure_limit' : candidate.rejected_tasks >= policy.maximum_rejected_tasks ? 'implementation_rejected' : 'task_limit');
      if (candidate.status === 'stale' && candidate.compatibility_key === key && caps.resume === false) await retireInternal(runtime.stateRoot, candidate, 'provider_agent_unavailable');
    }
    let session = sessions.find((item) => sessionReusable(item, key, policy, role));
    let action: SessionAcquireResult['action'];
    if (!session) {
      const stale = sessions.find((item) => item.status === 'stale' && item.provider_agent_id && item.compatibility_key === key && caps.resume !== false);
      if (stale) { session = stale; action = 'resume'; }
      else {
        const now = new Date().toISOString();
        session = { schema_version: 1, session_id: `SES-${randomUUID()}`, project_id: runtime.projectId, provider: 'codex', role, model_class: modelClass, provider_model: providerModel, reasoning, repository_root: repositoryRoot, sandbox_mode: sandbox, approval_policy: approval, status: 'pending_spawn', compatibility_key: key, tasks_completed: 0, failed_tasks: 0, rejected_tasks: 0, created_at: now, updated_at: now, last_used_at: now, last_transport_action: 'spawn', last_transport_result: 'pending' };
        validateSession(session); await ensureDir(activeDir); await writeJson(activeSessionPath(runtime.stateRoot, session.session_id), session); await appendSessionEvent(runtime.stateRoot, { project_id: runtime.projectId, session_id: session.session_id, type: 'session_created', to_status: 'pending_spawn', details: { role } }); action = 'spawn';
      }
    } else {
      action = 'send_input';
    }
    const assignmentId = `ASN-${randomUUID()}`;
    const message = buildDispatchMessage({ operation, taskId, sessionId: session.session_id });
    const assignment: AssignmentRecord = { schema_version: 1, assignment_id: assignmentId, project_id: runtime.projectId, task_id: taskId, task_revision: currentRevision, session_id: session.session_id, role, route_sha256: routeHash, context_sha256: contextHash, transport_action: action, ...(session.provider_agent_id ? { provider_agent_id: session.provider_agent_id } : {}), dispatch_command: dispatchCommand(message), dispatch_message: message, status: 'pending_transport', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    validateAssignment(assignment);
    session.current_assignment_id = assignmentId; session.assigned_task = taskId; session.assigned_revision = currentRevision; session.acknowledged_revision = undefined; session.last_transport_action = action; session.last_transport_result = 'pending'; session.updated_at = new Date().toISOString();
    if (action !== 'spawn' && session.status !== 'reserved') await transitionSession(runtime.stateRoot, session, 'reserved', { reuse: action === 'send_input' ? true : 'resume' });
    else await persistSession(runtime.stateRoot, session);
    if (action === 'send_input') await appendSessionEvent(runtime.stateRoot, { project_id: runtime.projectId, session_id: session.session_id, type: 'session_reused', to_status: 'reserved', details: { role } });
    if (action === 'resume') await appendSessionEvent(runtime.stateRoot, { project_id: runtime.projectId, session_id: session.session_id, type: 'session_resumed', to_status: 'reserved', details: { role } });
    await writeJson(activeAssignmentPath(runtime.stateRoot, taskId), assignment);
    const task = { ...taskFound.task, last_assignment_id: assignmentId, last_session_id: session.session_id, updated_at: new Date().toISOString() };
    validateTask(task); await writeJson(taskFound.path, task);
    await appendEvent(runtime.stateRoot, { task_id: taskId, type: 'session_assignment_created', details: { assignment_id: assignmentId, session_id: session.session_id, action, revision: currentRevision } });
    await appendSessionEvent(runtime.stateRoot, { project_id: runtime.projectId, session_id: session.session_id, task_id: taskId, assignment_id: assignmentId, type: 'dispatch_message_generated', details: { characters: assignment.dispatch_message.length, action } });
    return { action, project_id: runtime.projectId, session_id: session.session_id, task_id: taskId, task_revision: currentRevision, role, provider_model: providerModel, reasoning, assignment_id: assignmentId, dispatch_command: assignment.dispatch_command, dispatch_message: assignment.dispatch_message, ...(session.provider_agent_id ? { provider_agent_id: session.provider_agent_id } : {}) };
  }));
}

function normalizeAction(action: 'spawn' | 'send-input' | 'send_input' | 'resume'): 'spawn' | 'send_input' | 'resume' { const normalized = action === 'send-input' ? 'send_input' : action; if (!['spawn', 'send_input', 'resume'].includes(normalized)) throw new Error(`Invalid transport action: ${action}`); return normalized; }

export async function confirmSession(input: { sessionId: string; action: 'spawn' | 'send-input' | 'send_input' | 'resume'; providerAgentId?: string; cwd?: string }): Promise<SessionRecord> {
  const runtime = await resolveProjectRuntime(input.cwd); const action = normalizeAction(input.action); const found = await readSession(runtime.stateRoot, input.sessionId); if (!found.path.includes('/active/')) throw new Error('Retired session cannot be confirmed');
  const session = found.session; if (session.last_transport_action !== action || session.last_transport_result !== 'pending') throw new Error('No pending transport action matches confirmation');
  if (action === 'spawn') { if (!input.providerAgentId) throw new Error('Provider agent ID is required after spawn'); session.provider_agent_id = input.providerAgentId; }
  else if (session.provider_agent_id && input.providerAgentId && session.provider_agent_id !== input.providerAgentId) throw new Error('Provider agent ID does not match session');
  else if (!session.provider_agent_id && input.providerAgentId) session.provider_agent_id = input.providerAgentId;
  session.last_transport_result = 'succeeded'; session.updated_at = new Date().toISOString(); session.last_used_at = session.updated_at;
  const assignment = session.current_assignment_id ? await readJson<AssignmentRecord>(activeAssignmentPath(runtime.stateRoot, session.assigned_task!)) : undefined;
  if (!assignment || assignment.assignment_id !== session.current_assignment_id) throw new Error('Session assignment is missing');
  assignment.status = 'transport_confirmed'; assignment.transport_confirmed_at = session.updated_at; assignment.updated_at = session.updated_at; if (session.provider_agent_id) assignment.provider_agent_id = session.provider_agent_id;
  validateAssignment(assignment); await writeJson(activeAssignmentPath(runtime.stateRoot, assignment.task_id), assignment); await persistSession(runtime.stateRoot, session); await appendSessionEvent(runtime.stateRoot, { project_id: runtime.projectId, session_id: session.session_id, task_id: assignment.task_id, assignment_id: assignment.assignment_id, type: 'transport_confirmed', from_status: session.status, to_status: session.status, details: { action } });
  return session;
}

export async function transportFailed(input: { sessionId: string; action: 'spawn' | 'send-input' | 'send_input' | 'resume'; reason: string; detail?: string; cwd?: string }): Promise<SessionRecord> {
  const runtime = await resolveProjectRuntime(input.cwd); const action = normalizeAction(input.action); const found = await readSession(runtime.stateRoot, input.sessionId); const session = found.session;
  session.last_transport_action = action; session.last_transport_result = 'failed'; session.last_transport_error = input.detail ?? input.reason; session.updated_at = new Date().toISOString();
  if (session.current_assignment_id && session.assigned_task) { const path = activeAssignmentPath(runtime.stateRoot, session.assigned_task); if (await pathExists(path)) { const assignment = await readJson<AssignmentRecord>(path); assignment.status = 'stale'; assignment.failure_code = input.reason; assignment.failure_detail = input.detail; assignment.updated_at = session.updated_at; await archiveAssignment(runtime.stateRoot, assignment); } session.current_assignment_id = undefined; session.assigned_task = undefined; session.assigned_revision = undefined; session.acknowledged_revision = undefined; }
  if (action === 'resume') {
    if (session.status !== 'retiring') await transitionSession(runtime.stateRoot, session, 'retiring', { failure: input.reason });
    const actionResult = await retireInternal(runtime.stateRoot, session, 'resume_failed', { failure: input.reason });
    await appendSessionEvent(runtime.stateRoot, { project_id: runtime.projectId, session_id: session.session_id, type: 'transport_failed', details: { action, reason: input.reason } });
    void actionResult;
    return session;
  }
  else if (session.status !== 'stale' && session.status !== 'retiring' && session.status !== 'retired') await transitionSession(runtime.stateRoot, session, session.status === 'pending_spawn' ? 'failed' : 'stale', { failure: input.reason });
  await appendSessionEvent(runtime.stateRoot, { project_id: runtime.projectId, session_id: session.session_id, type: 'transport_failed', from_status: session.status, to_status: session.status, details: { action, reason: input.reason } });
  if (session.status !== 'retired') await persistSession(runtime.stateRoot, session); return session;
}

async function completeAssignment(stateRoot: string, session: SessionRecord, assignment: AssignmentRecord, status: 'completed' | 'blocked' | 'relinquished'): Promise<{ session: SessionRecord; assignment: AssignmentRecord }> {
  assignment.status = status; assignment.completed_at = new Date().toISOString(); assignment.updated_at = assignment.completed_at; validateAssignment(assignment);
  await ensureDir(assignmentHistoryDir(stateRoot, assignment.task_id));
  const historyDir = assignmentHistoryDir(stateRoot, assignment.task_id);
  const names = (await readdir(historyDir).catch(() => [])).filter((name) => /^\d{4}\.json$/.test(name));
  const index = String(names.length + 1).padStart(4, '0');
  await writeJson(resolve(historyDir, `${index}.json`), assignment); await rm(activeAssignmentPath(stateRoot, assignment.task_id), { force: true });
  session.tasks_completed += status === 'completed' ? 1 : 0; session.failed_tasks += status === 'blocked' ? 1 : 0; session.updated_at = new Date().toISOString(); session.last_used_at = session.updated_at; session.current_assignment_id = undefined; session.assigned_task = undefined; session.assigned_revision = undefined; session.acknowledged_revision = undefined; session.idle_since = session.updated_at;
  if (session.status !== 'retiring' && session.status !== 'retired' && session.provider_agent_id) await transitionSession(stateRoot, session, 'idle', { assignment_status: status });
  else if (session.status !== 'retiring' && session.status !== 'retired') await retireInternal(stateRoot, session, 'provider_agent_unavailable');
  await appendSessionEvent(stateRoot, { project_id: session.project_id, session_id: session.session_id, task_id: assignment.task_id, assignment_id: assignment.assignment_id, type: 'session_released', from_status: 'busy', to_status: session.status, details: { assignment_status: status } });
  const policy = await readPolicy(stateRoot); const rolePolicy = policyFor(policy, session.role);
  if ((status === 'completed' && (!rolePolicy.persistent || rolePolicy.fresh || session.tasks_completed >= rolePolicy.maximumTasks)) || session.failed_tasks >= policy.maximum_failed_tasks) {
    await retireInternal(stateRoot, session, session.failed_tasks >= policy.maximum_failed_tasks ? 'failure_limit' : rolePolicy.fresh ? 'critical_freshness_policy' : 'task_limit');
  }
  if (session.status !== 'retired') await persistSession(stateRoot, session); return { session, assignment };
}

export async function releaseSession(input: { sessionId: string; taskId: string; cwd?: string }): Promise<SessionRecord> {
  const runtime = await resolveProjectRuntime(input.cwd); const found = await readSession(runtime.stateRoot, input.sessionId); const session = found.session; const path = activeAssignmentPath(runtime.stateRoot, input.taskId); if (!(await pathExists(path))) throw new Error('Active assignment not found'); const assignment = await readJson<AssignmentRecord>(path); validateAssignment(assignment);
  if (assignment.session_id !== session.session_id || !['completed', 'blocked', 'relinquished'].includes(assignment.status)) throw new Error('Only completed, blocked, or relinquished assignments may be released');
  await completeAssignment(runtime.stateRoot, session, assignment, assignment.status as 'completed' | 'blocked' | 'relinquished'); return session;
}

export async function retireSession(input: { sessionId: string; reason: SessionRetireReason; force?: boolean; cwd?: string }): Promise<Record<string, unknown>> {
  if (!RETIRE_REASONS.includes(input.reason)) throw new Error(`Invalid session retirement reason: ${input.reason}`);
  const runtime = await resolveProjectRuntime(input.cwd); const found = await readSession(runtime.stateRoot, input.sessionId); const session = found.session;
  if (session.status === 'retired') return { action: 'close', session_id: session.session_id, ...(session.provider_agent_id ? { provider_agent_id: session.provider_agent_id } : {}), already_retired: true };
  if (session.status === 'busy' && !input.force) throw new Error('Busy sessions require --force for administrator retirement');
  if (session.status === 'busy' && session.assigned_task) { const task = await getTask(session.assigned_task, runtime.repoRoot); if (['in_progress', 'dispatched'].includes(task.task.state)) await import('./task.js').then(({ transitionTask }) => transitionTask(task.task.task_id, 'blocked', runtime.repoRoot, { reason: 'forced-session-retirement' })); const assignmentPath = activeAssignmentPath(runtime.stateRoot, session.assigned_task); if (await pathExists(assignmentPath)) { const assignment = await readJson<AssignmentRecord>(assignmentPath); assignment.status = 'stale'; assignment.failure_code = 'session-retired'; assignment.updated_at = new Date().toISOString(); await writeJson(assignmentPath, assignment); } }
  if (session.status === 'retiring') return retireInternal(runtime.stateRoot, session, input.reason);
  if (session.status === 'failed') return { action: 'close', session_id: session.session_id, ...(session.provider_agent_id ? { provider_agent_id: session.provider_agent_id } : {}) };
  return retireInternal(runtime.stateRoot, session, input.reason);
}

export async function getSession(sessionId: string, cwd?: string): Promise<SessionRecord> { const runtime = await resolveProjectRuntime(cwd); return (await readSession(runtime.stateRoot, sessionId)).session; }

export async function markSessionRejected(sessionId: string, cwd?: string): Promise<SessionRecord | null> {
  const runtime = await resolveProjectRuntime(cwd); const found = await readSession(runtime.stateRoot, sessionId); const session = found.session; session.rejected_tasks += 1; session.updated_at = new Date().toISOString();
  if (session.status === 'idle' && session.role === 'implementation_worker') {
    const policy = await readPolicy(runtime.stateRoot);
    if (policy.retire_after_implementation_rejection) { await retireInternal(runtime.stateRoot, session, 'implementation_rejected'); return session; }
  }
  if (session.status !== 'retired') await writeJson(activeSessionPath(runtime.stateRoot, session.session_id), session);
  await appendSessionEvent(runtime.stateRoot, { project_id: runtime.projectId, session_id: session.session_id, type: 'implementation_rejected', details: { rejected_tasks: session.rejected_tasks } });
  return session;
}

export async function retireTaskAssignment(taskId: string, cwd?: string): Promise<void> {
  const runtime = await resolveProjectRuntime(cwd); const path = activeAssignmentPath(runtime.stateRoot, taskId); if (!(await pathExists(path))) return;
  const assignment = await readJson<AssignmentRecord>(path); validateAssignment(assignment); assignment.status = 'stale'; assignment.failure_code = 'retry-authorized'; assignment.updated_at = new Date().toISOString(); await archiveAssignment(runtime.stateRoot, assignment);
  const sessionFound = await readSession(runtime.stateRoot, assignment.session_id).catch(() => null); if (!sessionFound || sessionFound.session.status === 'retired') return;
  const session = sessionFound.session; if (session.current_assignment_id === assignment.assignment_id) { session.current_assignment_id = undefined; session.assigned_task = undefined; session.assigned_revision = undefined; session.acknowledged_revision = undefined; }
  if (session.status === 'busy' || session.status === 'reserved' || session.status === 'pending_spawn') await transitionSession(runtime.stateRoot, session, 'stale', { reason: 'retry-authorized' });
  if (session.role === 'implementation_worker' || session.role === 'implementation_escalation_worker') { await retireInternal(runtime.stateRoot, session, 'implementation_rejected'); return; }
  await persistSession(runtime.stateRoot, session);
}

export async function listSessions(cwd?: string, options: { retired?: boolean; role?: RoleId } = {}): Promise<SessionRecord[]> {
  if (options.role && !ROLE_IDS.includes(options.role)) throw new Error(`Invalid session role: ${options.role}`);
  const runtime = await resolveProjectRuntime(cwd); const dir = resolve(runtime.stateRoot, options.retired ? 'sessions/retired' : 'sessions/active'); if (!(await pathExists(dir))) return []; const out: SessionRecord[] = [];
  for (const name of (await readdir(dir)).filter((item) => item.endsWith('.json')).sort()) { const value = await readJson<SessionRecord>(resolve(dir, name)); validateSession(value); if (!options.role || value.role === options.role) out.push(value); }
  return out;
}

export async function sessionStatus(cwd?: string): Promise<Record<string, unknown>> {
  const sessions = await listSessions(cwd); const counts: Record<string, number> = {}; for (const session of sessions) counts[session.status] = (counts[session.status] ?? 0) + 1;
  return { sessions: counts, active_sessions: sessions.length, idle: counts.idle ?? 0, busy: counts.busy ?? 0, stale: counts.stale ?? 0 };
}

export async function sessionStats(cwd?: string): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd); const path = resolve(runtime.stateRoot, 'sessions/events.jsonl'); const events = (await pathExists(path) ? (await readFile(path, 'utf8')) : '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as SessionEventRecord);
  const count = (type: string) => events.filter((event) => event.type === type).length;
  const completed = events.filter((event) => event.type === 'session_released' && event.details?.assignment_status === 'completed').length;
  const blocked = events.filter((event) => event.type === 'session_released' && event.details?.assignment_status === 'blocked').length;
  const relinquished = events.filter((event) => event.type === 'session_released' && event.details?.assignment_status === 'relinquished').length;
  const roleBreakdown: Record<string, number> = {}; for (const event of events.filter((item) => item.type === 'session_created')) { const role = String(event.details?.role ?? 'unknown'); roleBreakdown[role] = (roleBreakdown[role] ?? 0) + 1; }
  const messages = events.filter((event) => event.type === 'dispatch_message_generated'); const chars = messages.reduce((sum, event) => sum + Number(event.details?.characters ?? 0), 0);
  const active = await listSessions(cwd); const all = [...active, ...(await listSessions(cwd, { retired: true }))]; const maximum = Math.max(0, ...all.map((item) => item.tasks_completed));
  return { project_id: runtime.projectId, sessions_created: count('session_created'), sessions_spawned: events.filter((item) => item.type === 'transport_confirmed' && item.details?.action === 'spawn').length, sessions_reused: count('session_reused'), sessions_resumed: count('session_resumed'), sessions_retired: count('session_retired'), sessions_stale: count('session_stale'), resume_failures: events.filter((item) => item.type === 'transport_failed' && item.details?.action === 'resume').length, send_input_failures: events.filter((item) => item.type === 'transport_failed' && item.details?.action === 'send_input').length, tasks_completed: completed, tasks_blocked: blocked, tasks_relinquished: relinquished, tasks_per_session_average: all.length ? all.reduce((sum, item) => sum + item.tasks_completed, 0) / all.length : 0, maximum_tasks_in_one_session: maximum, dispatch_messages_generated: messages.length, dispatch_message_characters_total: chars, dispatch_message_characters_average: messages.length ? chars / messages.length : 0, retirement_reasons: Object.fromEntries(all.filter((item) => item.retire_reason).map((item) => [item.retire_reason!, (all.filter((other) => other.retire_reason === item.retire_reason).length)])), role_breakdown: roleBreakdown };
}

export async function reconcileSessions(cwd?: string, apply = false): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd); const sessions = await listSessions(cwd); const assignments = await readActiveAssignments(runtime.stateRoot); const checks: Array<{ code: string; ok: boolean; detail: string }> = []; const repairs: string[] = [];
  const bySession = new Map<string, AssignmentRecord[]>(); for (const assignment of assignments) bySession.set(assignment.session_id, [...(bySession.get(assignment.session_id) ?? []), assignment]);
  for (const session of sessions) {
    const owned = bySession.get(session.session_id) ?? [];
    checks.push({ code: 'session_assignment_consistency', ok: session.status === 'busy' ? owned.length === 1 : owned.length <= 1, detail: `${session.session_id}: ${owned.length} active assignments` });
    if (session.status === 'idle' && !session.provider_agent_id) checks.push({ code: 'idle_provider_id', ok: false, detail: `${session.session_id} is idle without provider agent ID` });
  }
  for (const assignment of assignments) {
    const session = sessions.find((item) => item.session_id === assignment.session_id); const task = await getTask(assignment.task_id, runtime.repoRoot).catch(() => null);
    const ok = Boolean(session && task && session.project_id === runtime.projectId && session.assigned_task === assignment.task_id && revisionOf(task!.task) === assignment.task_revision);
    checks.push({ code: 'assignment_consistency', ok, detail: `${assignment.assignment_id}: ${ok ? 'valid' : 'inconsistent'}` });
    if (!ok && apply) { if (task && ['dispatched', 'in_progress'].includes(task.task.state)) await import('./task.js').then(({ transitionTask }) => transitionTask(assignment.task_id, 'blocked', runtime.repoRoot, { reason: 'reconcile-inconsistent-assignment' })); repairs.push(`blocked ${assignment.task_id}`); }
  }
  return { project_id: runtime.projectId, ok: checks.every((check) => check.ok), checks, repairs, applied: apply };
}

export async function workAssignment(taskId: string, sessionId: string, cwd?: string): Promise<{ runtime: Awaited<ReturnType<typeof resolveProjectRuntime>>; task: TaskRecord; session: SessionRecord; assignment: AssignmentRecord }> {
  const runtime = await resolveProjectRuntime(cwd); const found = await getTask(taskId, runtime.repoRoot); const session = (await readSession(runtime.stateRoot, sessionId)).session; const path = activeAssignmentPath(runtime.stateRoot, taskId); if (!(await pathExists(path))) throw new Error(`Active assignment not found for task ${taskId}`); const assignment = await readJson<AssignmentRecord>(path); validateAssignment(assignment);
  if (assignment.task_id !== taskId || assignment.session_id !== sessionId || session.current_assignment_id !== assignment.assignment_id || session.assigned_task !== taskId) throw new Error('Session does not own the task assignment');
  if (assignment.project_id !== runtime.projectId || session.project_id !== runtime.projectId) throw new Error('Project assignment mismatch');
  if (assignment.role !== session.role || !runtime.project.enabled_roles.includes(session.role)) throw new Error('Assignment role is not authorized');
  if (revisionOf(found.task) !== assignment.task_revision) throw new Error('Assignment revision is stale');
  const current = await routeAndContext(runtime.stateRoot, taskId); if (assignment.route_sha256 !== current.routeHash || assignment.context_sha256 !== current.contextHash) throw new Error('Assignment route or context hash is stale');
  return { runtime, task: found.task, session, assignment };
}

export { validateSession, validateAssignment, revisionOf, loadAmendments, materializeEffectiveTaskContract, completeAssignment, appendSessionEvent, transitionSession, retireInternal, readSession, readActiveAssignments, activeAssignmentPath };
