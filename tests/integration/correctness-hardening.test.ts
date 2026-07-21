import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createTask, activateTask, routeAndPersist, dispatchTask, getTask } from '../../src/task.js';
import { buildContext } from '../../src/context.js';
import { acquireSession, confirmSession, releaseSession } from '../../src/session.js';
import type { LocalSessionAcquireResult, SessionAcquireResult } from '../../src/session.js';
import { workComplete, workOpen, workSync } from '../../src/work.js';
import { createTaskAmendment } from '../../src/amendment.js';
import { refreshTask } from '../../src/refresh.js';
import { importPlan } from '../../src/plan.js';
import { initializedRepo, stateRootFor, writeProjectFile } from '../helpers.js';
import { pathExists, readJson, writeJson } from '../../src/lib/fs.js';
import { recoverStateTransactions, withStateTransaction } from '../../src/lib/state-transaction.js';
import { sha256 } from '../../src/lib/hash.js';
import { confirmProviderAction, failProviderAction, listProviderActions, retryProviderAction } from '../../src/provider-actions.js';

function local(result: SessionAcquireResult): LocalSessionAcquireResult { if (!('session_id' in result)) throw new Error(`Expected local session, received ${result.action}`); return result; }

async function prepare(root: string, taskId: string, planRef?: string): Promise<void> {
  await createTask({ cwd: root, id: taskId, title: taskId, objective: `Implement ${taskId}`, kind: 'implementation', planRef, allowedPaths: ['README.md'] });
  await activateTask(taskId, root); await routeAndPersist(taskId, root); await buildContext(taskId, root); await dispatchTask(taskId, root);
}

async function handoffEnvelope(root: string, taskId: string, sessionId: string, assignmentId: string): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'agent-router-hardening-result-')); const path = resolve(dir, 'result.json');
  await writeJson(path, { schema_version: 1, task_id: taskId, task_revision: 1, session_id: sessionId, assignment_id: assignmentId, role: 'implementation_worker', result_kind: 'implementation_handoff', payload: { schema_version: 1, task_id: taskId, status: 'worker_complete', agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' }, files_read: ['README.md'], files_changed: [], tests: [{ command: 'node --test', exit_code: 0, passed: 1, failed: 0 }], manual_checks: [], budget: { files_read: 1, context_bytes: 0, tool_output_chars: 0, repository_wide_scan_used: false, full_test_suite_used: false }, known_risks: [], unresolved_questions: [], recommended_next_action: 'review' } });
  void root; return path;
}

test('review phases allocate local reviewers in order with separate derived context', async () => {
  const root = await initializedRepo('secure-development-local-brain');
  await writeProjectFile(root, 'plan.md', '# bounded plan\n');
  await importPlan({ cwd: root, id: 'PLAN-001', file: resolve(root, 'plan.md'), author: 'local-sol' });
  await prepare(root, 'PHASE-001', 'PLAN-001');
  const primary = local(await acquireSession('PHASE-001', root)); assert.equal(primary.action, 'spawn');
  await confirmSession({ sessionId: primary.session_id, action: 'spawn', providerAgentId: 'provider-primary', cwd: root }); await workOpen('PHASE-001', primary.session_id, root);
  await workComplete('PHASE-001', primary.session_id, await handoffEnvelope(root, 'PHASE-001', primary.session_id, primary.assignment_id), root);
  const verifier = local(await acquireSession('PHASE-001', root)); assert.equal(verifier.action, 'spawn'); assert.equal(verifier.phase, 'review'); assert.equal(verifier.role, 'verifier');
  const stateRoot = await stateRootFor(root);
  assert.equal(await pathExists(resolve(stateRoot, 'generated/phases/PHASE-001/review-verifier.route.json')), true);
  assert.equal(await pathExists(resolve(stateRoot, 'contexts/phases/PHASE-001/review-verifier.json')), true);
  await confirmSession({ sessionId: verifier.session_id, action: 'spawn', providerAgentId: 'provider-verifier', cwd: root });
  const opened = await workOpen('PHASE-001', verifier.session_id, root); assert.equal(opened.phase, 'review');
  const phaseContext = await readJson<{ files: Array<{ path: string }> }>(resolve(stateRoot, 'contexts/phases/PHASE-001/review-verifier.json'));
  assert.ok(phaseContext.files.some((file) => file.path === '__agent_router__/prior-reviews.json'));
  const second = await acquireSession('PHASE-001', root).catch((error) => error as Error);
  assert.match((second as Error).message, /already has an active assignment/);
});

test('external review is a handoff boundary and never creates a local session', async () => {
  const root = await initializedRepo('development'); await prepare(root, 'EXTERNAL-001');
  const primary = local(await acquireSession('EXTERNAL-001', root)); await confirmSession({ sessionId: primary.session_id, action: 'spawn', providerAgentId: 'provider-primary', cwd: root }); await workOpen('EXTERNAL-001', primary.session_id, root);
  await workComplete('EXTERNAL-001', primary.session_id, await handoffEnvelope(root, 'EXTERNAL-001', primary.session_id, primary.assignment_id), root);
  const result = await acquireSession('EXTERNAL-001', root); assert.equal(result.action, 'external_review_required'); assert.equal(result.role, 'external_reviewer'); assert.equal('session_id' in result, false);
});

test('late transport confirmation preserves completed work and is idempotent', async () => {
  const root = await initializedRepo('development'); await prepare(root, 'RACE-001');
  const acquired = local(await acquireSession('RACE-001', root)); await workOpen('RACE-001', acquired.session_id, root);
  await workComplete('RACE-001', acquired.session_id, await handoffEnvelope(root, 'RACE-001', acquired.session_id, acquired.assignment_id), root);
  const confirmed = await confirmSession({ sessionId: acquired.session_id, action: 'spawn', providerAgentId: 'provider-late', cwd: root });
  assert.equal(confirmed.status, 'retired'); assert.equal(confirmed.provider_agent_id, 'provider-late');
  const repeated = await confirmSession({ sessionId: acquired.session_id, action: 'spawn', providerAgentId: 'provider-late', cwd: root });
  assert.equal(repeated.status, 'retired'); assert.equal(repeated.provider_agent_id, 'provider-late');
  const pending = await listProviderActions(root, true); assert.equal(pending.length, 1);
  await failProviderAction(pending[0]!.action_id, 'provider close was unavailable', root); await retryProviderAction(pending[0]!.action_id, root); await confirmProviderAction(pending[0]!.action_id, root);
  assert.equal((await listProviderActions(root, true)).length, 0); assert.equal((await listProviderActions(root)).some((action) => action.status === 'confirmed'), true);
  const released = await releaseSession({ sessionId: acquired.session_id, taskId: 'RACE-001', cwd: root }); assert.equal(released.already_released, true);
});

test('amendment refresh marks the active assignment for revision-bound sync', async () => {
  const root = await initializedRepo('development'); await prepare(root, 'REFRESH-001');
  const acquired = local(await acquireSession('REFRESH-001', root)); await confirmSession({ sessionId: acquired.session_id, action: 'spawn', providerAgentId: 'provider-refresh', cwd: root }); await workOpen('REFRESH-001', acquired.session_id, root);
  await createTaskAmendment({ taskId: 'REFRESH-001', cwd: root, amendmentKind: 'acceptance_change', source: 'owner', changes: { acceptance_add: ['README remains readable'] } });
  const refreshed = await refreshTask('REFRESH-001', root); assert.equal(refreshed.action, 'sync'); assert.equal((await getTask('REFRESH-001', root)).task.derived_state_status, 'current');
  const synced = await workSync('REFRESH-001', acquired.session_id, root); assert.equal(synced.current_revision, 2);
});

test('state transaction recovery rolls back prepared writes and completes unambiguous commits', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-router-transaction-')); const stateRoot = resolve(root, 'state'); const target = resolve(root, 'record.json'); await writeFile(target, 'before\n');
  await assert.rejects(() => withStateTransaction({ stateRoot, projectId: 'project-transaction', operation: 'fault-prepared', plan: [{ kind: 'write', target, data: 'after\n' }], faultAfter: 'staged' }), /Injected transaction fault after staged/);
  assert.equal(await readFile(target, 'utf8'), 'before\n'); const recovered = await recoverStateTransactions(stateRoot, true); assert.equal((recovered.repairs as string[]).length, 1); assert.equal(await readFile(target, 'utf8'), 'before\n');
  await assert.rejects(() => withStateTransaction({ stateRoot, projectId: 'project-transaction', operation: 'fault-rename', plan: [{ kind: 'write', target, data: 'after\n' }], faultAfter: 'rename' }), /Injected transaction fault after rename/);
  const journal = (await import('../../src/lib/state-transaction.js')).listStateTransactions; const pending = await journal(stateRoot, true); assert.equal(pending.length, 1);
  await recoverStateTransactions(stateRoot, true); assert.equal(await readFile(target, 'utf8'), 'after\n'); assert.equal(sha256('after\n').length, 64);
});
