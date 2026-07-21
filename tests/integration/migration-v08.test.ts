import test from 'node:test';
import assert from 'node:assert/strict';
import { activateTask, createTask, dispatchTask, getTask, routeAndPersist } from '../../src/task.js';
import { buildContext } from '../../src/context.js';
import { migrationCheck, migrateProject } from '../../src/migration.js';
import { readJson, writeJson } from '../../src/lib/fs.js';
import type { TaskRecord } from '../../src/models.js';
import { initializedRepo } from '../helpers.js';

test('v0.7 task migration is safe, marks legacy assignment state, and is idempotent', async () => {
  const root = await initializedRepo();
  await createTask({ cwd: root, id: 'MIGRATE-001', title: 'Legacy task', objective: 'Migrate safely', kind: 'implementation', allowedPaths: ['README.md'] });
  await activateTask('MIGRATE-001', root); await routeAndPersist('MIGRATE-001', root); await buildContext('MIGRATE-001', root); await dispatchTask('MIGRATE-001', root);
  const current = await getTask('MIGRATE-001', root);
  const legacy = { ...current.task, schema_version: 1 as const } as TaskRecord;
  delete legacy.revision; delete legacy.previous_revision; delete legacy.effective_contract_sha256; delete legacy.legacy_unassigned;
  await writeJson(current.path, legacy);

  const check = await migrationCheck(root); assert.equal(check.applied, false); assert.deepEqual(check.work_repository_writes, []); assert.match(JSON.stringify(check.changes), /MIGRATE-001/);
  const applied = await migrateProject({ cwd: root, apply: true }); assert.equal(applied.applied, true); assert.deepEqual(applied.work_repository_writes, []);
  const migrated = (await getTask('MIGRATE-001', root)).task; assert.equal(migrated.schema_version, 2); assert.equal(migrated.revision, 1); assert.equal(migrated.legacy_unassigned, true); assert.equal(migrated.last_assignment_id, undefined);
  const rerun = await migrationCheck(root); assert.equal(rerun.applied, false); assert.deepEqual(rerun.changes, []);
  assert.deepEqual(await readJson<TaskRecord>((await getTask('MIGRATE-001', root)).path), migrated);
});
