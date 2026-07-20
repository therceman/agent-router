import test from 'node:test';
import assert from 'node:assert/strict';
import { initializedRepo } from '../helpers.js';
import { createPlan, getPlan } from '../../src/plan.js';

test('local Sol plan can be persisted without writing into work repository', async () => {
  const root = await initializedRepo('secure-development-local-brain');
  const record = await createPlan({ cwd: root, id: 'PLAN-LOCAL', title: 'Local Sol plan', author: 'local-sol', content: '# Plan\n1. Write tests.\n2. Implement.\n' });
  assert.equal(record.author, 'local-sol');
  const stored = await getPlan('PLAN-LOCAL', root);
  assert.match(stored.content, /Write tests/);
});
