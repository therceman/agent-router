import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const selection = process.argv[2] ?? 'all';
const roots = selection === 'unit' ? ['.test-dist/tests/unit'] : selection === 'integration' ? ['.test-dist/tests/integration'] : ['.test-dist/tests/unit', '.test-dist/tests/integration'];
const files = [];
const walk = (p) => {
  for (const n of readdirSync(p, { withFileTypes: true })) {
    const q = join(p, n.name);
    if (n.isDirectory()) walk(q);
    else if (n.isFile() && n.name.endsWith('.test.js')) files.push(q);
  }
};
for (const root of roots) {
  try { if (statSync(root).isDirectory()) walk(root); } catch {}
}
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
