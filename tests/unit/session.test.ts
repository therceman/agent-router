import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDispatchMessage, compatibilityKey } from '../../src/session.js';

test('dispatch messages are exact command-only transport', () => {
  const message = buildDispatchMessage({ operation: 'open', taskId: 'TASK-045', sessionId: 'SES-01ABC' });
  assert.equal(message, 'Execute:\nagent-router work open TASK-045 --session SES-01ABC');
  assert.doesNotMatch(message, /objective|acceptance|README|\.agent-router|test/);
  assert.throws(() => buildDispatchMessage({ operation: 'open', taskId: '../escape', sessionId: 'SES-01ABC' }), /Invalid task ID/);
  assert.throws(() => buildDispatchMessage({ operation: 'open', taskId: 'TASK-045', sessionId: 'not-a-session' }), /Invalid session ID/);
});

test('compatibility keys are deterministic and include every reuse boundary', () => {
  const input = { project_id: 'project-001', role: 'implementation_worker' as const, provider: 'codex' as const, provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' as const, repository_root: '/tmp/project', sandbox_mode: 'workspace-write' as const, approval_policy: 'on-request' };
  assert.equal(compatibilityKey(input), compatibilityKey({ ...input }));
  for (const patch of [
    { project_id: 'project-002' }, { role: 'verifier' as const }, { provider_model: 'gpt-5.6-terra' }, { reasoning: 'high' as const },
    { repository_root: '/tmp/other' }, { sandbox_mode: 'read-only' as const }, { approval_policy: 'never' },
  ]) assert.notEqual(compatibilityKey({ ...input, ...patch }), compatibilityKey(input));
});
