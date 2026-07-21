import test from 'node:test';
import assert from 'node:assert/strict';
import type { TaskRecord } from '../../src/models.js';
import { canonicalSha256 } from '../../src/lib/hash.js';
import { applyAmendment, materializeEffectiveTaskContract, taskContract } from '../../src/amendment.js';

const task: TaskRecord = {
  schema_version: 1, task_id: 'TASK-001', title: 'Task', profile: 'development', state: 'ready', objective: 'Do task',
  task_profile: { task_kind: 'implementation', ambiguity: 1, semantic_complexity: 1, security_criticality: 0, blast_radius: 1, novelty: 1, verification_strength: 2, context_scope: 1, destructive_potential: 0, historical_data_impact: 0 },
  scope: { allowed_paths: ['src/a.ts'], forbidden_paths: ['.git'] }, budgets: { maximum_files_read: 3, maximum_context_bytes: 1000, maximum_single_file_bytes: 500, maximum_tool_output_chars: 1000, repository_wide_scan: false, full_test_suite: false, recursive_delegation: false },
  acceptance: ['Pass tests'], tests: { targeted: ['npm test'], checkpoint: [] }, manual_verification: [], outputs: ['handoff'], review: { required: false, required_roles: [], sequence: [] }, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

test('effective task contracts apply immutable amendments in order and preserve hash chain', () => {
  const first = taskContract(task); const previous = canonicalSha256(first);
  const draft = { schema_version: 1 as const, amendment_id: 'AMD-draft', task_id: task.task_id, from_revision: 1, to_revision: 2, amendment_kind: 'scope_change' as const, source: 'owner' as const, changes: { allowed_paths_add: ['src/b.ts'] }, previous_contract_sha256: previous, resulting_contract_sha256: '', created_at: new Date().toISOString() };
  const next = applyAmendment(first, draft); draft.resulting_contract_sha256 = canonicalSha256(next);
  const revised = { ...task, schema_version: 2 as const, revision: 2, previous_revision: 1, effective_contract_sha256: draft.resulting_contract_sha256 };
  assert.deepEqual(materializeEffectiveTaskContract(revised, [draft]).scope.allowed_paths, ['src/a.ts', 'src/b.ts']);
  assert.throws(() => materializeEffectiveTaskContract(revised, [{ ...draft, previous_contract_sha256: '0'.repeat(64) }]), /hash-chain/);
});
