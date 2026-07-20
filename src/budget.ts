import { resolve } from 'node:path';
import { pathExists, readJson } from './lib/fs.js';
import type { HandoffRecord } from './models.js';
import { resolveProjectRuntime } from './state.js';

export async function budgetShow(taskId: string, cwd?: string): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd);
  const handoffPath = resolve(runtime.stateRoot, 'handoffs', `${taskId}.json`);
  const contextPath = resolve(runtime.stateRoot, 'contexts', `${taskId}.json`);
  return {
    task_id: taskId,
    project_id: runtime.projectId,
    handoff_budget: (await pathExists(handoffPath)) ? (await readJson<HandoffRecord>(handoffPath)).budget : null,
    context: (await pathExists(contextPath)) ? await readJson(contextPath) : null,
  };
}

export async function budgetCheck(taskId: string, cwd?: string): Promise<{ ok: boolean; errors: string[] }> {
  const runtime = await resolveProjectRuntime(cwd);
  const handoffPath = resolve(runtime.stateRoot, 'handoffs', `${taskId}.json`);
  if (!(await pathExists(handoffPath))) return { ok: false, errors: ['handoff missing'] };
  const handoff = await readJson<HandoffRecord>(handoffPath);
  const errors: string[] = [];
  if (handoff.budget.repository_wide_scan_used) errors.push('repository-wide scan used');
  if (handoff.budget.full_test_suite_used) errors.push('full test suite used');
  if (handoff.budget.files_read !== handoff.files_read.length) errors.push('files_read mismatch');
  return { ok: errors.length === 0, errors };
}
