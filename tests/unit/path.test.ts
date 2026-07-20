import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { assertRelativeProjectPath, safeProjectPath } from '../../src/lib/path.js';

test('rejects path traversal and absolute paths', () => {
  assert.throws(() => assertRelativeProjectPath('../secret'));
  assert.throws(() => assertRelativeProjectPath('/tmp/secret'));
});

test('accepts normal relative path', () => assert.doesNotThrow(() => assertRelativeProjectPath('src/file.ts')));

test('rejects symlink escape', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'ar-path-'));
  const outside = await mkdtemp(resolve(tmpdir(), 'ar-outside-'));
  await writeFile(resolve(outside, 'secret.txt'), 'secret');
  await mkdir(resolve(root, 'src'));
  await symlink(resolve(outside, 'secret.txt'), resolve(root, 'src/link.txt'));
  await assert.rejects(() => safeProjectPath(root, 'src/link.txt'), /Symlink escapes/);
});

test('task identifiers cannot be used as paths', async () => {
  const { validateTaskId } = await import('../../src/task.js');
  assert.throws(() => validateTaskId('../../escape'), /Invalid task ID/);
  assert.doesNotThrow(() => validateTaskId('DEV-001'));
});
