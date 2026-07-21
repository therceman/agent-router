import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AssignmentPhase, ContextFile, PhaseContextRecord, PhaseRouteRecord, ReviewRecord, TaskRecord } from './models.js';
import { DEFAULT_MODEL_MAP, PROFILE_DEFINITIONS, ROLE_METADATA, type RoleId } from './config.js';
import { getTask } from './task.js';
import { loadAmendments, materializeEffectiveTaskContract } from './amendment.js';
import { canonicalSha256, sha256 } from './lib/hash.js';
import { pathExists, readJson, writeJson } from './lib/fs.js';
import { resolveProjectRuntime } from './state.js';

export function phaseName(phase: AssignmentPhase, role?: RoleId): string { return phase === 'primary' ? 'primary' : `review-${role ?? 'unknown'}`; }
export function phaseRoutePath(stateRoot: string, taskId: string, phase: AssignmentPhase, role?: RoleId): string { return resolve(stateRoot, 'generated/phases', taskId, `${phaseName(phase, role)}.route.json`); }
export function phaseContextPath(stateRoot: string, taskId: string, phase: AssignmentPhase, role?: RoleId): string { return resolve(stateRoot, 'contexts/phases', taskId, `${phaseName(phase, role)}.json`); }

export async function nextReviewRole(stateRoot: string, task: TaskRecord): Promise<RoleId | 'external_reviewer' | null> {
  for (const role of task.review.sequence) {
    const path = resolve(stateRoot, 'reviews', task.task_id, `${role}.json`);
    if (!(await pathExists(path))) return role as RoleId | 'external_reviewer';
    const review = await readJson<ReviewRecord>(path);
    if (!['accepted', 'accepted_with_followup'].includes(review.verdict)) return null;
  }
  return null;
}

export async function reviewCompletionStatus(stateRoot: string, task: TaskRecord): Promise<{ next: RoleId | 'external_reviewer' | null; complete: boolean }> {
  const next = await nextReviewRole(stateRoot, task); return { next, complete: next === null && task.review.sequence.length > 0 };
}

function modelClassFor(role: RoleId): PhaseRouteRecord['model_class'] {
  const key = DEFAULT_MODEL_MAP.roles[role as keyof typeof DEFAULT_MODEL_MAP.roles].model; return key;
}

function file(path: string, text: string): ContextFile { return { path, bytes: Buffer.byteLength(text), sha256: sha256(text), excerpt: text.slice(0, 50000) }; }

export async function buildReviewPhase(taskId: string, role: RoleId, cwd?: string): Promise<{ route: PhaseRouteRecord; context: PhaseContextRecord }> {
  const runtime = await resolveProjectRuntime(cwd); const found = await getTask(taskId, runtime.repoRoot); const task = found.task;
  if (!PROFILE_DEFINITIONS[task.profile].roles.includes(role) || !runtime.project.enabled_roles.includes(role)) throw new Error(`Review role ${role} is not authorized by project profile ${task.profile}`);
  const amendments = await loadAmendments(runtime.stateRoot, taskId); const contract = materializeEffectiveTaskContract(task, amendments); const revision = task.revision ?? 1; const effectiveHash = task.effective_contract_sha256 ?? canonicalSha256(contract);
  const model = DEFAULT_MODEL_MAP.roles[role as keyof typeof DEFAULT_MODEL_MAP.roles]; const route: PhaseRouteRecord = { schema_version: 1, task_id: taskId, task_revision: revision, effective_contract_sha256: effectiveHash, phase: 'review', role, model_class: modelClassFor(role), provider_model: DEFAULT_MODEL_MAP.models[model.model].provider_model, reasoning: model.reasoning, sandbox_mode: ROLE_METADATA[role].sandbox_mode, approval_policy: 'on-request', created_at: new Date().toISOString() };
  const reviews: Record<string, unknown> = {}; const reviewDir = resolve(runtime.stateRoot, 'reviews', taskId); if (await pathExists(reviewDir)) for (const name of (await readdir(reviewDir)).filter((item) => item.endsWith('.json')).sort()) reviews[name] = await readJson(resolve(reviewDir, name));
  const handoffPath = resolve(runtime.stateRoot, 'handoffs', `${taskId}.json`); const handoff = await pathExists(handoffPath) ? await readJson(handoffPath) : null;
  const contractText = JSON.stringify({ task_id: taskId, revision, effective_contract_sha256: effectiveHash, objective: contract.objective, acceptance: contract.acceptance, allowed_paths: contract.scope.allowed_paths, forbidden_paths: contract.scope.forbidden_paths, review_feedback: contract.review_feedback, required_changes: contract.required_changes }, null, 2);
  const handoffText = JSON.stringify(handoff, null, 2); const priorText = JSON.stringify(reviews, null, 2);
  const files = [file('__agent_router__/task-contract.json', contractText), file('__agent_router__/implementation-handoff.json', handoffText), file('__agent_router__/prior-reviews.json', priorText)];
  const context: PhaseContextRecord = { schema_version: 1, task_id: taskId, task_revision: revision, effective_contract_sha256: effectiveHash, phase: 'review', role, files, total_bytes: files.reduce((sum, item) => sum + item.bytes, 0), excluded: [], budget: contract.budgets, created_at: new Date().toISOString() };
  await writeJson(phaseRoutePath(runtime.stateRoot, taskId, 'review', role), route); await writeJson(phaseContextPath(runtime.stateRoot, taskId, 'review', role), context);
  return { route, context };
}

export async function readPhaseDerived(stateRoot: string, taskId: string, phase: AssignmentPhase, role?: RoleId): Promise<{ route: PhaseRouteRecord; context: PhaseContextRecord; routeHash: string; contextHash: string }> {
  const route = await readJson<PhaseRouteRecord>(phaseRoutePath(stateRoot, taskId, phase, role)); const context = await readJson<PhaseContextRecord>(phaseContextPath(stateRoot, taskId, phase, role));
  if (route.task_id !== taskId || context.task_id !== taskId || route.phase !== phase || context.phase !== phase || (role && route.role !== role) || (role && context.role !== role)) throw new Error('Phase route/context identity mismatch');
  if (route.task_revision !== context.task_revision || route.effective_contract_sha256 !== context.effective_contract_sha256) throw new Error('Phase route/context revision mismatch');
  return { route, context, routeHash: canonicalSha256(route), contextHash: canonicalSha256(context) };
}

export function phaseRouteFromPrimary(route: Record<string, unknown>, task: TaskRecord): PhaseRouteRecord {
  const role = String(route.role) as RoleId; const modelClass = String(route.model_class) as PhaseRouteRecord['model_class']; const reasoning = String(route.reasoning) as PhaseRouteRecord['reasoning'];
  return { schema_version: 1, task_id: task.task_id, task_revision: task.revision ?? 1, effective_contract_sha256: task.effective_contract_sha256 ?? '', phase: 'primary', role, model_class: modelClass, provider_model: String(route.provider_model), reasoning, sandbox_mode: ROLE_METADATA[role]?.sandbox_mode ?? 'workspace-write', approval_policy: String(route.approval_policy ?? 'on-request'), created_at: String(route.created_at ?? new Date().toISOString()) };
}
