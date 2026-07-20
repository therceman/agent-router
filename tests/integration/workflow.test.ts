import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeProjectFile, initializedRepo, stateRootFor } from '../helpers.js';
import { createTask, activateTask, routeAndPersist, dispatchTask, getTask, acceptTask } from '../../src/task.js';
import { buildContext } from '../../src/context.js';
import { validateHandoff } from '../../src/handoff.js';
import { importReview } from '../../src/review.js';
import { writeJson } from '../../src/lib/fs.js';
import { importPlan } from '../../src/plan.js';

async function writeHandoff(root: string, taskId: string, route: { role: string; model_class: string; provider_model: string; reasoning: string }, file = 'src/parser.ts'): Promise<void> {
  const stateRoot = await stateRootFor(root);
  await writeJson(resolve(stateRoot, `handoffs/${taskId}.json`), {
    schema_version: 1, task_id: taskId, status: 'worker_complete',
    agent: { role: route.role, model_class: route.model_class, provider_model: route.provider_model, reasoning: route.reasoning },
    files_read: [file], files_changed: [file], tests: [{ command: 'npm test -- parser', exit_code: 0, passed: 2, failed: 0 }],
    manual_checks: [{ description: 'manual parser check', result: 'passed' }],
    budget: { files_read: 1, context_bytes: 100, tool_output_chars: 100, repository_wide_scan_used: false, full_test_suite_used: false },
    known_risks: [], unresolved_questions: [], recommended_next_action: 'independent_review',
  });
}

async function prepareTask(root: string, id: string, options: { planRef?: string; kind?: 'implementation' | 'security_sensitive_development' } = {}): Promise<void> {
  await writeProjectFile(root, 'src/parser.ts', 'export const parse = (s: string) => s;\n');
  await createTask({ cwd: root, id, title: 'Parser', objective: 'Implement parser', kind: options.kind ?? 'implementation', planRef: options.planRef, allowedPaths: ['src/parser.ts'], targetedTests: ['npm test -- parser'] });
  await activateTask(id, root);
  const route = await routeAndPersist(id, root);
  const expectedModel = options.kind === 'security_sensitive_development' ? 'gpt-5.6-terra' : 'gpt-5.6-luna';
  assert.equal(route.provider_model, expectedModel);
  await buildContext(id, root);
  await dispatchTask(id, root);
  await writeHandoff(root, id, route);
  await validateHandoff(id, root);
}

async function reviewFile(root: string, name: string, taskId: string, role: string): Promise<string> {
  const file = resolve(root, name);
  await writeJson(file, { schema_version: 1, task_id: taskId, reviewer: { role }, verdict: 'accepted', required_followups: [], risks: [] });
  return file;
}

test('development flow uses external brain/reviewer and Luna-xhigh implementation', async () => {
  const root = await initializedRepo('development');
  await prepareTask(root, 'DEV-001');
  await assert.rejects(() => acceptTask('DEV-001', root), /review_pending/);
  await importReview('DEV-001', await reviewFile(root, 'external-review.json', 'DEV-001', 'external_reviewer'), root);
  assert.equal((await acceptTask('DEV-001', root)).state, 'done');
});

test('secure external-brain flow requires imported plan then Terra verifier before Sol security review', async () => {
  const root = await initializedRepo('secure-development-external-brain');
  await writeProjectFile(root, 'plan.md', '# ChatGPT implementation plan\n');
  await importPlan({ cwd: root, id: 'PLAN-EXT-001', file: resolve(root, 'plan.md'), author: 'external-chatgpt' });
  await prepareTask(root, 'SEC-EXT-001', { planRef: 'PLAN-EXT-001', kind: 'security_sensitive_development' });
  const sol = await reviewFile(root, 'sol-security.json', 'SEC-EXT-001', 'security_reviewer');
  await assert.rejects(() => importReview('SEC-EXT-001', sol, root), /complete first: verifier/);
  await importReview('SEC-EXT-001', await reviewFile(root, 'terra-review.json', 'SEC-EXT-001', 'verifier'), root);
  await importReview('SEC-EXT-001', sol, root);
  assert.equal((await acceptTask('SEC-EXT-001', root)).state, 'done');
});

test('secure local-brain flow uses Luna-xhigh for bounded implementation and Terra verifies', async () => {
  const root = await initializedRepo('secure-development-local-brain');
  await writeProjectFile(root, 'plan.md', '# Local Sol plan\n');
  await importPlan({ cwd: root, id: 'PLAN-LOCAL-001', file: resolve(root, 'plan.md'), author: 'local-sol' });
  await prepareTask(root, 'SEC-LOCAL-001', { planRef: 'PLAN-LOCAL-001' });
  const route = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(await stateRootFor(root), 'generated/SEC-LOCAL-001.route.json'), 'utf8')) as { provider_model: string; role: string };
  assert.equal(route.provider_model, 'gpt-5.6-luna');
  assert.equal(route.role, 'implementation_worker');
  await importReview('SEC-LOCAL-001', await reviewFile(root, 'terra.json', 'SEC-LOCAL-001', 'verifier'), root);
  await importReview('SEC-LOCAL-001', await reviewFile(root, 'sol.json', 'SEC-LOCAL-001', 'security_reviewer'), root);
  assert.equal((await acceptTask('SEC-LOCAL-001', root)).state, 'done');
});

test('secure profile routing fails closed without plan', async () => {
  const root = await initializedRepo('secure-development-external-brain');
  await createTask({ cwd: root, id: 'NO-PLAN', title: 'Task', objective: 'Task', kind: 'implementation', allowedPaths: ['README.md'] });
  await activateTask('NO-PLAN', root);
  await assert.rejects(() => routeAndPersist('NO-PLAN', root), /requires --plan/);
});

test('illegal task transition fails', async () => {
  const root = await initializedRepo();
  await createTask({ cwd: root, id: 'DEV-002', title: 'Task', objective: 'Task', kind: 'implementation', allowedPaths: ['README.md'] });
  await assert.rejects(() => dispatchTask('DEV-002', root), /context/);
});
