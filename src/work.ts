import { resolve } from 'node:path';
import type { HandoffRecord, ReviewRecord, SessionRecord, TaskRecord, WorkResultEnvelope } from './models.js';
import { ROLE_IDS, type RoleId } from './config.js';
import { getTask, transitionTask } from './task.js';
import { validateHandoffRecord } from './handoff.js';
import { validateReviewRecord } from './review.js';
import { pathExists, readJson, writeJson } from './lib/fs.js';
import { canonicalSha256 } from './lib/hash.js';
import { loadAmendments, materializeEffectiveTaskContract } from './amendment.js';
import { activeAssignmentPath, appendSessionEvent, completeAssignment, getSession, revisionOf, transitionSession, validateAssignment, validateSession, workAssignment, readSession } from './session.js';
import { resolveProjectRuntime } from './state.js';

const RESULT_KIND: Record<Exclude<RoleId, 'main'>, WorkResultEnvelope['result_kind']> = {
  implementation_worker: 'implementation_handoff', implementation_escalation_worker: 'implementation_handoff',
  verifier: 'verification_review', security_reviewer: 'security_review', critical_reviewer: 'critical_review',
  architect: 'architecture_decision', scout: 'scout_discovery', repo_janitor: 'repository_hygiene_report', security_researcher: 'security_research_result',
};

function roleOf(value: string): RoleId { if (!ROLE_IDS.includes(value as RoleId) || value === 'main') throw new Error(`Invalid worker role: ${value}`); return value as RoleId; }

async function effective(task: TaskRecord, stateRoot: string) {
  const amendments = await loadAmendments(stateRoot, task.task_id);
  return { contract: materializeEffectiveTaskContract(task, amendments), amendments };
}

function publicTask(task: TaskRecord, contract: Awaited<ReturnType<typeof effective>>['contract'], context: Awaited<ReturnType<typeof import('./context.js').readContext>>): Record<string, unknown> {
  return {
    task_id: task.task_id, revision: task.revision ?? 1, title: contract.title, profile: contract.profile, role: undefined,
    objective: contract.objective, plan_ref: contract.plan_ref ?? null, allowed_paths: contract.scope.allowed_paths, forbidden_paths: contract.scope.forbidden_paths,
    acceptance: contract.acceptance, targeted_tests: contract.tests.targeted, checkpoint_tests: contract.tests.checkpoint, manual_verification: contract.manual_verification,
    outputs: contract.outputs, review: contract.review, bounded_context: context.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256, excerpt: file.excerpt })),
    review_feedback: contract.review_feedback, required_changes: contract.required_changes, notes: contract.notes,
    output_contract: 'Return a schema-valid WorkResultEnvelope to agent-router work complete; do not write Agent Router state directly.',
  };
}

async function assignedForWorker(taskId: string, sessionId: string, cwd?: string): Promise<Awaited<ReturnType<typeof workAssignment>>> {
  const found = await workAssignment(taskId, sessionId, cwd);
  if (found.assignment.status !== 'acknowledged') throw new Error(`Assignment is not acknowledged: ${found.assignment.status}`);
  return found;
}

export async function workOpen(taskId: string, sessionId: string, cwd?: string): Promise<Record<string, unknown>> {
  const found = await workAssignment(taskId, sessionId, cwd);
  if (!['pending_spawn', 'reserved'].includes(found.session.status)) throw new Error(`Session must be reserved or pending_spawn; current state is ${found.session.status}`);
  if (found.task.state !== 'dispatched') throw new Error(`Task must be dispatched before work open; current state is ${found.task.state}`);
  if (!['pending_transport', 'transport_confirmed'].includes(found.assignment.status)) throw new Error(`Assignment cannot be acknowledged from ${found.assignment.status}`);
  const { contract } = await effective(found.task, found.runtime.stateRoot);
  const context = await readJson<Awaited<ReturnType<typeof import('./context.js').readContext>>>(resolve(found.runtime.stateRoot, 'contexts', `${taskId}.json`));
  const now = new Date().toISOString();
  found.assignment.status = 'acknowledged'; found.assignment.acknowledged_at = now; found.assignment.updated_at = now;
  found.session.acknowledged_revision = found.assignment.task_revision; found.session.updated_at = now; found.session.last_used_at = now;
  validateAssignment(found.assignment); await writeJson(activeAssignmentPath(found.runtime.stateRoot, taskId), found.assignment);
  await transitionSession(found.runtime.stateRoot, found.session, 'busy', { task_id: taskId, assignment_id: found.assignment.assignment_id });
  await transitionTask(taskId, 'in_progress', found.runtime.repoRoot, { session_id: sessionId, assignment_id: found.assignment.assignment_id, revision: found.assignment.task_revision });
  await appendSessionEvent(found.runtime.stateRoot, { project_id: found.runtime.projectId, session_id: sessionId, task_id: taskId, assignment_id: found.assignment.assignment_id, type: 'work_acknowledged', from_status: 'reserved', to_status: 'busy', details: { revision: found.assignment.task_revision } });
  return { task: publicTask(found.task, contract, context), task_id: taskId, revision: found.assignment.task_revision, role: found.session.role, session_id: sessionId, assignment_id: found.assignment.assignment_id, exact_completion_command: `agent-router work complete ${taskId} --session ${sessionId} --file RESULT.json` };
}

export async function workSync(taskId: string, sessionId: string, cwd?: string): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd); const taskFound = await getTask(taskId, runtime.repoRoot); const session = (await readSession(runtime.stateRoot, sessionId)).session; const assignmentPath = activeAssignmentPath(runtime.stateRoot, taskId); if (!(await pathExists(assignmentPath))) throw new Error('Active assignment not found'); const assignment = await readJson<import('./models.js').AssignmentRecord>(assignmentPath); validateAssignment(assignment);
  if (assignment.session_id !== sessionId || session.current_assignment_id !== assignment.assignment_id || session.status !== 'busy') throw new Error('Session does not own an active busy assignment');
  if (taskFound.task.state !== 'in_progress') throw new Error(`Task is not in progress; current state is ${taskFound.task.state}`);
  const currentRevision = revisionOf(taskFound.task); const acknowledged = session.acknowledged_revision ?? assignment.task_revision;
  if (currentRevision <= acknowledged) throw new Error('No newer task revision is available for sync');
  const amendments = await loadAmendments(runtime.stateRoot, taskId); const delta = amendments.filter((item) => item.to_revision > acknowledged && item.to_revision <= currentRevision); if (delta.length !== currentRevision - acknowledged) throw new Error('Amendment chain is incomplete');
  const contract = materializeEffectiveTaskContract(taskFound.task, amendments); const currentContext = await readJson<Record<string, unknown>>(resolve(runtime.stateRoot, 'contexts', `${taskId}.json`));
  const currentRoute = await readJson<Record<string, unknown>>(resolve(runtime.stateRoot, 'generated', `${taskId}.route.json`));
  session.acknowledged_revision = currentRevision; session.assigned_revision = currentRevision; session.updated_at = new Date().toISOString(); assignment.task_revision = currentRevision; assignment.route_sha256 = canonicalSha256(currentRoute); assignment.context_sha256 = canonicalSha256(currentContext); assignment.updated_at = session.updated_at;
  validateAssignment(assignment); await writeJson(assignmentPath, assignment); validateSession(session); await writeJson(resolve(runtime.stateRoot, 'sessions/active', `${sessionId}.json`), session);
  return { task_id: taskId, acknowledged_revision: acknowledged, current_revision: currentRevision, amendments: delta.map((item) => ({ revision: item.to_revision, amendment_kind: item.amendment_kind, source: item.source, changes: item.changes, source_review_role: item.source_review_role ?? null })), effective_contract_sha256: taskFound.task.effective_contract_sha256, contract_summary: { objective: contract.objective, allowed_paths: contract.scope.allowed_paths, forbidden_paths: contract.scope.forbidden_paths, acceptance: contract.acceptance, targeted_tests: contract.tests.targeted, checkpoint_tests: contract.tests.checkpoint, manual_verification: contract.manual_verification, review_feedback: contract.review_feedback, required_changes: contract.required_changes, notes: contract.notes } };
}

export async function workReopen(taskId: string, sessionId: string, cwd?: string): Promise<Record<string, unknown>> {
  const found = await workAssignment(taskId, sessionId, cwd); const amendments = await loadAmendments(found.runtime.stateRoot, taskId); if (!amendments.some((item) => item.amendment_kind === 'retry')) throw new Error('Task has no retry amendment');
  if (!['pending_spawn', 'reserved'].includes(found.session.status) || found.task.state !== 'dispatched') throw new Error('Retry assignment is not ready to reopen');
  return workOpen(taskId, sessionId, cwd);
}

export async function workStatus(sessionId: string, cwd?: string): Promise<Record<string, unknown>> {
  const session = await getSession(sessionId, cwd); return { session_id: session.session_id, status: session.status, role: session.role, task_id: session.assigned_task ?? null, assigned_revision: session.assigned_revision ?? null, acknowledged_revision: session.acknowledged_revision ?? null, assignment_id: session.current_assignment_id ?? null };
}

function validateEnvelope(value: unknown, task: TaskRecord, session: SessionRecord, assignmentId: string): WorkResultEnvelope {
  if (!value || typeof value !== 'object') throw new Error('Work result must be a JSON object'); const envelope = value as WorkResultEnvelope;
  if (envelope.schema_version !== 1 || envelope.task_id !== task.task_id || envelope.task_revision !== revisionOf(task) || envelope.session_id !== session.session_id || envelope.assignment_id !== assignmentId || envelope.role !== session.role) throw new Error('Work result identity or revision mismatch');
  if (RESULT_KIND[session.role as Exclude<RoleId, 'main'>] !== envelope.result_kind) throw new Error(`Result kind ${envelope.result_kind} is invalid for role ${session.role}`);
  if (envelope.payload === undefined) throw new Error('Work result payload is required'); return envelope;
}

function resultRecord(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Work result payload must be an object'); return value as Record<string, unknown>; }

async function writeRoleResult(stateRoot: string, taskId: string, role: RoleId, payload: unknown): Promise<void> {
  await writeJson(resolve(stateRoot, 'generated', 'results', taskId, `${role}.json`), payload);
}

export async function recordWorkFailure(sessionId: string, cwd?: string): Promise<void> {
  const runtime = await resolveProjectRuntime(cwd); const found = await readSession(runtime.stateRoot, sessionId); const session = found.session; session.failed_tasks += 1; session.updated_at = new Date().toISOString(); validateSession(session); await writeJson(resolve(runtime.stateRoot, 'sessions/active', `${sessionId}.json`), session);
}

export async function workComplete(taskId: string, sessionId: string, resultFile: string, cwd?: string): Promise<Record<string, unknown>> {
  const found = await assignedForWorker(taskId, sessionId, cwd); if (found.session.status !== 'busy' || !['in_progress', 'worker_complete', 'review_pending'].includes(found.task.state)) throw new Error('Session must be busy with an active task');
  if ((found.session.acknowledged_revision ?? 0) !== revisionOf(found.task)) throw new Error('Task revision changed; run work sync before completion');
  try {
    const envelope = validateEnvelope(await readJson<WorkResultEnvelope>(resolve(resultFile)), found.task, found.session, found.assignment.assignment_id); const payload = envelope.payload;
    if (envelope.result_kind === 'implementation_handoff') {
      const handoff = payload as HandoffRecord; const { contract } = await effective(found.task, found.runtime.stateRoot); validateHandoffRecord(handoff, taskId, contract.scope.allowed_paths); if (handoff.task_revision !== undefined && handoff.task_revision !== revisionOf(found.task)) throw new Error('Handoff task revision mismatch');
      const canonicalHandoff: HandoffRecord = { ...handoff, session_id: sessionId, assignment_id: found.assignment.assignment_id, task_revision: revisionOf(found.task), effective_contract_sha256: found.task.effective_contract_sha256 };
      await writeJson(resolve(found.runtime.stateRoot, 'handoffs', `${taskId}.json`), canonicalHandoff); await transitionTask(taskId, 'worker_complete', found.runtime.repoRoot, { session_id: sessionId, assignment_id: found.assignment.assignment_id, revision: revisionOf(found.task) });
    } else if (envelope.result_kind === 'verification_review' || envelope.result_kind === 'security_review' || envelope.result_kind === 'critical_review') {
      const review = payload as ReviewRecord; validateReviewRecord(review, taskId); if (review.reviewer.role !== found.session.role) throw new Error('Review payload role does not match session role');
      const reviewIndex = found.task.review.sequence.indexOf(found.session.role);
      if (reviewIndex < 0) throw new Error(`Review role ${found.session.role} is not required for task ${taskId}`);
      for (const earlier of found.task.review.sequence.slice(0, reviewIndex)) {
        const earlierPath = resolve(found.runtime.stateRoot, 'reviews', taskId, `${earlier}.json`); if (!(await pathExists(earlierPath))) throw new Error(`Review sequence violation; complete first: ${earlier}`);
        const prior = await readJson<ReviewRecord>(earlierPath); if (!['accepted', 'accepted_with_followup'].includes(prior.verdict)) throw new Error(`Review sequence violation; complete first: ${earlier}`);
      }
      await writeJson(resolve(found.runtime.stateRoot, 'reviews', taskId, `${found.session.role}.json`), review);
      if (review.verdict === 'rejected') await transitionTask(taskId, 'rejected', found.runtime.repoRoot, { role: found.session.role, session_id: sessionId });
      else if (['blocked', 'architect_review_required', 'critical_review_required'].includes(review.verdict)) await transitionTask(taskId, 'blocked', found.runtime.repoRoot, { role: found.session.role, session_id: sessionId });
      else if (found.task.state === 'worker_complete') await transitionTask(taskId, 'review_pending', found.runtime.repoRoot, { role: found.session.role, session_id: sessionId });
      else if (found.task.state === 'in_progress') await transitionTask(taskId, 'worker_complete', found.runtime.repoRoot, { role: found.session.role, session_id: sessionId });
    } else {
      const result = resultRecord(payload); const required: Record<string, string[]> = { architecture_decision: ['decision', 'constraints', 'rejected_alternatives', 'task_decomposition', 'acceptance_criteria', 'unresolved_questions'], scout_discovery: ['relevant_files', 'symbols', 'tests', 'dependencies', 'risks', 'recommended_bounded_scope'], repository_hygiene_report: ['findings'], security_research_result: ['authorization_scope', 'attack_surface', 'reachability', 'attacker_control', 'root_cause', 'impact', 'evidence', 'safe_verification_boundaries', 'unresolved_questions'] }; for (const key of required[envelope.result_kind] ?? []) if (!(key in result)) throw new Error(`Work result payload is missing ${key}`); await writeRoleResult(found.runtime.stateRoot, taskId, found.session.role, { ...envelope, payload }); await transitionTask(taskId, 'worker_complete', found.runtime.repoRoot, { role: found.session.role, session_id: sessionId });
    }
    const completed = await completeAssignment(found.runtime.stateRoot, found.session, found.assignment, 'completed');
    return { task: (await getTask(taskId, found.runtime.repoRoot)).task, session: completed.session, assignment: completed.assignment };
  } catch (error) {
    await recordWorkFailure(sessionId, found.runtime.repoRoot); throw error;
  }
}

export async function workBlock(taskId: string, sessionId: string, reason: string, cwd?: string): Promise<Record<string, unknown>> {
  const found = await assignedForWorker(taskId, sessionId, cwd); if (found.session.status !== 'busy' || !['in_progress', 'dispatched'].includes(found.task.state)) throw new Error('Session must own an active task to block it');
  const allowed = ['scope-exceeded', 'missing-context', 'requirements-conflict', 'environment-blocked', 'test-infrastructure-blocked', 'security-boundary', 'authorization-required']; if (!allowed.includes(reason)) throw new Error(`Invalid block reason: ${reason}`);
  await writeJson(resolve(found.runtime.stateRoot, 'generated', 'results', taskId, 'blocked.json'), { schema_version: 1, task_id: taskId, session_id: sessionId, assignment_id: found.assignment.assignment_id, reason, created_at: new Date().toISOString() }); await transitionTask(taskId, 'blocked', found.runtime.repoRoot, { reason, session_id: sessionId }); const completed = await completeAssignment(found.runtime.stateRoot, found.session, found.assignment, 'blocked'); return { task: (await getTask(taskId, found.runtime.repoRoot)).task, session: completed.session, assignment: completed.assignment, reason };
}

export async function workRelinquish(taskId: string, sessionId: string, reason: string, cwd?: string): Promise<Record<string, unknown>> {
  const found = await assignedForWorker(taskId, sessionId, cwd); if (found.session.status !== 'busy' || !['in_progress', 'dispatched'].includes(found.task.state)) throw new Error('Session must own an active task to relinquish it'); if (!reason.trim()) throw new Error('Relinquish reason is required');
  await writeJson(resolve(found.runtime.stateRoot, 'generated', 'results', taskId, 'relinquished.json'), { schema_version: 1, task_id: taskId, session_id: sessionId, assignment_id: found.assignment.assignment_id, reason, created_at: new Date().toISOString() }); await transitionTask(taskId, 'blocked', found.runtime.repoRoot, { reason, relinquished: true, session_id: sessionId }); const completed = await completeAssignment(found.runtime.stateRoot, found.session, found.assignment, 'relinquished'); return { task: (await getTask(taskId, found.runtime.repoRoot)).task, session: completed.session, assignment: completed.assignment, reason };
}
