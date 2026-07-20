import test from 'node:test';
import assert from 'node:assert/strict';
import { routeTask } from '../../src/router.js';
import { defaultProfile } from '../../src/task.js';
import type { TaskRecord, TaskKind } from '../../src/models.js';
import type { ProfileId } from '../../src/config.js';

function task(kind: TaskKind, patch: Partial<TaskRecord['task_profile']> = {}, profile: ProfileId = 'development'): TaskRecord {
  const now = new Date().toISOString();
  return {
    schema_version: 1, task_id: 'DEV-001', title: 'Test', profile, state: 'ready', objective: 'Test task',
    execution: { implementation_tier: 'default', attempt: 1 },
    task_profile: { ...defaultProfile(kind), ...patch }, scope: { allowed_paths: ['x.ts'], forbidden_paths: [] },
    budgets: { maximum_files_read: 12, maximum_context_bytes: 150000, maximum_single_file_bytes: 50000, maximum_tool_output_chars: 16000, repository_wide_scan: false, full_test_suite: false, recursive_delegation: false },
    acceptance: [], tests: { targeted: [], checkpoint: [] }, manual_verification: [], outputs: [],
    review: { required: true, required_roles: ['external_reviewer'], sequence: ['external_reviewer'] }, created_at: now, updated_at: now,
  };
}

test('orchestration routes to Luna low main', () => {
  const r = routeTask(task('orchestration'));
  assert.equal(r.role, 'main'); assert.equal(r.provider_model, 'gpt-5.6-luna'); assert.equal(r.reasoning, 'low');
});

test('bounded testable implementation routes to Luna xhigh', () => {
  const r = routeTask(task('implementation', { semantic_complexity: 3, blast_radius: 2, context_scope: 2 }));
  assert.equal(r.role, 'implementation_worker');
  assert.equal(r.provider_model, 'gpt-5.6-luna');
  assert.equal(r.reasoning, 'xhigh');
});

test('rejected implementation retry routes to Terra high escalation', () => {
  const t = task('implementation');
  t.execution = { implementation_tier: 'escalated', attempt: 2, escalation_reason: 'implementation_rejected' };
  const r = routeTask(t);
  assert.equal(r.role, 'implementation_escalation_worker');
  assert.equal(r.provider_model, 'gpt-5.6-terra');
  assert.equal(r.reasoning, 'high');
});

test('security-sensitive development routes implementation directly to Terra high', () => {
  const r = routeTask(task('security_sensitive_development', {}, 'secure-development-external-brain'));
  assert.equal(r.role, 'implementation_escalation_worker');
  assert.equal(r.provider_model, 'gpt-5.6-terra');
  assert.equal(r.reasoning, 'high');
});

test('ordinary implementation verification uses Terra-high, not Sol', () => {
  const r = routeTask(task('verification', {}, 'secure-development-external-brain'));
  assert.equal(r.role, 'verifier'); assert.equal(r.provider_model, 'gpt-5.6-terra'); assert.equal(r.reasoning, 'high');
});

test('local planning brain routes architecture to Sol-high', () => {
  const r = routeTask(task('architecture', {}, 'secure-development-local-brain'));
  assert.equal(r.role, 'architect'); assert.equal(r.provider_model, 'gpt-5.6-sol'); assert.equal(r.reasoning, 'high');
});

test('authorized security research routes to Sol-high researcher', () => {
  const r = routeTask(task('security_research', {}, 'security-research'));
  assert.equal(r.role, 'security_researcher'); assert.equal(r.provider_model, 'gpt-5.6-sol');
});

test('critical destructive decisions route to Sol-xhigh review', () => {
  const r = routeTask(task('implementation', { destructive_potential: 3 }));
  assert.equal(r.role, 'critical_reviewer'); assert.equal(r.reasoning, 'xhigh');
});

test('broad task requires scout refinement and Terra escalation', () => {
  const r = routeTask(task('implementation', { context_scope: 3 }));
  assert.equal(r.scout_required, true); assert.ok(r.confidence < 0.9);
  assert.equal(r.role, 'implementation_escalation_worker');
});
