import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { VERSION, } from './constants.js';
import { defaultSessionPolicy, policyForProfile } from './config.js';
import { resolveProjectRuntime } from './state.js';
import { listTasks, getTask, migrateTaskOnDisk, taskRequiresMigration } from './task.js';
import { ensureDir, pathExists, readJson, writeJson, backupFile } from './lib/fs.js';
import type { TaskRecord } from './models.js';
import type { AssignmentRecord } from './models.js';

const TASK_STATES_WITHOUT_ASSIGNMENT = new Set(['dispatched', 'in_progress', 'worker_complete', 'review_pending']);

async function rawTasks(stateRoot: string): Promise<Array<{ task: TaskRecord; path: string }>> {
  const dirs = ['draft', 'ready', 'active', 'review', 'blocked', 'done', 'cancelled']; const out: Array<{ task: TaskRecord; path: string }> = [];
  for (const dir of dirs) {
    const full = resolve(stateRoot, 'tasks', dir); if (!(await pathExists(full))) continue;
    for (const name of (await readdir(full)).filter((item) => item.endsWith('.json') || item.endsWith('.yaml')).sort()) out.push({ task: await readJson<TaskRecord>(resolve(full, name)), path: resolve(full, name) });
  }
  return out;
}

async function rawAssignments(stateRoot: string): Promise<Array<{ assignment: AssignmentRecord; path: string }>> {
  const out: Array<{ assignment: AssignmentRecord; path: string }> = [];
  const roots = [resolve(stateRoot, 'assignments/active'), resolve(stateRoot, 'assignments/history')];
  for (const root of roots) {
    if (!(await pathExists(root))) continue;
    const pending: string[] = [root];
    while (pending.length) {
      const current = pending.pop()!;
      for (const name of await readdir(current)) {
        const path = resolve(current, name); if (name.endsWith('.json')) { out.push({ assignment: await readJson<AssignmentRecord>(path), path }); continue; }
        if (name.includes('.') || !(await pathExists(path))) continue; pending.push(path);
      }
    }
  }
  return out;
}

export async function migrateProject(options: { cwd?: string; from?: string; to?: string; check?: boolean; apply?: boolean } = {}): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(options.cwd); const from = options.from ?? '0.8.0'; const to = options.to ?? VERSION; if (!['0.7.0', '0.8.0'].includes(from) || to !== VERSION) throw new Error(`Unsupported migration: ${from} -> ${to}`);
  const changes: string[] = []; const backups: string[] = [];
  const expectedDirs = [
    'tasks/amendments', 'sessions/active', 'sessions/retired', 'assignments/active', 'assignments/history', 'locks',
    'generated/phases', 'contexts/phases', 'provider-actions/pending', 'provider-actions/history', 'transactions',
  ];
  for (const dir of expectedDirs) if (!(await pathExists(resolve(runtime.stateRoot, dir)))) changes.push(dir);
  const policyPath = resolve(runtime.stateRoot, 'policy.yaml'); const policy = (await pathExists(policyPath) ? await readJson<Record<string, unknown>>(policyPath) : policyForProfile(runtime.project.profile)); if (!policy.session_policy) changes.push('policy.yaml:session_policy');
  const raw = await rawTasks(runtime.stateRoot); const taskChanges: string[] = [];
  for (const item of raw) {
    const current = item.task;
    if (current.schema_version === 1 || !current.revision || !current.effective_contract_sha256 || item.path.endsWith('.yaml')) taskChanges.push(current.task_id);
    if (TASK_STATES_WITHOUT_ASSIGNMENT.has(current.state) && !current.last_assignment_id && !current.legacy_unassigned) taskChanges.push(`${current.task_id}:legacy_unassigned`);
  }
  changes.push(...taskChanges.map((item) => `task:${item}`));
  const assignments = await rawAssignments(runtime.stateRoot); changes.push(...assignments.filter((item) => item.assignment.schema_version === 1).map((item) => `assignment:${item.assignment.assignment_id}`));
  const plan = { from, to, project_id: runtime.projectId, state_root: runtime.stateRoot, changes: [...new Set(changes)], work_repository_writes: [], rollback: 'Restore the listed Agent Router backups; no work-repository files are modified.' };
  if (options.check || !options.apply) return { ...plan, applied: false, dry_run: true };
  for (const dir of expectedDirs) await ensureDir(resolve(runtime.stateRoot, dir));
  if (changes.includes('policy.yaml:session_policy')) { const existing = await backupFile(policyPath); if (existing) backups.push(existing); await writeJson(policyPath, { ...policy, session_policy: defaultSessionPolicy() }); }
  for (const item of raw) if (taskRequiresMigration(item.task, item.path)) { const backup = await backupFile(item.path); if (backup) backups.push(backup); }
  for (const item of assignments) if (item.assignment.schema_version === 1) { const backup = await backupFile(item.path); if (backup) backups.push(backup); }
  const tasks = await listTasks(runtime.repoRoot);
  for (const taskId of tasks.map((task) => task.task_id)) {
    const migrated = await migrateTaskOnDisk(runtime.stateRoot, taskId); const current = migrated.task; const found = await getTask(taskId, runtime.repoRoot);
    if (TASK_STATES_WITHOUT_ASSIGNMENT.has(current.state) && !current.last_assignment_id) { current.legacy_unassigned = true; await writeJson(found.path, current); }
  }
  for (const item of assignments) if (item.assignment.schema_version === 1) {
    const task = (await getTask(item.assignment.task_id, runtime.repoRoot)).task;
    const workStatus: AssignmentRecord['work_status'] = item.assignment.status === 'acknowledged' ? 'acknowledged' : item.assignment.status === 'completed' ? 'completed' : item.assignment.status === 'blocked' ? 'blocked' : item.assignment.status === 'relinquished' ? 'relinquished' : item.assignment.status === 'stale' ? 'stale' : item.assignment.status === 'cancelled' ? 'cancelled' : 'reserved';
    const migrated: AssignmentRecord = { ...item.assignment, schema_version: 2, phase: 'primary', effective_contract_sha256: task.effective_contract_sha256, transport_status: item.assignment.status === 'pending_transport' ? 'pending' : 'succeeded', work_status: workStatus, sync_required: false };
    await writeJson(item.path, migrated);
  }
  return { ...plan, applied: true, backups };
}

export async function migrationCheck(cwd?: string): Promise<Record<string, unknown>> { return migrateProject({ cwd, check: true }); }
