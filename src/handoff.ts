import { resolve } from 'node:path';
import type { HandoffRecord } from './models.js';
import { pathExists, readJson, writeJson } from './lib/fs.js';
import { getTask, transitionTask } from './task.js';
import { assertRelativeProjectPath } from './lib/path.js';

export function validateHandoffRecord(record: HandoffRecord, taskId: string, allowedPaths?: string[]): void {
  if (record.schema_version !== 1 || record.task_id !== taskId || record.status !== 'worker_complete') throw new Error('Invalid handoff identity or status');
  if (record.agent.role === 'main') throw new Error('Main session cannot submit implementation handoff');
  if (!record.tests.length) throw new Error('Handoff must contain targeted test results');
  if (record.tests.some((test) => test.exit_code !== 0 || (test.failed ?? 0) > 0)) throw new Error('Handoff contains failing tests');
  if (record.manual_checks.some((check) => check.result === 'failed')) throw new Error('Handoff contains failed manual checks');
  if (record.budget.repository_wide_scan_used || record.budget.full_test_suite_used) throw new Error('Worker exceeded restricted execution policy');
  if (record.budget.files_read !== record.files_read.length) throw new Error('Handoff budget file count does not match files_read');
  for (const path of [...record.files_read, ...record.files_changed]) assertRelativeProjectPath(path);
  if (allowedPaths?.length) {
    const allowed = new Set(allowedPaths);
    const outside = record.files_changed.filter((path) => !allowed.has(path));
    if (outside.length) throw new Error(`Worker changed files outside task scope: ${outside.join(', ')}`);
  }
}

export async function validateHandoff(taskId: string, cwd?: string): Promise<HandoffRecord> {
  const { root, stateRoot, task } = await getTask(taskId, cwd);
  if (!['dispatched', 'in_progress', 'worker_complete'].includes(task.state)) throw new Error(`Task is not awaiting a handoff; current state is ${task.state}`);
  const path = resolve(stateRoot, 'handoffs', `${taskId}.json`);
  if (!(await pathExists(path))) throw new Error(`Handoff file is missing: ${path}`);
  const record = await readJson<HandoffRecord>(path);
  validateHandoffRecord(record, taskId, task.scope.allowed_paths);
  if (task.state !== 'worker_complete') await transitionTask(taskId, 'worker_complete', root, { changed_files: record.files_changed.length });
  return record;
}

export async function readHandoff(taskId: string, cwd?: string): Promise<HandoffRecord> {
  const { stateRoot } = await getTask(taskId, cwd);
  return readJson<HandoffRecord>(resolve(stateRoot, 'handoffs', `${taskId}.json`));
}
export async function createHandoff(taskId: string, inputFile: string, cwd?: string): Promise<HandoffRecord> {
  const { stateRoot, task } = await getTask(taskId, cwd);
  if (!['dispatched', 'in_progress'].includes(task.state)) throw new Error(`Task is not accepting a new handoff; current state is ${task.state}`);
  const record = await readJson<HandoffRecord>(inputFile);
  validateHandoffRecord(record, taskId, task.scope.allowed_paths);
  await writeJson(resolve(stateRoot, 'handoffs', `${taskId}.json`), record);
  return record;
}

export async function completeHandoff(taskId: string, inputFile?: string, cwd?: string): Promise<{ handoff: HandoffRecord; task: import('./models.js').TaskRecord }> {
  if (inputFile) await createHandoff(taskId, inputFile, cwd);
  const handoff = await validateHandoff(taskId, cwd);
  const { task } = await getTask(taskId, cwd);
  return { handoff, task };
}
