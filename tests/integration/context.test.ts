import test from 'node:test';
import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { initializedRepo, writeProjectFile } from '../helpers.js';
import { createTask, activateTask, routeAndPersist, getTask } from '../../src/task.js';
import { buildContext } from '../../src/context.js';
import { writeJson } from '../../src/lib/fs.js';

test('context builder enforces file and byte budgets', async () => {
  const root = await initializedRepo();
  await writeProjectFile(root, 'src/large.ts', 'x'.repeat(100));
  await createTask({ cwd: root, id: 'CTX-001', title: 'Context', objective: 'Context', kind: 'implementation', allowedPaths: ['src/large.ts'] });
  const { path, task } = await getTask('CTX-001', root);
  task.budgets.maximum_single_file_bytes = 10;
  await writeJson(path, task);
  await activateTask('CTX-001', root); await routeAndPersist('CTX-001', root);
  await assert.rejects(() => buildContext('CTX-001', root), /No eligible context files/);
});

test('context builder rejects symlink escape', async () => {
  const root = await initializedRepo();
  const outside = await mkdtemp(resolve(tmpdir(), 'ar-outside-'));
  await writeFile(resolve(outside, 'secret.ts'), 'secret');
  await symlink(resolve(outside, 'secret.ts'), resolve(root, 'link.ts'));
  await createTask({ cwd: root, id: 'CTX-002', title: 'Context', objective: 'Context', kind: 'implementation', allowedPaths: ['link.ts'] });
  await activateTask('CTX-002', root); await routeAndPersist('CTX-002', root);
  await assert.rejects(() => buildContext('CTX-002', root), /No eligible context files/);
});
