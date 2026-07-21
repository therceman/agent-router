import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ContextBundle, TaskRecord } from './models.js';
import { getTask, requireCanonicalTask, transitionTask } from './task.js';
import { loadAmendments, materializeEffectiveTaskContract, validateEffectiveTaskContract } from './amendment.js';
import { routeTask } from './router.js';
import { sha256, canonicalSha256 } from './lib/hash.js';
import { pathExists, readJson, writeJson } from './lib/fs.js';
import { safeProjectPath } from './lib/path.js';
import { resolveProjectRuntime } from './state.js';
import { ROLE_METADATA } from './config.js';
import { retireTaskAssignment, activeAssignmentPath, readSession, compatibilityKey, validateAssignment } from './session.js';
import { buildReviewPhase } from './phase.js';

const BINARY_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.bin', '.db', '.sqlite', '.png', '.jpg', '.jpeg', '.gif', '.pdf', '.exe', '.dll', '.so', '.dylib']);
function ext(path: string): string { const index = path.lastIndexOf('.'); return index >= 0 ? path.slice(index).toLowerCase() : ''; }
function forbidden(task: TaskRecord, path: string): string | null { const normalized = path.replaceAll('\\', '/'); for (const item of task.scope.forbidden_paths) { const f = item.replaceAll('\\', '/').replace(/\/$/, ''); if (normalized === f || normalized.startsWith(`${f}/`)) return `forbidden by task policy: ${item}`; } return BINARY_EXTENSIONS.has(ext(normalized)) ? 'binary or archive file excluded' : null; }

async function rebuildPrimaryContext(taskId: string, runtime: Awaited<ReturnType<typeof resolveProjectRuntime>>, task: TaskRecord, contract: ReturnType<typeof materializeEffectiveTaskContract>): Promise<ContextBundle> {
  const effective = { ...task, ...contract, state: task.state } as TaskRecord; const files: ContextBundle['files'] = []; const excluded: ContextBundle['excluded'] = []; let totalBytes = 0;
  if (!effective.scope.allowed_paths.length && !effective.budgets.repository_wide_scan) throw new Error('Task has no allowed paths and repository-wide scanning is disabled');
  if (effective.scope.allowed_paths.length > effective.budgets.maximum_files_read) throw new Error('Context file count exceeds budget');
  for (const rel of effective.scope.allowed_paths) {
    const blocked = forbidden(effective, rel); if (blocked) { excluded.push({ path: rel, reason: blocked }); continue; }
    try {
      const full = await safeProjectPath(runtime.repoRoot, rel); const info = await stat(full); if (!info.isFile()) { excluded.push({ path: rel, reason: 'not a regular file' }); continue; }
      if (info.size > effective.budgets.maximum_single_file_bytes) { excluded.push({ path: rel, reason: `single-file budget exceeded (${info.size})` }); continue; }
      const buffer = await readFile(full); if (buffer.includes(0)) { excluded.push({ path: rel, reason: 'binary content detected' }); continue; }
      totalBytes += buffer.byteLength; if (totalBytes > effective.budgets.maximum_context_bytes) throw new Error(`Context byte budget exceeded at ${rel}`); files.push({ path: rel, bytes: buffer.byteLength, sha256: sha256(buffer), excerpt: buffer.toString('utf8').slice(0, effective.budgets.maximum_single_file_bytes) });
    } catch (error) { if ((error as Error).message.startsWith('Context byte budget')) throw error; excluded.push({ path: rel, reason: (error as Error).message }); }
  }
  if (!files.length) throw new Error(`No eligible context files; exclusions: ${excluded.map((item) => `${item.path}: ${item.reason}`).join('; ')}`);
  const routePath = resolve(runtime.stateRoot, 'generated', `${taskId}.route.json`); const bundle: ContextBundle = { schema_version: 1, task_id: taskId, route_path: routePath, files, total_bytes: totalBytes, excluded, budget: effective.budgets, created_at: new Date().toISOString(), task_revision: task.revision ?? 1, effective_contract_sha256: task.effective_contract_sha256, phase: 'primary' };
  await writeJson(resolve(runtime.stateRoot, 'contexts', `${taskId}.json`), bundle); await writeJson(resolve(runtime.stateRoot, 'contexts/phases', taskId, 'primary.json'), bundle); return bundle;
}

export async function refreshTask(taskId: string, cwd?: string): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd); const found = await getTask(taskId, runtime.repoRoot); requireCanonicalTask(found.task, found.path); const amendments = await loadAmendments(runtime.stateRoot, taskId); const contract = materializeEffectiveTaskContract(found.task, amendments); validateEffectiveTaskContract(contract, undefined);
  const revision = found.task.revision ?? 1; const effectiveHash = found.task.effective_contract_sha256 ?? canonicalSha256(contract); const route = routeTask(found.task); const revisionRoute = { ...route, task_revision: revision, effective_contract_sha256: effectiveHash, phase: 'primary' as const, sandbox_mode: ROLE_METADATA[route.role as keyof typeof ROLE_METADATA]?.sandbox_mode ?? 'workspace-write', approval_policy: 'on-request' };
  if (!['ready', 'routed', 'context_ready'].includes(found.task.state) && found.task.derived_state_status !== 'stale') {
    const existingRoute = await readJson<Record<string, unknown>>(resolve(runtime.stateRoot, 'generated', `${taskId}.route.json`)).catch(() => null); if (existingRoute && canonicalSha256(existingRoute) === canonicalSha256(revisionRoute)) { /* keep current derived state */ }
  }
  const assignmentPath = activeAssignmentPath(runtime.stateRoot, taskId);
  if (await pathExists(assignmentPath)) { const existing = await readJson<import('./models.js').AssignmentRecord>(assignmentPath); validateAssignment(existing); if (existing.schema_version !== 2) throw new Error('Project state requires migration before refreshing an assignment. Run agent-router migrate --apply'); }
  await writeJson(resolve(runtime.stateRoot, 'generated', `${taskId}.route.json`), revisionRoute); await writeJson(resolve(runtime.stateRoot, 'generated/phases', taskId, 'primary.route.json'), revisionRoute);
  const context = await rebuildPrimaryContext(taskId, runtime, found.task, contract);
  const taskPath = found.path; const updated = { ...found.task, route_revision: revision, context_revision: revision, derived_state_status: 'current' as const, updated_at: new Date().toISOString() }; await writeJson(taskPath, updated);
  if (!(await pathExists(assignmentPath))) return { action: 'ready_for_acquire', task_id: taskId, task_revision: revision, route_sha256: canonicalSha256(revisionRoute), context_sha256: canonicalSha256(context) };
  const assignment = await readJson<import('./models.js').AssignmentRecord>(assignmentPath); const sessionFound = await readSession(runtime.stateRoot, assignment.session_id); const session = sessionFound.session;
  const reviewDerived = assignment.phase === 'review' ? await buildReviewPhase(taskId, assignment.role, runtime.repoRoot) : undefined;
  const currentRoute = reviewDerived?.route ?? revisionRoute;
  const currentContext = reviewDerived?.context ?? context;
  const expectedKey = compatibilityKey({ project_id: runtime.projectId, role: assignment.role, phase: assignment.phase ?? 'primary', provider: 'codex', provider_model: currentRoute.provider_model, reasoning: currentRoute.reasoning, repository_root: runtime.repoRoot, sandbox_mode: currentRoute.sandbox_mode, approval_policy: currentRoute.approval_policy });
  const compatible = session.compatibility_key === expectedKey && assignment.role === session.role && session.provider_model === currentRoute.provider_model && session.reasoning === currentRoute.reasoning;
  if (!compatible) {
    await retireTaskAssignment(taskId, runtime.repoRoot);
    const latest = (await getTask(taskId, runtime.repoRoot)).task;
    if (['in_progress', 'worker_complete', 'review_pending'].includes(latest.state)) await transitionTask(taskId, 'blocked', runtime.repoRoot, { reason: 'refresh-requires-reassignment', revision });
    return { action: 'reassign', reason: 'session_compatibility_changed', task_id: taskId, task_revision: revision };
  }
  assignment.sync_required = true; assignment.task_revision = revision; assignment.effective_contract_sha256 = effectiveHash; await writeJson(assignmentPath, assignment);
  return { action: 'sync', task_id: taskId, task_revision: revision, dispatch_message: `Execute:\nagent-router work sync ${taskId} --session ${session.session_id}`, route_sha256: canonicalSha256(currentRoute), context_sha256: canonicalSha256(currentContext) };
}
