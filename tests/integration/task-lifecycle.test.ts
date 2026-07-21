import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  activateTask,
  createTask,
  getTask,
  retryTask,
  startTask,
  supersedeTask,
  transitionTask,
} from '../../src/task.js';
import { initializedRepo, stateRootFor } from '../helpers.js';
import { pathExists, readJson, writeJson } from '../../src/lib/fs.js';
import type { TaskRecord } from '../../src/models.js';

async function createReadyTask(root: string, id: string): Promise<void> {
  await createTask({ cwd: root, id, title: id, objective: `Implement ${id}`, kind: 'implementation', allowedPaths: ['README.md'] });
  await activateTask(id, root);
}

test('task start moves dispatched task to in_progress through the state machine', async () => {
  const root = await initializedRepo();
  await createReadyTask(root, 'START-001');
  await transitionTask('START-001', 'routed', root);
  await transitionTask('START-001', 'context_ready', root);
  await transitionTask('START-001', 'dispatched', root);

  const started = await startTask('START-001', root);
  assert.equal(started.state, 'in_progress');
  const found = await getTask('START-001', root);
  assert.match(found.path, /tasks\/active\/START-001\.json$/);
});

test('task retry resets blocked task to ready and removes stale execution artifacts', async () => {
  const root = await initializedRepo();
  await createReadyTask(root, 'RETRY-001');
  const stateRoot = await stateRootFor(root);
  await transitionTask('RETRY-001', 'blocked', root);
  await writeJson(resolve(stateRoot, 'generated/RETRY-001.route.json'), { stale: true });
  await writeJson(resolve(stateRoot, 'contexts/RETRY-001.json'), { stale: true });
  await writeJson(resolve(stateRoot, 'handoffs/RETRY-001.json'), { stale: true });
  await writeJson(resolve(stateRoot, 'reviews/RETRY-001/verifier.json'), { stale: true });

  const retried = await retryTask('RETRY-001', root);
  assert.equal(retried.state, 'ready');
  assert.equal(await pathExists(resolve(stateRoot, 'generated/RETRY-001.route.json')), false);
  assert.equal(await pathExists(resolve(stateRoot, 'contexts/RETRY-001.json')), false);
  assert.equal(await pathExists(resolve(stateRoot, 'handoffs/RETRY-001.json')), false);
  assert.equal(await pathExists(resolve(stateRoot, 'reviews/RETRY-001')), false);
});

test('activate is reserved for draft tasks and retry handles blocked/rejected tasks', async () => {
  const root = await initializedRepo();
  await createReadyTask(root, 'RETRY-002');
  await transitionTask('RETRY-002', 'blocked', root);
  await assert.rejects(() => activateTask('RETRY-002', root), /only for draft tasks/);
  assert.equal((await retryTask('RETRY-002', root)).state, 'ready');
});

test('task supersede records replacement task and moves original to cancelled storage', async () => {
  const root = await initializedRepo();
  await createReadyTask(root, 'OLD-001');
  await createReadyTask(root, 'NEW-001');

  const result = await supersedeTask('OLD-001', 'NEW-001', root);
  assert.equal(result.state, 'superseded');
  assert.equal(result.superseded_by, 'NEW-001');
  const found = await getTask('OLD-001', root);
  assert.match(found.path, /tasks\/cancelled\/OLD-001\.json$/);
});

test('task supersede rejects self-reference, missing replacement, and completed task', async () => {
  const root = await initializedRepo();
  await createReadyTask(root, 'OLD-002');
  await assert.rejects(() => supersedeTask('OLD-002', 'OLD-002', root), /cannot supersede itself/);
  await assert.rejects(() => supersedeTask('OLD-002', 'MISSING-001', root), /replacement task does not exist/);

  await createReadyTask(root, 'DONE-001');
  await transitionTask('DONE-001', 'routed', root);
  await transitionTask('DONE-001', 'context_ready', root);
  await transitionTask('DONE-001', 'dispatched', root);
  await transitionTask('DONE-001', 'worker_complete', root);
  await transitionTask('DONE-001', 'review_pending', root);
  await transitionTask('DONE-001', 'accepted', root);
  await transitionTask('DONE-001', 'done', root);
  await assert.rejects(() => supersedeTask('DONE-001', 'OLD-002', root), /cannot be superseded/);
});

test('new task records use .json and legacy JSON-in-YAML records are migrated on first read', async () => {
  const root = await initializedRepo();
  await createTask({ cwd: root, id: 'JSON-001', title: 'JSON task', objective: 'Use JSON storage', kind: 'implementation' });
  const stateRoot = await stateRootFor(root);
  assert.equal(await pathExists(resolve(stateRoot, 'tasks/draft/JSON-001.json')), true);
  assert.equal(await pathExists(resolve(stateRoot, 'tasks/draft/JSON-001.yaml')), false);

  const original = await readJson<TaskRecord>(resolve(stateRoot, 'tasks/draft/JSON-001.json'));
  const legacy = { ...original, task_id: 'LEGACY-001', title: 'Legacy task' };
  await writeFile(resolve(stateRoot, 'tasks/draft/LEGACY-001.yaml'), `${JSON.stringify(legacy, null, 2)}\n`);

  const migrated = await getTask('LEGACY-001', root);
  assert.match(migrated.path, /LEGACY-001\.json$/);
  assert.equal(await pathExists(resolve(stateRoot, 'tasks/draft/LEGACY-001.yaml')), false);
  assert.equal((await readdir(resolve(stateRoot, 'tasks/draft'))).filter((name) => name.startsWith('LEGACY-001')).length, 1);
});


test('task retry supports rejected state and preserves append-only transition history', async () => {
  const root = await initializedRepo();
  await createReadyTask(root, 'RETRY-REJECTED');
  const stateRoot = await stateRootFor(root);
  await transitionTask('RETRY-REJECTED', 'routed', root);
  await transitionTask('RETRY-REJECTED', 'context_ready', root);
  await transitionTask('RETRY-REJECTED', 'dispatched', root);
  await transitionTask('RETRY-REJECTED', 'worker_complete', root);
  await transitionTask('RETRY-REJECTED', 'rejected', root);

  const eventsPath = resolve(stateRoot, 'events/events.jsonl');
  const before = (await readFile(eventsPath, 'utf8')).trim().split('\n').length;
  const retried = await retryTask('RETRY-REJECTED', root);
  const afterText = await readFile(eventsPath, 'utf8');
  const after = afterText.trim().split('\n').length;

  assert.equal(retried.state, 'ready');
  assert.equal(after, before + 2);
  assert.match(afterText, /"type":"task_amended"/);
  assert.match(afterText, /"from_state":"rejected","to_state":"ready"/);
});

test('legacy and current task records for the same task fail closed', async () => {
  const root = await initializedRepo();
  await createTask({ cwd: root, id: 'DUPLICATE-001', title: 'Duplicate task', objective: 'Reject ambiguous storage', kind: 'implementation' });
  const stateRoot = await stateRootFor(root);
  const current = await readJson<TaskRecord>(resolve(stateRoot, 'tasks/draft/DUPLICATE-001.json'));
  await writeFile(resolve(stateRoot, 'tasks/draft/DUPLICATE-001.yaml'), `${JSON.stringify(current, null, 2)}\n`);

  await assert.rejects(() => getTask('DUPLICATE-001', root), /Duplicate task records exist/);
  assert.equal(await pathExists(resolve(stateRoot, 'tasks/draft/DUPLICATE-001.json')), true);
  assert.equal(await pathExists(resolve(stateRoot, 'tasks/draft/DUPLICATE-001.yaml')), true);
});

test('rejected default implementation escalates once to Terra-high and a second rejection requires architect review', async () => {
  const root = await initializedRepo();
  await createReadyTask(root, 'ESCALATE-001');
  await transitionTask('ESCALATE-001', 'routed', root);
  await transitionTask('ESCALATE-001', 'context_ready', root);
  await transitionTask('ESCALATE-001', 'dispatched', root);
  await transitionTask('ESCALATE-001', 'worker_complete', root);
  await transitionTask('ESCALATE-001', 'rejected', root);

  const retried = await retryTask('ESCALATE-001', root);
  assert.equal(retried.execution?.implementation_tier, 'escalated');
  assert.equal(retried.execution?.attempt, 2);
  assert.equal(retried.execution?.escalation_reason, 'implementation_rejected');

  await transitionTask('ESCALATE-001', 'routed', root);
  await transitionTask('ESCALATE-001', 'context_ready', root);
  await transitionTask('ESCALATE-001', 'dispatched', root);
  await transitionTask('ESCALATE-001', 'worker_complete', root);
  await transitionTask('ESCALATE-001', 'rejected', root);
  await assert.rejects(() => retryTask('ESCALATE-001', root), /architect review task/);
});
