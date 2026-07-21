import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ContextBundle, TaskRecord } from './models.js';
import { sha256 } from './lib/hash.js';
import { pathExists, readJson, writeJson } from './lib/fs.js';
import { safeProjectPath } from './lib/path.js';
import { getTask, requireCanonicalTask, transitionTask } from './task.js';

const BINARY_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.bin', '.db', '.sqlite', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.exe', '.dll', '.so', '.dylib']);

function extension(path: string): string {
  const i = path.lastIndexOf('.');
  return i >= 0 ? path.slice(i).toLowerCase() : '';
}

function isForbidden(task: TaskRecord, path: string): string | null {
  const normalized = path.replaceAll('\\', '/');
  for (const item of task.scope.forbidden_paths) {
    const f = item.replaceAll('\\', '/').replace(/\/$/, '');
    if (normalized === f || normalized.startsWith(`${f}/`)) return `forbidden by task policy: ${item}`;
  }
  if (BINARY_EXTENSIONS.has(extension(normalized))) return 'binary or archive file excluded';
  return null;
}

export async function buildContext(taskId: string, cwd?: string): Promise<ContextBundle> {
  const { root, stateRoot, path, task } = await getTask(taskId, cwd);
  requireCanonicalTask(task, path);
  if (task.state !== 'routed') throw new Error(`Task must be routed before context construction; current state is ${task.state}`);
  if (!task.scope.allowed_paths.length && !task.budgets.repository_wide_scan) throw new Error('Task has no allowed paths and repository-wide scanning is disabled');
  if (task.scope.allowed_paths.length > task.budgets.maximum_files_read) throw new Error('Context file count exceeds budget');
  const files: ContextBundle['files'] = [];
  const excluded: ContextBundle['excluded'] = [];
  let totalBytes = 0;
  for (const rel of task.scope.allowed_paths) {
    const forbidden = isForbidden(task, rel);
    if (forbidden) { excluded.push({ path: rel, reason: forbidden }); continue; }
    let full: string;
    try { full = await safeProjectPath(root, rel); }
    catch (error) { excluded.push({ path: rel, reason: (error as Error).message }); continue; }
    const info = await stat(full);
    if (!info.isFile()) { excluded.push({ path: rel, reason: 'not a regular file' }); continue; }
    if (info.size > task.budgets.maximum_single_file_bytes) { excluded.push({ path: rel, reason: `single-file budget exceeded (${info.size})` }); continue; }
    const buffer = await readFile(full);
    if (buffer.includes(0)) { excluded.push({ path: rel, reason: 'binary content detected' }); continue; }
    totalBytes += buffer.byteLength;
    if (totalBytes > task.budgets.maximum_context_bytes) throw new Error(`Context byte budget exceeded at ${rel}`);
    const text = buffer.toString('utf8');
    files.push({ path: rel, bytes: buffer.byteLength, sha256: sha256(buffer), excerpt: text.slice(0, task.budgets.maximum_single_file_bytes) });
  }
  if (!files.length) throw new Error(`No eligible context files; exclusions: ${excluded.map((e) => `${e.path}: ${e.reason}`).join('; ')}`);
  const routePath = resolve(stateRoot, 'generated', `${taskId}.route.json`);
  if (!(await pathExists(routePath))) throw new Error('Route record is missing');
  const bundle: ContextBundle = {
    schema_version: 1, task_id: taskId, route_path: routePath, files, total_bytes: totalBytes,
    excluded, budget: task.budgets, created_at: new Date().toISOString(), task_revision: task.revision ?? 1, effective_contract_sha256: task.effective_contract_sha256, phase: 'primary', role: undefined,
  };
  await writeJson(resolve(stateRoot, 'contexts', `${taskId}.json`), bundle);
  await writeJson(resolve(stateRoot, 'contexts/phases', taskId, 'primary.json'), bundle);
  const transitioned = await transitionTask(taskId, 'context_ready', root, { files: files.length, bytes: totalBytes });
  transitioned.context_revision = task.revision ?? 1; transitioned.route_revision = task.revision ?? 1; transitioned.derived_state_status = 'current';
  await writeJson(resolve(stateRoot, 'tasks/active', `${taskId}.json`), transitioned);
  return bundle;
}

export async function readContext(taskId: string, cwd?: string): Promise<ContextBundle> {
  const { stateRoot } = await getTask(taskId, cwd);
  const path = resolve(stateRoot, 'contexts', `${taskId}.json`);
  if (!(await pathExists(path))) throw new Error(`Context not found: ${taskId}`);
  return readJson<ContextBundle>(path);
}

export async function checkContext(taskId: string, cwd?: string): Promise<{ ok: boolean; errors: string[]; context: ContextBundle }> {
  const { task } = await getTask(taskId, cwd);
  const context = await readContext(taskId, cwd);
  const errors: string[] = [];
  if (context.files.length > task.budgets.maximum_files_read) errors.push('file count exceeds budget');
  if (context.total_bytes > task.budgets.maximum_context_bytes) errors.push('byte count exceeds budget');
  for (const file of context.files) if (file.bytes > task.budgets.maximum_single_file_bytes) errors.push(`${file.path} exceeds single-file budget`);
  return { ok: errors.length === 0, errors, context };
}
