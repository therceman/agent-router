import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { writeJson, pathExists } from '../../src/lib/fs.js';
import { initializedRepo, writeProjectFile, stateRootFor } from '../helpers.js';
import { createTask, activateTask, routeAndPersist, dispatchTask } from '../../src/task.js';
import { buildContext } from '../../src/context.js';
import { createTaskReviewPack } from '../../src/review.js';
import { run } from '../../src/lib/process.js';

test('creates compact task review pack', async () => {
  const root = await initializedRepo();
  await writeProjectFile(root, 'src/a.ts', 'export const a = 1;\n');
  await createTask({ cwd: root, id: 'REV-001', title: 'Review', objective: 'Review', kind: 'implementation', allowedPaths: ['src/a.ts'] });
  await activateTask('REV-001', root); await routeAndPersist('REV-001', root); await buildContext('REV-001', root); await dispatchTask('REV-001', root);
  const stateRoot = await stateRootFor(root);
  await writeJson(resolve(stateRoot, 'handoffs/REV-001.json'), {
    schema_version: 1, task_id: 'REV-001', status: 'worker_complete', agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' },
    files_read: ['src/a.ts'], files_changed: ['src/a.ts'], tests: [{ command: 'test', exit_code: 0, passed: 1, failed: 0 }], manual_checks: [],
    budget: { files_read: 1, context_bytes: 10, tool_output_chars: 10, repository_wide_scan_used: false, full_test_suite_used: false }, known_risks: [], unresolved_questions: [], recommended_next_action: 'review',
  });
  const output = resolve(root, 'review.zip');
  await createTaskReviewPack('REV-001', output, root);
  assert.equal(await pathExists(output), true);
  const listing = run('unzip', ['-l', output]);
  if (listing.status === 0) {
    assert.match(listing.stdout, /manifest.json/); assert.match(listing.stdout, /task.json/); assert.match(listing.stdout, /changed-files\/src\/a.ts/);
  }
});

test('review pack blocks secret-like changed content', async () => {
  const root = await initializedRepo();
  await writeProjectFile(root, 'src/secret.ts', 'const api_key = "abcdefghijklmnopqrst";\n');
  await createTask({ cwd: root, id: 'REV-002', title: 'Review', objective: 'Review', kind: 'implementation', allowedPaths: ['src/secret.ts'] });
  await activateTask('REV-002', root); await routeAndPersist('REV-002', root); await buildContext('REV-002', root); await dispatchTask('REV-002', root);
  const stateRoot = await stateRootFor(root);
  await writeJson(resolve(stateRoot, 'handoffs/REV-002.json'), {
    schema_version: 1, task_id: 'REV-002', status: 'worker_complete', agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' },
    files_read: ['src/secret.ts'], files_changed: ['src/secret.ts'], tests: [{ command: 'test', exit_code: 0 }], manual_checks: [],
    budget: { files_read: 1, context_bytes: 10, tool_output_chars: 10, repository_wide_scan_used: false, full_test_suite_used: false }, known_risks: [], unresolved_questions: [], recommended_next_action: 'review',
  });
  await assert.rejects(() => createTaskReviewPack('REV-002', resolve(root, 'review.zip'), root), /Secret-like content/);
});

test('secure review pack includes bounded context snippets and security purpose', async () => {
  const root = await initializedRepo('secure-development-external-brain');
  await writeProjectFile(root, 'src/secure.ts', 'export const validate = (s: string) => s.length > 0;\n');
  await writeProjectFile(root, 'plan.md', '# Secure plan\n');
  const { importPlan } = await import('../../src/plan.js');
  await importPlan({ cwd: root, id: 'PLAN-SEC', file: resolve(root, 'plan.md'), author: 'external-chatgpt' });
  await createTask({ cwd: root, id: 'REV-SEC', title: 'Secure review', objective: 'Review secure change', kind: 'security_sensitive_development', planRef: 'PLAN-SEC', allowedPaths: ['src/secure.ts'] });
  await activateTask('REV-SEC', root); await routeAndPersist('REV-SEC', root); await buildContext('REV-SEC', root); await dispatchTask('REV-SEC', root);
  const stateRoot = await stateRootFor(root);
  await writeJson(resolve(stateRoot, 'handoffs/REV-SEC.json'), {
    schema_version: 1, task_id: 'REV-SEC', status: 'worker_complete', agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' },
    files_read: ['src/secure.ts'], files_changed: ['src/secure.ts'], tests: [{ command: 'test', exit_code: 0, passed: 1, failed: 0 }], manual_checks: [],
    budget: { files_read: 1, context_bytes: 10, tool_output_chars: 10, repository_wide_scan_used: false, full_test_suite_used: false }, known_risks: [], unresolved_questions: [], recommended_next_action: 'security_review',
  });
  const output = resolve(root, 'secure-review.zip');
  await createTaskReviewPack('REV-SEC', output, root, 'security');
  const listing = run('unzip', ['-l', output]);
  if (listing.status === 0) {
    assert.match(listing.stdout, /review-purpose\.json/);
    assert.match(listing.stdout, /review-snippets\/src\/secure\.ts\.txt/);
  }
});
