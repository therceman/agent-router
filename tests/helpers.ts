import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { runChecked } from '../src/lib/process.js';
import { registerProject } from '../src/project.js';
import { codexSetup } from '../src/provider/codex.js';
import { resolveProjectRuntime } from '../src/state.js';
import type { ProfileId } from '../src/config.js';

export async function isolatedHome(prefix = 'agent-router-home-'): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), prefix));
  process.env.AGENT_ROUTER_HOME = resolve(home, '.agent-router');
  process.env.CODEX_HOME = resolve(home, '.codex');
  return home;
}

export async function tempGitRepo(prefix = 'agent-router-test-'): Promise<string> {
  await isolatedHome();
  const root = await mkdtemp(resolve(tmpdir(), prefix));
  runChecked('git', ['init'], root);
  runChecked('git', ['config', 'user.email', 'test@example.com'], root);
  runChecked('git', ['config', 'user.name', 'Test User'], root);
  await writeFile(resolve(root, 'README.md'), '# Fixture\n');
  runChecked('git', ['add', '.'], root);
  runChecked('git', ['commit', '-m', 'initial'], root);
  return root;
}

export async function initializedRepo(profile: ProfileId = 'development'): Promise<string> {
  const root = await tempGitRepo();
  await codexSetup({ apply: true, dryRun: false });
  await registerProject({ cwd: root, profile });
  return root;
}

export async function stateRootFor(root: string): Promise<string> {
  return (await resolveProjectRuntime(root)).stateRoot;
}

export async function writeProjectFile(root: string, path: string, content: string): Promise<void> {
  const full = resolve(root, path);
  await mkdir(resolve(full, '..'), { recursive: true });
  await writeFile(full, content);
}
