import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isPortableAbsolutePath, normalizePortableAbsolutePath, normalizeRepositoryRoot } from '../../src/lib/portable-path.js';
import { pathExists, withFileLock } from '../../src/lib/fs.js';

test('portable path validation distinguishes POSIX, drive, UNC, and drive-relative paths', () => {
  assert.equal(isPortableAbsolutePath('/var/lib/agent-router'), true);
  assert.equal(isPortableAbsolutePath('C:\\work\\repo'), true);
  assert.equal(isPortableAbsolutePath('\\\\server\\share\\repo'), true);
  assert.equal(isPortableAbsolutePath('C:repo'), false);
  assert.equal(normalizePortableAbsolutePath('C:/work/repo/..'), 'C:\\work');
  assert.equal(normalizeRepositoryRoot('/tmp/../var/lib'), '/var/lib');
});

test('lock release never removes a replacement lock with a different nonce', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-router-lock-')); const lock = resolve(root, 'state.lock');
  await withFileLock(lock, { command: 'test', project_id: 'lock-project' }, async () => {
    await writeFile(lock, JSON.stringify({ pid: 999999, host: 'replacement', nonce: 'replacement-nonce', acquired_at: new Date().toISOString(), heartbeat_at: new Date().toISOString(), command: 'replacement', project_id: 'lock-project' }));
  });
  assert.equal(await pathExists(lock), true);
  await rm(root, { recursive: true, force: true });
});

test('dead aged locks are reclaimable while live locks are not treated as stale', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-router-lock-stale-')); const lock = resolve(root, 'state.lock'); const old = new Date(Date.now() - 10_000);
  await writeFile(lock, JSON.stringify({ pid: 999999, host: 'unknown-host', nonce: 'old', acquired_at: old.toISOString(), heartbeat_at: old.toISOString(), command: 'old', project_id: 'lock-project' })); await utimes(lock, old, old);
  await withFileLock(lock, { command: 'new', project_id: 'lock-project' }, async () => undefined, { staleMs: 1000, timeoutMs: 1000, pollMs: 5 });
  await rm(root, { recursive: true, force: true });
});
