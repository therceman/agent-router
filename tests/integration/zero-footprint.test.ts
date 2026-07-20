import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { isolatedHome, initializedRepo, stateRootFor } from '../helpers.js';
import { runChecked } from '../../src/lib/process.js';
import {
  bindProject,
  bootstrapSession,
  listRegisteredProjects,
  registerProject,
  repositoryIdentity,
  unbindProject,
} from '../../src/state.js';
import { createTask, activateTask, routeAndPersist, dispatchTask } from '../../src/task.js';
import { buildContext } from '../../src/context.js';
import { createTaskReviewPack } from '../../src/review.js';
import { pathExists, writeJson } from '../../src/lib/fs.js';
import { globalPaths } from '../../src/config.js';
import { codexSetup } from '../../src/provider/codex.js';
import { doctorProject } from '../../src/project.js';

async function createRepo(remote?: string): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'agent-router-external-'));
  runChecked('git', ['init'], root);
  runChecked('git', ['config', 'user.email', 'test@example.com'], root);
  runChecked('git', ['config', 'user.name', 'Test User'], root);
  if (remote) runChecked('git', ['remote', 'add', 'origin', remote], root);
  await writeFile(resolve(root, 'README.md'), '# Work repository\n');
  await mkdir(resolve(root, 'src'), { recursive: true });
  await writeFile(resolve(root, 'src/index.ts'), 'export const value = 1;\n');
  runChecked('git', ['add', '.'], root);
  runChecked('git', ['commit', '-m', 'initial'], root);
  return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      if (name === '.git') continue;
      const full = resolve(dir, name);
      const info = await stat(full);
      if (info.isDirectory()) await walk(full);
      else result[relative(root, full).replaceAll('\\', '/')] = (await readFile(full)).toString('base64');
    }
  }
  await walk(root);
  return result;
}

test('registration and bootstrap make zero writes in the work repository', async () => {
  await isolatedHome();
  const root = await createRepo('git@example.invalid:team/project.git');
  await writeFile(resolve(root, 'AGENTS.md'), '# Company-owned instructions\n');
  await codexSetup({ apply: true, dryRun: false });
  const before = await snapshot(root);
  const registered = await registerProject({ cwd: root, roles: ['main', 'implementation_worker', 'implementation_escalation_worker'] }) as {
    state_root: string;
    project: { project_id: string };
    work_repo_writes: string[];
  };
  const after = await snapshot(root);
  assert.deepEqual(after, before);
  assert.deepEqual(registered.work_repo_writes, []);
  assert.equal(await pathExists(resolve(root, '.agent-router')), false);
  assert.equal(await pathExists(resolve(root, '.codex')), false);

  const boot = await bootstrapSession(root) as {
    project_id: string;
    state_root: string;
    enabled_roles: string[];
    repository_footprint: { agent_router_dir: boolean; codex_dir: boolean };
  };
  assert.equal(boot.project_id, registered.project.project_id);
  assert.equal(boot.state_root, registered.state_root);
  assert.equal(Object.hasOwn(boot, 'mode'), false);
  assert.deepEqual(boot.enabled_roles, ['main', 'implementation_worker', 'implementation_escalation_worker']);
  assert.deepEqual(boot.repository_footprint, { agent_router_dir: false, codex_dir: false });
  assert.equal((await doctorProject(root)).ok, true);
  assert.deepEqual(await snapshot(root), before);
});

test('the same normalized Git remote produces a stable project ID across machines', async () => {
  await isolatedHome();
  const first = await createRepo('git@GitHub.com:Therceman/Agent-Router-Demo.git');
  const second = await createRepo('https://github.com/therceman/agent-router-demo.git');
  const a = await repositoryIdentity(first);
  const b = await repositoryIdentity(second);
  assert.equal(a.identity, b.identity);
  assert.equal(a.projectId, b.projectId);
  await registerProject({ cwd: first });
  const registered = await listRegisteredProjects();
  assert.equal(registered.length, 1);
  assert.equal(registered[0]?.project_id, a.projectId);
});

test('binding requires the configured remote and unbind leaves project history intact', async () => {
  await isolatedHome();
  const original = await createRepo('git@example.invalid:team/bound.git');
  const registered = await registerProject({ cwd: original }) as { project: { project_id: string }; state_root: string };
  await unbindProject(registered.project.project_id);

  const withoutRemote = await createRepo();
  await assert.rejects(
    () => bindProject(registered.project.project_id, withoutRemote),
    /has no origin remote/,
  );

  const replacement = await createRepo('ssh://git@example.invalid/team/bound.git');
  await bindProject(registered.project.project_id, replacement);
  assert.equal(await pathExists(registered.state_root), true);
  const listed = await listRegisteredProjects();
  assert.equal(listed[0]?.repository_path, replacement);
});

test('default task review pack is written below AGENT_ROUTER_HOME', async () => {
  const root = await initializedRepo();
  await writeFile(resolve(root, 'src.ts'), 'export const value = 2;\n');
  await createTask({ cwd: root, id: 'EXT-REVIEW-001', title: 'External review', objective: 'Review changed source', kind: 'implementation', allowedPaths: ['src.ts'] });
  await activateTask('EXT-REVIEW-001', root);
  await routeAndPersist('EXT-REVIEW-001', root);
  await buildContext('EXT-REVIEW-001', root);
  await dispatchTask('EXT-REVIEW-001', root);
  const stateRoot = await stateRootFor(root);
  await writeJson(resolve(stateRoot, 'handoffs/EXT-REVIEW-001.json'), {
    schema_version: 1,
    task_id: 'EXT-REVIEW-001',
    status: 'worker_complete',
    agent: { role: 'implementation_worker', model_class: 'cheap', provider_model: 'gpt-5.6-luna', reasoning: 'xhigh' },
    files_read: ['src.ts'],
    files_changed: ['src.ts'],
    tests: [{ command: 'node --test', exit_code: 0, passed: 1, failed: 0 }],
    manual_checks: [],
    budget: { files_read: 1, context_bytes: 10, tool_output_chars: 10, repository_wide_scan_used: false, full_test_suite_used: false },
    known_risks: [],
    unresolved_questions: [],
    recommended_next_action: 'external_review',
  });

  const packed = await createTaskReviewPack('EXT-REVIEW-001', undefined, root) as { output: string };
  assert.ok(packed.output.startsWith(globalPaths().reviewPacks));
  assert.equal(await pathExists(packed.output), true);
  assert.equal(await pathExists(resolve(root, 'EXT-REVIEW-001.zip')), false);
});

test('project IDs cannot traverse AGENT_ROUTER_HOME or overwrite another repository identity', async () => {
  await isolatedHome();
  const first = await createRepo('git@example.invalid:team/first.git');
  const second = await createRepo('git@example.invalid:team/second.git');
  await assert.rejects(() => registerProject({ cwd: first, projectId: '../../escape' }), /Invalid project ID/);
  await registerProject({ cwd: first, projectId: 'shared-project' });
  await assert.rejects(
    () => registerProject({ cwd: second, projectId: 'shared-project' }),
    /different repository identity/,
  );
});
