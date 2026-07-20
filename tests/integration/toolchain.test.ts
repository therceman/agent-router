import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = process.cwd();

test('dependency bootstrap separates npm audit from installation', async () => {
  const npmrc = await readFile(resolve(root, '.npmrc'), 'utf8');
  const bootstrap = await readFile(resolve(root, 'scripts/bootstrap.mjs'), 'utf8');
  const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
    scripts: Record<string, string>;
  };
  assert.match(npmrc, /^audit=false$/m);
  assert.match(npmrc, /^fund=false$/m);
  assert.match(bootstrap, /--no-audit/);
  assert.match(bootstrap, /--no-fund/);
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.scripts.bootstrap, 'node scripts/bootstrap.mjs');
  assert.equal(pkg.scripts['security:audit'], 'npm audit --audit-level=high');
});
