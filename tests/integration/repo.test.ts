import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { initializedRepo, writeProjectFile } from '../helpers.js';
import { inspectRepository, createDietPlan, applyDietPlan } from '../../src/repo.js';
import { pathExists } from '../../src/lib/fs.js';

test('repository inspect protects agent-router state and classifies artifacts', async () => {
  const root = await initializedRepo();
  await writeProjectFile(root, 'ghidra/project.gpr', 'artifact');
  await writeProjectFile(root, 'docker-data/volume.bin', 'runtime');
  await writeProjectFile(root, 'unknown.evidence', 'ambiguous');
  const report = await inspectRepository(root) as { entries: Array<{ path: string; classification: string }> };
  assert.equal(report.entries.find((e) => e.path === '.agent-router'), undefined);
  assert.equal(report.entries.find((e) => e.path === 'ghidra/project.gpr')?.classification, 'external_artifact');
  assert.equal(report.entries.find((e) => e.path === 'unknown.evidence')?.classification, 'ambiguous');
});

test('diet plan is read-only and apply requires exact confirmation', async () => {
  const root = await initializedRepo();
  await writeProjectFile(root, 'ghidra/project.gpr', 'artifact');
  await inspectRepository(root);
  const plan = await createDietPlan(root) as { plan_id: string; path: string };
  assert.equal(await pathExists(resolve(root, 'ghidra/project.gpr')), true);
  await assert.rejects(() => applyDietPlan({ planPath: plan.path, destination: resolve(root, '..', 'external'), confirm: 'wrong', cwd: root }), /confirmation/);
  const result = await applyDietPlan({ planPath: plan.path, destination: resolve(root, '..', 'external'), confirm: plan.plan_id, cwd: root }) as { moved: unknown[] };
  assert.equal(result.moved.length, 1);
  assert.equal(await pathExists(resolve(root, 'ghidra/project.gpr')), false);
});
