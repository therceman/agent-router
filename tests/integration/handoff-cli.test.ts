import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initializedRepo, stateRootFor, writeProjectFile } from '../helpers.js';
import { activateTask, createTask, dispatchTask, getTask, routeAndPersist } from '../../src/task.js';
import { buildContext } from '../../src/context.js';
import { createHandoff, completeHandoff, readHandoff } from '../../src/handoff.js';
import { writeJson, pathExists } from '../../src/lib/fs.js';
import type { HandoffRecord } from '../../src/models.js';

function record(taskId: string): HandoffRecord {
  return {
    schema_version: 1,
    task_id: taskId,
    status: 'worker_complete',
    agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' },
    files_read: ['src/a.ts'],
    files_changed: ['src/a.ts'],
    tests: [{ command: 'npm test -- a', exit_code: 0, passed: 1, failed: 0 }],
    manual_checks: [{ description: 'manual check', result: 'passed' }],
    budget: { files_read: 1, context_bytes: 100, tool_output_chars: 50, repository_wide_scan_used: false, full_test_suite_used: false },
    known_risks: [],
    unresolved_questions: [],
    recommended_next_action: 'independent_verification',
  };
}

async function dispatched(root: string, taskId: string): Promise<void> {
  await writeProjectFile(root, 'src/a.ts', 'export const a = 1;\n');
  await createTask({ cwd: root, id: taskId, title: taskId, objective: taskId, kind: 'implementation', allowedPaths: ['src/a.ts'], targetedTests: ['npm test -- a'] });
  await activateTask(taskId, root);
  await routeAndPersist(taskId, root);
  await buildContext(taskId, root);
  await dispatchTask(taskId, root);
}

test('handoff create imports, validates, and stores a canonical record without changing task state', async () => {
  const root = await initializedRepo();
  await dispatched(root, 'HAND-001');
  const file = resolve(root, 'worker-result.json');
  await writeJson(file, record('HAND-001'));

  const created = await createHandoff('HAND-001', file, root);
  assert.equal(created.task_id, 'HAND-001');
  assert.equal((await getTask('HAND-001', root)).task.state, 'dispatched');
  assert.deepEqual(await readHandoff('HAND-001', root), created);
});

test('handoff complete atomically imports and advances task to worker_complete', async () => {
  const root = await initializedRepo();
  await dispatched(root, 'HAND-002');
  const file = resolve(root, 'worker-result.json');
  await writeJson(file, record('HAND-002'));

  const completed = await completeHandoff('HAND-002', file, root);
  assert.equal(completed.handoff.task_id, 'HAND-002');
  assert.equal(completed.task.state, 'worker_complete');
});

test('handoff complete can validate an already imported record', async () => {
  const root = await initializedRepo();
  await dispatched(root, 'HAND-003');
  const file = resolve(root, 'worker-result.json');
  await writeJson(file, record('HAND-003'));
  await createHandoff('HAND-003', file, root);

  const completed = await completeHandoff('HAND-003', undefined, root);
  assert.equal(completed.task.state, 'worker_complete');
});

test('handoff create fails closed and does not replace an existing valid handoff with invalid input', async () => {
  const root = await initializedRepo();
  await dispatched(root, 'HAND-004');
  const validFile = resolve(root, 'valid.json');
  await writeJson(validFile, record('HAND-004'));
  await createHandoff('HAND-004', validFile, root);
  const stateRoot = await stateRootFor(root);
  const canonical = resolve(stateRoot, 'handoffs/HAND-004.json');
  const before = await readFile(canonical, 'utf8');

  const bad = record('HAND-004');
  bad.tests[0]!.exit_code = 1;
  const badFile = resolve(root, 'bad.json');
  await writeJson(badFile, bad);
  await assert.rejects(() => createHandoff('HAND-004', badFile, root), /failing tests/);
  assert.equal(await readFile(canonical, 'utf8'), before);
  assert.equal(await pathExists(canonical), true);
});
