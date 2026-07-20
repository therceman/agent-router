#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const offline = process.argv.includes('--offline');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = ['ci', '--no-audit', '--no-fund'];
if (offline) args.push('--offline');

console.log(`agent-router bootstrap: ${npm} ${args.join(' ')}`);
const result = spawnSync(npm, args, { stdio: 'inherit', shell: false });
if (result.error) {
  console.error(`agent-router bootstrap failed to start npm: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  if (offline) console.error('Offline bootstrap requires every locked package to already exist in the local npm cache.');
  else console.error('Bootstrap failed. The install deliberately disables npm audit; run `npm run security:audit` separately when network access is reliable.');
  process.exit(result.status ?? 1);
}
