import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ContextBundle, ReviewRecord } from './models.js';
import { pathExists, readJson, writeJson, ensureDir } from './lib/fs.js';
import { run, runChecked } from './lib/process.js';
import { getTask, requireCanonicalTask, transitionTask } from './task.js';
import { readHandoff } from './handoff.js';
import { createZip, type ZipEntry } from './zip.js';
import { scanSecrets } from './secret.js';
import { sha256 } from './lib/hash.js';
import { PROFILE_DEFINITIONS, globalPaths } from './config.js';

export type ReviewPackPurpose = 'implementation' | 'security' | 'research';

function safeRole(role: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(role)) throw new Error(`Invalid review role: ${role}`);
  return role;
}

export function validateReviewRecord(review: ReviewRecord, taskId: string): void {
  if (review.schema_version !== 1 || review.task_id !== taskId) throw new Error('Review task identity mismatch');
  const allowed = new Set(['schema_version', 'task_id', 'reviewer', 'verdict', 'acceptance_criteria', 'tests_verified', 'manual_checks_verified', 'scope_verified', 'unrelated_changes_found', 'false_success_paths_found', 'required_followups', 'risks', 'findings', 'required_changes']);
  const unknown = Object.keys(review as unknown as Record<string, unknown>).filter((key) => !allowed.has(key)); if (unknown.length) throw new Error(`Review contains unknown field(s): ${unknown.join(', ')}`);
  if (!['accepted', 'rejected', 'accepted_with_followup', 'blocked', 'architect_review_required', 'critical_review_required'].includes(review.verdict)) throw new Error('Invalid review verdict');
  if (review.reviewer.role === 'implementation_worker') throw new Error('Implementation worker cannot review its own work');
  safeRole(review.reviewer.role); if (typeof review.reviewer.role !== 'string' || !review.reviewer.role.trim()) throw new Error('Review reviewer role is required');
  if (!Array.isArray(review.required_followups) || !Array.isArray(review.risks)) throw new Error('Review arrays are required');
  for (const value of [...review.required_followups, ...review.risks, ...(review.findings ?? []), ...(review.required_changes ?? [])]) if (typeof value !== 'string' || !value.trim()) throw new Error('Review narrative arrays must contain non-empty strings');
  if (review.acceptance_criteria) for (const criterion of review.acceptance_criteria) { if (!criterion || typeof criterion.criterion !== 'string' || !criterion.criterion.trim() || !['passed', 'failed'].includes(criterion.result)) throw new Error('Review acceptance criteria are invalid'); }
}

async function loadReviews(stateRoot: string, taskId: string): Promise<Record<string, ReviewRecord>> {
  const dir = resolve(stateRoot, 'reviews', taskId);
  if (!(await pathExists(dir))) return {};
  const out: Record<string, ReviewRecord> = {};
  for (const name of (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    const review = await readJson<ReviewRecord>(resolve(dir, name));
    out[review.reviewer.role] = review;
  }
  return out;
}

export async function importReview(taskId: string, reviewFile: string, cwd?: string): Promise<ReviewRecord> {
  const { root, stateRoot, path: taskPath, task } = await getTask(taskId, cwd);
  requireCanonicalTask(task, taskPath);
  if (!['worker_complete', 'review_pending'].includes(task.state)) throw new Error(`Task must be worker_complete or review_pending before review import; current state is ${task.state}`);
  const review = await readJson<ReviewRecord>(resolve(reviewFile));
  validateReviewRecord(review, taskId);
  const role = safeRole(review.reviewer.role);
  if (!task.review.required_roles.includes(role)) throw new Error(`Review role ${role} is not required for task ${taskId}; required: ${task.review.required_roles.join(', ') || 'none'}`);
  const existing = await loadReviews(stateRoot, taskId);
  const roleIndex = task.review.sequence.indexOf(role);
  const missingEarlier = task.review.sequence.slice(0, roleIndex).filter((requiredRole) => {
    const prior = existing[requiredRole];
    return !prior || !['accepted', 'accepted_with_followup'].includes(prior.verdict);
  });
  if (missingEarlier.length) throw new Error(`Review sequence violation; complete first: ${missingEarlier.join(', ')}`);
  await ensureDir(resolve(stateRoot, 'reviews', taskId));
  await writeJson(resolve(stateRoot, 'reviews', taskId, `${role}.json`), review);
  if (review.verdict === 'rejected') {
    await transitionTask(taskId, 'rejected', root, { verdict: review.verdict, role });
    if (task.last_session_id) await import('./session.js').then(({ markSessionRejected }) => markSessionRejected(task.last_session_id!, root));
  } else if (review.verdict === 'blocked' || review.verdict === 'architect_review_required' || review.verdict === 'critical_review_required') {
    await transitionTask(taskId, 'blocked', root, { verdict: review.verdict, role });
  } else if (task.state === 'worker_complete') {
    await transitionTask(taskId, 'review_pending', root, { verdict: review.verdict, role });
  }
  return review;
}

export async function reviewStatus(taskId: string, cwd?: string): Promise<Record<string, unknown>> {
  const { stateRoot, task } = await getTask(taskId, cwd);
  const reviews = await loadReviews(stateRoot, taskId);
  const completed = task.review.required_roles.filter((role) => ['accepted', 'accepted_with_followup'].includes(reviews[role]?.verdict ?? ''));
  const pending = task.review.required_roles.filter((role) => !completed.includes(role));
  return { task_id: taskId, task_state: task.state, sequence: task.review.sequence, completed, pending, reviews };
}

function safeEntry(path: string, data: string | Buffer): ZipEntry {
  const findings = scanSecrets(data.toString('utf8'));
  if (findings.length) throw new Error(`Secret-like content detected in ${path}: ${findings.join(', ')}`);
  return { name: path.replaceAll('\\', '/'), data: Buffer.isBuffer(data) ? data : Buffer.from(data) };
}

function snippetName(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\/+/, '').replace(/[^A-Za-z0-9._/-]/g, '_');
}

export async function createTaskReviewPack(taskId: string, output?: string, cwd?: string, purpose?: ReviewPackPurpose): Promise<Record<string, unknown>> {
  const { root, stateRoot, projectId, task } = await getTask(taskId, cwd);
  const handoff = await readHandoff(taskId, root);
  const routePath = resolve(stateRoot, 'generated', `${taskId}.route.json`);
  const contextPath = resolve(stateRoot, 'contexts', `${taskId}.json`);
  const profilePurpose = PROFILE_DEFINITIONS[task.profile].review_pack_purpose;
  const resolvedPurpose = purpose ?? profilePurpose;
  const entries: ZipEntry[] = [];
  entries.push(safeEntry('task.json', `${JSON.stringify(task, null, 2)}\n`));
  entries.push(safeEntry('review-purpose.json', `${JSON.stringify({ purpose: resolvedPurpose, profile: task.profile, required_review_roles: task.review.required_roles }, null, 2)}\n`));
  if (await pathExists(routePath)) entries.push(safeEntry('route.json', await readFile(routePath)));
  if (await pathExists(contextPath)) {
    const context = await readJson<ContextBundle>(contextPath);
    entries.push(safeEntry('context-summary.json', `${JSON.stringify({ files: context.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })), total_bytes: context.total_bytes, excluded: context.excluded }, null, 2)}\n`));
    if (resolvedPurpose === 'security' || resolvedPurpose === 'research') {
      for (const file of context.files) {
        entries.push(safeEntry(`review-snippets/${snippetName(file.path)}.txt`, `PATH: ${file.path}\nSHA256: ${file.sha256}\n\n${file.excerpt}`));
      }
    }
  }
  entries.push(safeEntry('handoff.json', `${JSON.stringify(handoff, null, 2)}\n`));
  const priorReviews = await loadReviews(stateRoot, taskId);
  for (const [role, review] of Object.entries(priorReviews)) entries.push(safeEntry(`reviews/${role}.json`, `${JSON.stringify(review, null, 2)}\n`));
  const diff = run('git', ['diff', '--binary', '--', ...handoff.files_changed], root);
  entries.push(safeEntry('diff.patch', diff.stdout));
  const stat = run('git', ['diff', '--stat', '--', ...handoff.files_changed], root);
  entries.push(safeEntry('diff-stat.txt', stat.stdout));
  for (const rel of handoff.files_changed) {
    const full = resolve(root, rel);
    if (await pathExists(full)) entries.push(safeEntry(`changed-files/${rel}`, await readFile(full)));
  }
  const manifest = {
    schema_version: 1,
    task_id: taskId,
    project_id: projectId,
    profile: task.profile,
    purpose: resolvedPurpose,
    repository_root_redacted: true,
    git_head: run('git', ['rev-parse', 'HEAD'], root).stdout.trim() || null,
    files: entries.map((entry) => ({ path: entry.name, bytes: entry.data.length, sha256: sha256(entry.data) })),
    created_at: new Date().toISOString(),
  };
  entries.unshift(safeEntry('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`));
  const suffix = resolvedPurpose === 'implementation' ? '' : `-${resolvedPurpose}`;
  const outputPath = resolve(output ?? resolve(globalPaths().reviewPacks, projectId, `${taskId}${suffix}.zip`));
  await createZip(outputPath, entries);
  return { task_id: taskId, project_id: projectId, profile: task.profile, purpose: resolvedPurpose, output: outputPath, files: entries.length, bytes: entries.reduce((sum, entry) => sum + entry.data.length, 0) };
}

export async function createProjectReviewPack(input: { base: string; head: string; output: string; cwd?: string }): Promise<Record<string, unknown>> {
  const { root } = await getTaskOrRoot(input.cwd);
  const names = runChecked('git', ['diff', '--name-only', input.base, input.head], root).split(/\r?\n/).filter(Boolean);
  const blocked = names.filter((name) => name.startsWith('.git/') || name.includes('node_modules/') || name.includes('/.env') || name.endsWith('.env'));
  if (blocked.length) throw new Error(`Review range contains excluded paths: ${blocked.join(', ')}`);
  const entries: ZipEntry[] = [];
  entries.push(safeEntry('diff.patch', runChecked('git', ['diff', '--binary', input.base, input.head], root)));
  entries.push(safeEntry('diff-stat.txt', runChecked('git', ['diff', '--stat', input.base, input.head], root)));
  for (const rel of names) {
    const result = run('git', ['show', `${input.head}:${rel}`], root);
    if (result.status === 0) entries.push(safeEntry(`changed-files/${rel}`, result.stdout));
  }
  const manifest = { schema_version: 1, base: input.base, head: input.head, files: entries.map((entry) => ({ path: entry.name, bytes: entry.data.length, sha256: sha256(entry.data) })), created_at: new Date().toISOString() };
  entries.unshift(safeEntry('manifest.json', `${JSON.stringify(manifest, null, 2)}\n`));
  await createZip(resolve(input.output), entries);
  return { output: resolve(input.output), changed_files: names.length, packed_files: entries.length };
}

async function getTaskOrRoot(cwd?: string): Promise<{ root: string }> {
  const { findGitRoot } = await import('./lib/path.js');
  return { root: await findGitRoot(cwd) };
}
