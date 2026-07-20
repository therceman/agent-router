import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { registerProject, syncProject, ejectProject, doctorProject } from '../../src/project.js';
import { codexSetup } from '../../src/provider/codex.js';
import { pathExists } from '../../src/lib/fs.js';
import { tempGitRepo, stateRootFor } from '../helpers.js';
import { resolveProjectRuntime } from '../../src/state.js';
import { PROFILE_DEFINITIONS, type ProfileId } from '../../src/config.js';

for (const profile of Object.keys(PROFILE_DEFINITIONS) as ProfileId[]) {
  test(`${profile} registration is idempotent and zero-footprint`, async () => {
    const root = await tempGitRepo();
    await writeFile(resolve(root, 'AGENTS.md'), '# Company rules\n');
    const roles = PROFILE_DEFINITIONS[profile].roles;
    await codexSetup({ apply: true, dryRun: false, profile, roles });
    const before = await readFile(resolve(root, 'AGENTS.md'), 'utf8');
    const first = await registerProject({ cwd: root, profile, roles });
    const second = await registerProject({ cwd: root, profile, roles });
    assert.equal(first.project.project_id, second.project.project_id);
    assert.equal(await readFile(resolve(root, 'AGENTS.md'), 'utf8'), before);
    assert.equal(await pathExists(resolve(root, '.agent-router')), false);
    assert.equal(await pathExists(resolve(root, '.codex')), false);
    assert.equal(await pathExists(resolve(first.state_root, 'runtime/PROFILE.md')), true);
    const project = JSON.parse(await readFile(resolve(first.state_root, 'project.yaml'), 'utf8')) as { profile: string; enabled_roles: string[]; [key: string]: unknown };
    assert.equal(Object.hasOwn(project, 'mode'), false);
    assert.equal(project.profile, profile);
    assert.deepEqual(project.enabled_roles, roles);
    assert.equal((await doctorProject(root)).ok, true);
  });
}

test('registration dry-run creates no project state', async () => {
  const root = await tempGitRepo();
  const result = await registerProject({ cwd: root, profile: 'development', dryRun: true });
  assert.equal(result.dry_run, true);
  assert.equal(await pathExists(resolve(root, '.agent-router')), false);
  assert.equal(await pathExists(resolve(root, '.codex')), false);
  assert.equal(result.state_root ? await pathExists(result.state_root) : false, false);
});

test('sync check detects and repairs stale home-state runtime content', async () => {
  const root = await tempGitRepo();
  await registerProject({ cwd: root, profile: 'development' });
  const stateRoot = await stateRootFor(root);
  await writeFile(resolve(stateRoot, 'runtime/MAIN_SESSION.md'), 'stale');
  const result = await syncProject({ cwd: root, check: true }) as { current: boolean; stale: string[] };
  assert.equal(result.current, false);
  assert.ok(result.stale.includes('runtime/MAIN_SESSION.md'));
  await syncProject({ cwd: root });
  assert.equal((await syncProject({ cwd: root, check: true }) as { current: boolean }).current, true);
});

test('eject only unbinds home state and preserves work files and history', async () => {
  const root = await tempGitRepo();
  await writeFile(resolve(root, 'AGENTS.md'), '# Company rules\n');
  await registerProject({ cwd: root, profile: 'development' });
  const stateRoot = await stateRootFor(root);
  await ejectProject({ cwd: root });
  assert.equal(await readFile(resolve(root, 'AGENTS.md'), 'utf8'), '# Company rules\n');
  assert.equal(await pathExists(stateRoot), true);
  await assert.rejects(() => resolveProjectRuntime(root), /not registered/);
});

test('doctor detects a missing enabled Codex custom agent', async () => {
  const root = await tempGitRepo();
  await codexSetup({ apply: true, dryRun: false, profile: 'development', roles: ['main', 'implementation_worker', 'implementation_escalation_worker'] });
  await registerProject({ cwd: root, profile: 'development', roles: ['main', 'implementation_worker', 'implementation_escalation_worker'] });
  await rm(resolve(process.env.CODEX_HOME!, 'agents/agent-router-implementation-worker.toml'));
  const result = await doctorProject(root);
  assert.equal(result.ok, false);
  assert.match(result.checks.find((item) => item.name === 'codex_agents_available')?.detail ?? '', /implementation-worker/);
});


test('project state rejects unknown top-level fields instead of preserving compatibility selectors', async () => {
  const root = await tempGitRepo();
  const result = await registerProject({ cwd: root, profile: 'development' });
  const manifestPath = resolve(result.state_root, 'project.yaml');
  const project = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  project.storage_selector = 'repository';
  await writeFile(manifestPath, `${JSON.stringify(project, null, 2)}
`);
  await assert.rejects(() => resolveProjectRuntime(root), /unknown fields.*storage_selector/);
});
