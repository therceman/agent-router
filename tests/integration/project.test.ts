import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { registerProject, syncProject, ejectProject, doctorProject } from '../../src/project.js';
import { codexSetup } from '../../src/provider/codex.js';
import { pathExists } from '../../src/lib/fs.js';
import { isolatedHome, tempGitRepo, stateRootFor } from '../helpers.js';
import { runChecked } from '../../src/lib/process.js';
import { resolveProjectRuntime } from '../../src/state.js';
import { PROFILE_DEFINITIONS, type ProfileId } from '../../src/config.js';
import { activateTask, createTask, routeAndPersist } from '../../src/task.js';

for (const profile of Object.keys(PROFILE_DEFINITIONS) as ProfileId[]) {
  test(`${profile} registration is idempotent and zero-footprint`, async () => {
    const root = await tempGitRepo();
    await writeFile(resolve(root, 'AGENTS.md'), '# Company rules\n');
    const roles = PROFILE_DEFINITIONS[profile].roles;
    await codexSetup({ apply: true, dryRun: false });
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

test('one global setup supports different profiles in multiple projects', async () => {
  await isolatedHome('agent-router-multi-profile-');
  const makeRepo = async (): Promise<string> => {
    const root = await mkdtemp(resolve(tmpdir(), 'agent-router-multi-repo-'));
    runChecked('git', ['init'], root);
    runChecked('git', ['config', 'user.email', 'test@example.com'], root);
    runChecked('git', ['config', 'user.name', 'Test User'], root);
    await writeFile(resolve(root, 'README.md'), '# Fixture\n');
    runChecked('git', ['add', '.'], root);
    runChecked('git', ['commit', '-m', 'initial'], root);
    return root;
  };
  const development = await makeRepo();
  const research = await makeRepo();
  await codexSetup({ apply: true, dryRun: false });
  await registerProject({ cwd: development, profile: 'development' });
  await registerProject({ cwd: research, profile: 'security-research' });
  assert.equal((await doctorProject(development)).ok, true);
  assert.equal((await doctorProject(research)).ok, true);
});

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
  await codexSetup({ apply: true, dryRun: false });
  await registerProject({ cwd: root, profile: 'development', roles: ['main', 'implementation_worker', 'implementation_escalation_worker'] });
  await rm(resolve(process.env.CODEX_HOME!, 'agents/agent-router-implementation-worker.toml'));
  const result = await doctorProject(root);
  assert.equal(result.ok, false);
  assert.match(result.checks.find((item) => item.name === 'codex_agents_available')?.detail ?? '', /implementation-worker/);
});

test('development cannot route security research to a globally installed research role', async () => {
  const root = await tempGitRepo();
  await codexSetup({ apply: true, dryRun: false });
  await registerProject({ cwd: root, profile: 'development' });
  await createTask({
    cwd: root,
    id: 'DEV-SECURITY-01',
    title: 'Research authorization boundary',
    objective: 'Verify that profile authorization is enforced during routing',
    kind: 'security_research',
  });
  await activateTask('DEV-SECURITY-01', root);
  await assert.rejects(
    () => routeAndPersist('DEV-SECURITY-01', root),
    /Role security_researcher is not permitted by profile development/,
  );
});

test('security-research can route security research to its permitted global role', async () => {
  const root = await tempGitRepo();
  await codexSetup({ apply: true, dryRun: false });
  await registerProject({ cwd: root, profile: 'security-research' });
  const { stateRoot } = await resolveProjectRuntime(root);
  await mkdir(resolve(stateRoot, 'plans'), { recursive: true });
  await writeFile(resolve(stateRoot, 'plans/SEC-PLAN.json'), '{}\n');
  await createTask({
    cwd: root,
    id: 'SEC-RESEARCH-01',
    title: 'Bounded security research',
    objective: 'Verify that the security research profile permits its research role',
    kind: 'security_research',
    planRef: 'SEC-PLAN',
  });
  await activateTask('SEC-RESEARCH-01', root);
  const route = await routeAndPersist('SEC-RESEARCH-01', root);
  assert.equal(route.role, 'security_researcher');
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
