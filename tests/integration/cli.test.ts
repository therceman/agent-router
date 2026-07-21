import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathExists } from '../../src/lib/fs.js';
import { isolatedHome, tempGitRepo } from '../helpers.js';
import { run } from '../../src/lib/process.js';

const cli = resolve(process.cwd(), 'dist/cli.js');

test('CLI help and version exit successfully', () => {
  const help = run(process.execPath, [cli, '--help']);
  assert.equal(help.status, 0); assert.match(help.stdout, /Agent Router/);
  const version = run(process.execPath, [cli, '--version']);
  assert.equal(version.status, 0); assert.match(version.stdout, /0\.8\.1/);
});

test('setup is profile-agnostic and project registration retains profile selection', async () => {
  const home = await isolatedHome();
  const setupHelp = run(process.execPath, [cli, 'setup', '--help']);
  assert.equal(setupHelp.status, 0);
  assert.doesNotMatch(setupHelp.stdout, /--profile/);
  const registerHelp = run(process.execPath, [cli, 'project', 'register', '--help']);
  assert.equal(registerHelp.status, 0);
  assert.match(registerHelp.stdout, /--profile <profile>/);

  const invalid = run(process.execPath, [cli, 'setup', '--provider', 'codex', '--profile', 'development', '--apply']);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /Unknown option: --profile/);
  assert.match(invalid.stderr, /Workflow profiles belong to projects/);
  assert.equal(await pathExists(resolve(home, '.agent-router/config.yaml')), false);
  assert.equal(await pathExists(resolve(home, '.codex/AGENTS.md')), false);

  const setup = run(process.execPath, [cli, 'setup', '--provider', 'codex', '--apply']);
  assert.equal(setup.status, 0, setup.stderr);
  const globalDoctor = run(process.execPath, [cli, 'doctor', '--global', '--json']);
  assert.equal(globalDoctor.status, 0, globalDoctor.stderr);
  const result = JSON.parse(globalDoctor.stdout) as { ok: boolean; checks: Array<{ name: string; ok: boolean }> };
  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === 'machine_profile_free')?.ok, true);
});

test('CLI reports unknown commands as nonzero', () => {
  const result = run(process.execPath, [cli, 'does-not-exist']);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Unknown command/);
});

test('CLI registers and reports status in a real repository', async () => {
  const root = await tempGitRepo();
  const init = run(process.execPath, [cli, 'project', 'register', '--profile', 'development', '--json'], root);
  assert.equal(init.status, 0, init.stderr);
  const status = run(process.execPath, [cli, 'status', '--json'], root);
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout) as { initialized: boolean };
  assert.equal(parsed.initialized, true);
});


test('CLI exposes no init command or mode option', async () => {
  const root = await tempGitRepo();
  const init = run(process.execPath, [cli, 'init'], root);
  assert.notEqual(init.status, 0);
  assert.match(init.stderr, /Unknown command/);
  const register = run(process.execPath, [cli, 'project', 'register', '--mode', 'local'], root);
  assert.notEqual(register.status, 0);
  assert.match(register.stderr, /Unknown option: --mode/);
});

test('CLI exposes token-efficient task lifecycle and handoff commands', async () => {
  const root = await tempGitRepo();
  const register = run(process.execPath, [cli, 'project', 'register', '--profile', 'development', '--json'], root);
  assert.equal(register.status, 0, register.stderr);

  const create = run(process.execPath, [cli, 'task', 'create', '--id', 'CLI-001', '--title', 'CLI task', '--objective', 'Exercise lifecycle', '--kind', 'implementation', '--allow', 'README.md', '--test', 'npm test', '--json'], root);
  assert.equal(create.status, 0, create.stderr);
  for (const args of [
    ['task', 'activate', 'CLI-001', '--json'],
    ['task', 'route', 'CLI-001', '--json'],
    ['context', 'build', 'CLI-001', '--json'],
    ['task', 'dispatch', 'CLI-001', '--json'],
    ['task', 'start', 'CLI-001', '--json'],
  ]) {
    const result = run(process.execPath, [cli, ...args], root);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }

  const handoffFile = resolve(root, 'handoff-input.json');
  await (await import('../../src/lib/fs.js')).writeJson(handoffFile, {
    schema_version: 1,
    task_id: 'CLI-001',
    status: 'worker_complete',
    agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' },
    files_read: ['README.md'],
    files_changed: ['README.md'],
    tests: [{ command: 'npm test', exit_code: 0, passed: 1, failed: 0 }],
    manual_checks: [],
    budget: { files_read: 1, context_bytes: 100, tool_output_chars: 100, repository_wide_scan_used: false, full_test_suite_used: false },
    known_risks: [],
    unresolved_questions: [],
    recommended_next_action: 'independent_verification',
  });
  const complete = run(process.execPath, [cli, 'handoff', 'complete', 'CLI-001', '--file', handoffFile, '--json'], root);
  assert.equal(complete.status, 0, complete.stderr);
  const completed = JSON.parse(complete.stdout) as { task: { state: string } };
  assert.equal(completed.task.state, 'worker_complete');
});

test('CLI retry and supersede commands use guarded state transitions', async () => {
  const root = await tempGitRepo();
  assert.equal(run(process.execPath, [cli, 'project', 'register', '--profile', 'development'], root).status, 0);
  for (const id of ['CLI-OLD', 'CLI-NEW']) {
    assert.equal(run(process.execPath, [cli, 'task', 'create', '--id', id, '--title', id, '--objective', id, '--kind', 'implementation'], root).status, 0);
    assert.equal(run(process.execPath, [cli, 'task', 'activate', id], root).status, 0);
  }
  assert.equal(run(process.execPath, [cli, 'task', 'block', 'CLI-OLD'], root).status, 0);
  const retry = run(process.execPath, [cli, 'task', 'retry', 'CLI-OLD', '--json'], root);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal((JSON.parse(retry.stdout) as { state: string }).state, 'ready');
  const supersede = run(process.execPath, [cli, 'task', 'supersede', 'CLI-OLD', '--by', 'CLI-NEW', '--json'], root);
  assert.equal(supersede.status, 0, supersede.stderr);
  const result = JSON.parse(supersede.stdout) as { state: string; superseded_by: string };
  assert.equal(result.state, 'superseded');
  assert.equal(result.superseded_by, 'CLI-NEW');
});
