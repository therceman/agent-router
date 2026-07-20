import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHandoffRecord } from '../../src/handoff.js';
import type { HandoffRecord } from '../../src/models.js';

function handoff(): HandoffRecord {
  return {
    schema_version: 1, task_id: 'DEV-001', status: 'worker_complete',
    agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' },
    files_read: ['src/a.ts'], files_changed: ['src/a.ts'],
    tests: [{ command: 'npm test', exit_code: 0, passed: 1, failed: 0 }],
    manual_checks: [{ description: 'check', result: 'passed' }],
    budget: { files_read: 1, context_bytes: 100, tool_output_chars: 50, repository_wide_scan_used: false, full_test_suite_used: false },
    known_risks: [], unresolved_questions: [], recommended_next_action: 'independent_verification',
  };
}

test('accepts valid handoff', () => assert.doesNotThrow(() => validateHandoffRecord(handoff(), 'DEV-001', ['src/a.ts'])));
test('rejects main as worker', () => { const h = handoff(); h.agent.role = 'main'; assert.throws(() => validateHandoffRecord(h, 'DEV-001'), /Main session/); });
test('rejects failing tests', () => { const h = handoff(); h.tests[0]!.exit_code = 1; assert.throws(() => validateHandoffRecord(h, 'DEV-001'), /failing tests/); });
test('rejects out-of-scope changes', () => { const h = handoff(); h.files_changed = ['src/b.ts']; assert.throws(() => validateHandoffRecord(h, 'DEV-001', ['src/a.ts']), /outside task scope/); });
test('rejects repository-wide scan', () => { const h = handoff(); h.budget.repository_wide_scan_used = true; assert.throws(() => validateHandoffRecord(h, 'DEV-001'), /restricted execution/); });

test('rejects handoff whose task identity differs', () => {
  const h = handoff();
  h.task_id = 'OTHER-001';
  assert.throws(() => validateHandoffRecord(h, 'DEV-001'), /identity or status/);
});
