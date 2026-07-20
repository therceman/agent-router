import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { codexSetup, codexSetupRollback, codexSetupStatus } from '../../src/provider/codex.js';
import { pathExists } from '../../src/lib/fs.js';
import { PROFILE_DEFINITIONS } from '../../src/config.js';

async function useHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), 'ar-home-'));
  process.env.AGENT_ROUTER_HOME = resolve(home, '.agent-router');
  process.env.CODEX_HOME = resolve(home, '.codex');
  return home;
}

test('development setup writes Luna-low main, Luna-xhigh coder, and Terra-high escalation worker', async () => {
  const home = await useHome();
  const roles = PROFILE_DEFINITIONS.development.roles;
  const dry = await codexSetup({ apply: false, dryRun: true, profile: 'development', roles });
  assert.equal(dry.applied, false);
  assert.equal(await pathExists(resolve(home, '.codex/agent-router.config.toml')), false);
  await codexSetup({ apply: true, dryRun: false, profile: 'development', roles });
  const profile = await readFile(resolve(home, '.codex/agent-router.config.toml'), 'utf8');
  assert.match(profile, /^model = "gpt-5\.6-luna"/m);
  assert.match(profile, /max_threads = 2/);
  const globalAgents = await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8');
  assert.match(globalAgents, /Keep Agent Router metadata outside the work repository/);
  assert.match(globalAgents, /mechanical checks/);
  const worker = await readFile(resolve(home, '.codex/agents/agent-router-implementation-worker.toml'), 'utf8');
  assert.match(worker, /^name = /m);
  assert.match(worker, /model = "gpt-5\.6-luna"/);
  assert.match(worker, /model_reasoning_effort = "xhigh"/);
  const escalation = await readFile(resolve(home, '.codex/agents/agent-router-implementation-escalation-worker.toml'), 'utf8');
  assert.match(escalation, /model = "gpt-5\.6-terra"/);
  assert.match(escalation, /model_reasoning_effort = "high"/);
  assert.match(worker, /sandbox_mode = "workspace-write"/);
  assert.equal(await pathExists(resolve(home, '.codex/agents/agent-router-security-reviewer.toml')), false);
  const globalConfig = JSON.parse(await readFile(resolve(home, '.agent-router/config.yaml'), 'utf8')) as Record<string, unknown>;
  assert.equal(Object.hasOwn(globalConfig, 'mode'), false);
});

test('secure external-brain setup installs Terra verifier and Sol security reviewer', async () => {
  const home = await useHome();
  const profile = 'secure-development-external-brain' as const;
  await codexSetup({ apply: true, dryRun: false, profile, roles: PROFILE_DEFINITIONS[profile].roles });
  const verifier = await readFile(resolve(home, '.codex/agents/agent-router-verifier.toml'), 'utf8');
  const security = await readFile(resolve(home, '.codex/agents/agent-router-security-reviewer.toml'), 'utf8');
  assert.match(verifier, /model = "gpt-5\.6-terra"/);
  assert.match(security, /model = "gpt-5\.6-sol"/);
  assert.match(security, /security regressions/);
});

test('secure local-brain setup additionally installs Sol architect', async () => {
  const home = await useHome();
  const profile = 'secure-development-local-brain' as const;
  await codexSetup({ apply: true, dryRun: false, profile, roles: PROFILE_DEFINITIONS[profile].roles });
  const architect = await readFile(resolve(home, '.codex/agents/agent-router-architect.toml'), 'utf8');
  assert.match(architect, /model = "gpt-5\.6-sol"/);
  assert.match(architect, /Create or review a bounded implementation plan/);
});

test('security-research setup is distinct from secure development', async () => {
  const home = await useHome();
  const profile = 'security-research' as const;
  await codexSetup({ apply: true, dryRun: false, profile, roles: PROFILE_DEFINITIONS[profile].roles });
  assert.equal(await pathExists(resolve(home, '.codex/agents/agent-router-security-researcher.toml')), true);
  assert.equal(await pathExists(resolve(home, '.codex/agents/agent-router-implementation-worker.toml')), false);
});

test('setup accumulates profiles and roles instead of deleting prior agents', async () => {
  const home = await useHome();
  await codexSetup({ apply: true, dryRun: false, profile: 'secure-development-local-brain', roles: PROFILE_DEFINITIONS['secure-development-local-brain'].roles });
  const architect = resolve(home, '.codex/agents/agent-router-architect.toml');
  assert.equal(await pathExists(architect), true);
  await codexSetup({ apply: true, dryRun: false, profile: 'development', roles: PROFILE_DEFINITIONS.development.roles });
  assert.equal(await pathExists(architect), true);
  const status = await codexSetupStatus() as { global_config: { installed_profiles: string[] } };
  assert.deepEqual(new Set(status.global_config.installed_profiles), new Set(['secure-development-local-brain', 'development']));
});

test('setup preserves existing AGENTS content and warns about override shadowing', async () => {
  const home = await useHome();
  await mkdir(resolve(home, '.codex'), { recursive: true });
  await writeFile(resolve(home, '.codex/AGENTS.md'), '# Personal rules\n');
  await writeFile(resolve(home, '.codex/AGENTS.override.md'), '# Override\n');
  const result = await codexSetup({ apply: true, dryRun: false, profile: 'development', roles: PROFILE_DEFINITIONS.development.roles }) as { warnings: string[] };
  assert.equal(result.warnings.length, 1);
  const agents = await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8');
  assert.match(agents, /# Personal rules/);
  assert.equal(agents.split('<!-- agent-router:start -->').length - 1, 1);
});

test('setup backups and rollback restore existing files', async () => {
  const home = await useHome();
  await mkdir(resolve(home, '.codex'), { recursive: true });
  await writeFile(resolve(home, '.codex/agent-router.config.toml'), '# user profile\n');
  await writeFile(resolve(home, '.codex/AGENTS.md'), '# user agents\n');
  await codexSetup({ apply: true, dryRun: false, profile: 'development', roles: PROFILE_DEFINITIONS.development.roles });
  await codexSetupRollback();
  assert.equal(await readFile(resolve(home, '.codex/agent-router.config.toml'), 'utf8'), '# user profile\n');
  assert.equal(await readFile(resolve(home, '.codex/AGENTS.md'), 'utf8'), '# user agents\n');
  assert.equal(await pathExists(resolve(home, '.codex/agents/agent-router-implementation-worker.toml')), false);
});

test('setup rejects an incomplete role set for a selected profile', async () => {
  await useHome();
  await assert.rejects(
    () => codexSetup({ apply: true, dryRun: false, profile: 'secure-development-external-brain', roles: ['main', 'implementation_worker', 'implementation_escalation_worker'] }),
    /requires roles: verifier, security_reviewer/,
  );
});
