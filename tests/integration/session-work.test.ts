import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { activateTask, createTask, dispatchTask, routeAndPersist } from '../../src/task.js';
import { buildContext } from '../../src/context.js';
import { acquireSession, confirmSession, transportFailed } from '../../src/session.js';
import { workComplete, workOpen } from '../../src/work.js';
import { writeJson } from '../../src/lib/fs.js';
import { initializedRepo } from '../helpers.js';

async function prepare(root: string, taskId: string): Promise<void> {
  await createTask({ cwd: root, id: taskId, title: taskId, objective: `Implement ${taskId}`, kind: 'implementation', allowedPaths: ['README.md'] });
  await activateTask(taskId, root); await routeAndPersist(taskId, root); await buildContext(taskId, root); await dispatchTask(taskId, root);
}

test('persistent sessions spawn once, complete idle, and reuse through command-only dispatch', async () => {
  const root = await initializedRepo(); await prepare(root, 'SESSION-001');
  const first = await acquireSession('SESSION-001', root); assert.equal(first.action, 'spawn'); assert.match(first.dispatch_message, /^Execute:\nagent-router work open SESSION-001 --session SES-/);
  await confirmSession({ sessionId: first.session_id, action: 'spawn', providerAgentId: 'provider-thread-1', cwd: root }); await workOpen('SESSION-001', first.session_id, root);
  const resultDir = await mkdtemp(resolve(tmpdir(), 'agent-router-result-')); const resultPath = resolve(resultDir, 'result.json');
  await writeJson(resultPath, { schema_version: 1, task_id: 'SESSION-001', task_revision: 1, session_id: first.session_id, assignment_id: first.assignment_id, role: 'implementation_worker', result_kind: 'implementation_handoff', payload: { schema_version: 1, task_id: 'SESSION-001', status: 'worker_complete', agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' }, files_read: ['README.md'], files_changed: [], tests: [{ command: 'node --test', exit_code: 0, passed: 1, failed: 0 }], manual_checks: [], budget: { files_read: 1, context_bytes: 0, tool_output_chars: 0, repository_wide_scan_used: false, full_test_suite_used: false }, known_risks: [], unresolved_questions: [], recommended_next_action: 'external_review' } });
  const completed = await workComplete('SESSION-001', first.session_id, resultPath, root); assert.equal((completed.session as { status: string }).status, 'idle');

  await prepare(root, 'SESSION-002'); const second = await acquireSession('SESSION-002', root); assert.equal(second.action, 'send_input'); assert.equal(second.session_id, first.session_id); assert.equal(second.provider_agent_id, 'provider-thread-1');
  await transportFailed({ sessionId: second.session_id, action: 'send-input', reason: 'agent-unavailable', cwd: root });
  const resumed = await acquireSession('SESSION-002', root); assert.equal(resumed.action, 'resume'); assert.equal(resumed.session_id, first.session_id);
  await transportFailed({ sessionId: resumed.session_id, action: 'resume', reason: 'resume-unavailable', cwd: root });
  const replacement = await acquireSession('SESSION-002', root); assert.equal(replacement.action, 'spawn'); assert.notEqual(replacement.session_id, first.session_id);
});
