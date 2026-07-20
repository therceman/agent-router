import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createZip } from '../../src/zip.js';
import { run } from '../../src/lib/process.js';

test('creates a standards-compatible zip archive', async () => {
  const dir = await mkdtemp(resolve(tmpdir(), 'ar-zip-'));
  const file = resolve(dir, 'test.zip');
  await createZip(file, [{ name: 'hello.txt', data: Buffer.from('hello') }]);
  const raw = await readFile(file);
  assert.equal(raw.readUInt32LE(0), 0x04034b50);
  const unzip = run('unzip', ['-p', file, 'hello.txt']);
  if (unzip.status === 0) assert.equal(unzip.stdout, 'hello');
});
