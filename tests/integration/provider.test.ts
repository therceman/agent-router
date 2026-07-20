import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { codexSetup, codexSetupRollback, codexSetupStatus } from '../../src/provider/codex.js';
import { pathExists } from '../../src/lib/fs.js';
import { allInstallableRoles, DEFAULT_MODEL_MAP, ROLE_METADATA } from '../../src/config.js';

async function useHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), 'ar-home-'));
  process.env.AGENT_ROUTER_HOME = resolve(home, '.agent-router');
  process.env.CODEX_HOME = resolve(home, '.codex');
  return home;
}

function rolePath(home: string, role: string): string {
  return resolve(home, '.codex', 'agents', `agent-router-${role.replaceAll('_', '-')}.toml`);
}

test('profile-agnostic setup installs every universal local role', async () => {
  const home = await useHome();
  const dry = await codexSetup({ apply: false, dryRun: true });
  assert.equal(dry.applied, false);
  assert.equal(Object.hasOwn(dry, 'profile'), false);
  assert.equal(await pathExists(resolve(home, '.codex/agent-router.config.toml')), false);

  const result = await codexSetup({ apply: true, dryRun: false });
  assert.deepEqual(result.installed_roles, allInstallableRoles());
  assert.equal(Object.hasOwn(result, 'profile'), false);
  const profile = await readFile(resolve(home, '.codex/agent-router.config.toml'), 'utf8');
  assert.match(profile, /^model = "gpt-5\.6-luna"/m);
  assert.match(profile, /max_threads = 2/);
  const globalAgents = await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8');
  assert.match(globalAgents, /Keep Agent Router metadata outside the work repository/);

  for (const role of allInstallableRoles().filter((item) => item !== 'main')) {
    const content = await readFile(rolePath(home, role), 'utf8');
    const config = DEFAULT_MODEL_MAP.roles[role];
    const model = DEFAULT_MODEL_MAP.models[config.model].provider_model;
    assert.match(content, new RegExp(`name = ${JSON.stringify(ROLE_METADATA[role].name)}`));
    assert.match(content, new RegExp(`model = ${JSON.stringify(model)}`));
    assert.match(content, new RegExp(`model_reasoning_effort = ${JSON.stringify(config.reasoning)}`));
  }
});

test('setup is idempotent and does not remove unrelated Codex agents', async () => {
  const home = await useHome();
  await mkdir(resolve(home, '.codex/agents'), { recursive: true });
  await writeFile(resolve(home, '.codex/agents/user-owned.toml'), 'name = "user-owned"\n');
  await codexSetup({ apply: true, dryRun: false });
  const configBefore = await readFile(resolve(home, '.agent-router/config.yaml'), 'utf8');
  const agentsBefore = await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8');
  await codexSetup({ apply: true, dryRun: false });
  assert.equal(await readFile(resolve(home, '.agent-router/config.yaml'), 'utf8'), configBefore);
  assert.equal(await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8'), agentsBefore);
  assert.equal(await readFile(resolve(home, '.codex/agents/user-owned.toml'), 'utf8'), 'name = "user-owned"\n');
  assert.equal(agentsBefore.split('<!-- agent-router:start -->').length - 1, 1);
});

test('v0.6 profile-specific machine state migrates without changing projects or user files', async () => {
  const home = await useHome();
  await mkdir(resolve(home, '.agent-router'), { recursive: true });
  await mkdir(resolve(home, '.codex/agents'), { recursive: true });
  await writeFile(resolve(home, '.agent-router/config.yaml'), `${JSON.stringify({
    schema_version: 1,
    provider: 'codex',
    installed_profiles: ['development', 'security-research'],
    enabled_roles: ['main', 'implementation_worker'],
    codex_home: resolve(home, '.codex'),
  }, null, 2)}\n`);
  await writeFile(resolve(home, '.codex/AGENTS.md'), '# User content\n');
  await writeFile(resolve(home, '.codex/agents/user-owned.toml'), 'name = "user-owned"\n');
  await writeFile(rolePath(home, 'implementation_worker'), '# old managed role\n');

  const result = await codexSetup({ apply: true, dryRun: false }) as { legacy_profile_metadata_removed: boolean };
  assert.equal(result.legacy_profile_metadata_removed, true);
  const config = JSON.parse(await readFile(resolve(home, '.agent-router/config.yaml'), 'utf8')) as Record<string, unknown>;
  assert.equal(config.installed_version, '0.7.0');
  assert.deepEqual(config.installed_roles, allInstallableRoles());
  assert.equal(Object.hasOwn(config, 'installed_profiles'), false);
  assert.equal(Object.hasOwn(config, 'enabled_roles'), false);
  assert.equal(await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8').then((value) => value.startsWith('# User content')), true);
  assert.equal(await readFile(resolve(home, '.codex/agents/user-owned.toml'), 'utf8'), 'name = "user-owned"\n');
  assert.equal(await pathExists(rolePath(home, 'security_researcher')), true);
});

test('setup preserves existing AGENTS content and warns about override shadowing', async () => {
  const home = await useHome();
  await mkdir(resolve(home, '.codex'), { recursive: true });
  await mkdir(resolve(home, '.agent-router'), { recursive: true });
  await writeFile(resolve(home, '.codex/AGENTS.md'), '# Personal rules\n');
  await writeFile(resolve(home, '.codex/AGENTS.override.md'), '# Override\n');
  const result = await codexSetup({ apply: true, dryRun: false }) as { warnings: string[] };
  assert.equal(result.warnings.length, 1);
  const agents = await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8');
  assert.match(agents, /# Personal rules/);
  assert.equal(agents.split('<!-- agent-router:start -->').length - 1, 1);
});

test('setup backups and rollback restore existing managed files', async () => {
  const home = await useHome();
  await mkdir(resolve(home, '.codex'), { recursive: true });
  await mkdir(resolve(home, '.agent-router'), { recursive: true });
  await writeFile(resolve(home, '.codex/agent-router.config.toml'), '# user profile\n');
  await writeFile(resolve(home, '.codex/AGENTS.md'), '# user agents\n');
  await writeFile(resolve(home, '.agent-router/config.yaml'), '{"legacy":true}\n');
  await codexSetup({ apply: true, dryRun: false });
  await codexSetupRollback();
  assert.equal(await readFile(resolve(home, '.codex/agent-router.config.toml'), 'utf8'), '# user profile\n');
  assert.equal(await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8'), '# user agents\n');
  assert.equal(await readFile(resolve(home, '.agent-router/config.yaml'), 'utf8'), '{"legacy":true}\n');
  assert.equal(await pathExists(rolePath(home, 'security_researcher')), false);
});

test('setup status reports structurally valid universal roles', async () => {
  await useHome();
  await codexSetup({ apply: true, dryRun: false });
  const status = await codexSetupStatus() as { installed_roles: string[]; role_statuses: Record<string, { valid: boolean }> };
  assert.deepEqual(status.installed_roles, allInstallableRoles());
  assert.equal(Object.values(status.role_statuses).every((role) => role.valid), true);
});
