import test from 'node:test';
import assert from 'node:assert/strict';
import { removeManagedBlock, upsertManagedBlock } from '../../src/lib/managed-block.js';

const start = '<!-- start -->';
const end = '<!-- end -->';

test('adds a managed block and preserves user content', () => {
  const out = upsertManagedBlock('# User\n', { start, end, body: 'managed' });
  assert.match(out, /# User/); assert.equal(out.split(start).length - 1, 1);
});

test('updates managed block idempotently', () => {
  const first = upsertManagedBlock('# User\n', { start, end, body: 'one' });
  const second = upsertManagedBlock(first, { start, end, body: 'two' });
  assert.equal(second.split(start).length - 1, 1); assert.match(second, /two/); assert.doesNotMatch(second, /one/);
});

test('rejects duplicate blocks', () => {
  assert.throws(() => upsertManagedBlock(`${start}\na\n${end}\n${start}\nb\n${end}`, { start, end, body: 'x' }), /duplicate/);
});

test('removes managed block and preserves user text', () => {
  const input = `before\n\n${start}\nmanaged\n${end}\n\nafter\n`;
  const out = removeManagedBlock(input, start, end);
  assert.match(out, /before/); assert.match(out, /after/); assert.doesNotMatch(out, /managed/);
});
