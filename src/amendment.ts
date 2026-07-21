import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { TaskAmendmentRecord, TaskContract, TaskRecord } from './models.js';
import type { ProfileDefinition, RoleId } from './config.js';
import { PROFILE_DEFINITIONS } from './config.js';
import { getTask, requireCanonicalTask, validateTask } from './task.js';
import { appendEvent } from './events.js';
import { canonicalSha256 } from './lib/hash.js';
import { pathExists, readJson, withFileLock, writeJson } from './lib/fs.js';
import { assertRelativeProjectPath } from './lib/path.js';

const AMENDMENT_KINDS = ['owner_change', 'scope_change', 'acceptance_change', 'test_change', 'review_feedback', 'retry', 'clarification'] as const;
const SOURCES = ['owner', 'external_chatgpt', 'main', 'verifier', 'security_reviewer', 'critical_reviewer', 'system'] as const;

function revisionOf(task: TaskRecord): number { return task.revision ?? 1; }

export function taskContract(task: TaskRecord): TaskContract & { review_feedback: string[]; required_changes: string[]; notes: string[] } {
  return {
    task_id: task.task_id, title: task.title, profile: task.profile, objective: task.objective,
    ...(task.plan_ref ? { plan_ref: task.plan_ref } : {}),
    task_profile: task.task_profile,
    scope: { allowed_paths: [...task.scope.allowed_paths], forbidden_paths: [...task.scope.forbidden_paths] },
    budgets: { ...task.budgets },
    acceptance: [...task.acceptance],
    tests: { targeted: [...task.tests.targeted], checkpoint: [...task.tests.checkpoint] },
    manual_verification: [...task.manual_verification], outputs: [...task.outputs],
    review: { required: task.review.required, required_roles: [...task.review.required_roles], sequence: [...task.review.sequence] },
    review_feedback: [], required_changes: [], notes: [],
  };
}

function normalizeItems(items: string[] | undefined, field: string): string[] | undefined {
  if (items === undefined) return undefined;
  if (!Array.isArray(items) || items.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`Invalid amendment ${field}`);
  const result = [...new Set(items.map((item) => item.trim()))];
  if (result.length !== items.length) throw new Error(`Duplicate amendment values in ${field}`);
  return result;
}

function validatePathItems(items: string[] | undefined, field: string): void {
  for (const item of normalizeItems(items, field) ?? []) {
    assertRelativeProjectPath(item);
    const normalized = item.replaceAll('\\', '/');
    if (field.endsWith('_add') && (normalized === '.agent-router' || normalized.startsWith('.agent-router/') || normalized === '.codex' || normalized.startsWith('.codex/'))) {
      throw new Error(`Agent Router internal path is forbidden in amendment ${field}: ${item}`);
    }
  }
}

function applyArray(target: string[], add: string[] | undefined, remove: string[] | undefined, field: string): string[] {
  const additions = normalizeItems(add, `${field}_add`) ?? [];
  const removals = normalizeItems(remove, `${field}_remove`) ?? [];
  for (const item of removals) if (!target.includes(item)) throw new Error(`Cannot remove missing ${field}: ${item}`);
  const next = target.filter((item) => !removals.includes(item));
  for (const item of additions) if (next.includes(item)) throw new Error(`Duplicate amendment addition in ${field}: ${item}`);
  return [...next, ...additions];
}

export function validateAmendment(record: TaskAmendmentRecord, taskId?: string): void {
  if (record.schema_version !== 1 || (taskId && record.task_id !== taskId)) throw new Error('Invalid amendment identity');
  if (!/^AMD-[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(record.amendment_id)) throw new Error(`Invalid amendment ID: ${record.amendment_id}`);
  if (!Number.isInteger(record.from_revision) || record.from_revision < 1 || record.to_revision !== record.from_revision + 1) throw new Error('Amendment revisions must increment by exactly one');
  if (!AMENDMENT_KINDS.includes(record.amendment_kind)) throw new Error(`Invalid amendment kind: ${record.amendment_kind}`);
  if (!SOURCES.includes(record.source)) throw new Error(`Invalid amendment source: ${record.source}`);
  const changes = record.changes;
  const keys = Object.keys(changes);
  if (!keys.length) throw new Error('Amendment cannot be empty');
  if (changes.objective !== undefined && (typeof changes.objective !== 'string' || !changes.objective.trim())) throw new Error('Amendment objective must be non-empty');
  for (const field of ['allowed_paths', 'forbidden_paths'] as const) {
    validatePathItems(changes[`${field}_add`], `${field}_add`);
    validatePathItems(changes[`${field}_remove`], `${field}_remove`);
  }
  for (const field of ['acceptance', 'targeted_tests', 'checkpoint_tests', 'manual_verification'] as const) {
    normalizeItems(changes[`${field}_add`], `${field}_add`);
    normalizeItems(changes[`${field}_remove`], `${field}_remove`);
  }
  for (const field of ['review_feedback', 'required_changes', 'notes'] as const) if (changes[field] && !changes[field]!.length) throw new Error(`${field} cannot be empty`);
  if (!/^[a-f0-9]{64}$/.test(record.previous_contract_sha256) || !/^[a-f0-9]{64}$/.test(record.resulting_contract_sha256)) throw new Error('Amendment contract hashes must be SHA-256 hex');
  if (typeof record.created_at !== 'string' || !Number.isFinite(Date.parse(record.created_at))) throw new Error('Invalid amendment timestamp');
}

export function applyAmendment(contract: ReturnType<typeof taskContract>, amendment: TaskAmendmentRecord): ReturnType<typeof taskContract> {
  const changes = amendment.changes;
  const next = structuredClone(contract) as ReturnType<typeof taskContract>;
  if (changes.objective !== undefined) next.objective = changes.objective;
  next.scope.allowed_paths = applyArray(next.scope.allowed_paths, changes.allowed_paths_add, changes.allowed_paths_remove, 'allowed_paths');
  next.scope.forbidden_paths = applyArray(next.scope.forbidden_paths, changes.forbidden_paths_add, changes.forbidden_paths_remove, 'forbidden_paths');
  next.acceptance = applyArray(next.acceptance, changes.acceptance_add, changes.acceptance_remove, 'acceptance');
  next.tests.targeted = applyArray(next.tests.targeted, changes.targeted_tests_add, changes.targeted_tests_remove, 'targeted_tests');
  next.tests.checkpoint = applyArray(next.tests.checkpoint, changes.checkpoint_tests_add, changes.checkpoint_tests_remove, 'checkpoint_tests');
  next.manual_verification = applyArray(next.manual_verification, changes.manual_verification_add, changes.manual_verification_remove, 'manual_verification');
  next.review_feedback = [...next.review_feedback, ...(normalizeItems(changes.review_feedback, 'review_feedback') ?? [])];
  next.required_changes = [...next.required_changes, ...(normalizeItems(changes.required_changes, 'required_changes') ?? [])];
  next.notes = [...next.notes, ...(normalizeItems(changes.notes, 'notes') ?? [])];
  // Forbidden paths have priority in the effective contract.
  next.scope.allowed_paths = next.scope.allowed_paths.filter((item) => !next.scope.forbidden_paths.includes(item));
  return next;
}

export function validateEffectiveTaskContract(contract: ReturnType<typeof taskContract>, projectPolicy?: Record<string, unknown>, profileDefinition?: ProfileDefinition): void {
  if (!contract.task_id || !contract.title.trim() || !contract.objective.trim()) throw new Error('Effective task contract requires task identity, title, and objective');
  if (!PROFILE_DEFINITIONS[contract.profile]) throw new Error(`Effective task contract has an invalid profile: ${contract.profile}`);
  for (const [key, max] of Object.entries({ ambiguity: 3, semantic_complexity: 3, security_criticality: 4, blast_radius: 3, novelty: 3, verification_strength: 3, context_scope: 3, destructive_potential: 3, historical_data_impact: 3 })) { const value = contract.task_profile[key as keyof typeof contract.task_profile] as number; if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`Invalid effective task profile field ${key}`); }
  const stringList = (items: unknown, label: string): string[] => { if (!Array.isArray(items) || items.some((item) => typeof item !== 'string' || !item.trim())) throw new Error(`Effective contract ${label} must be a string array`); return items as string[]; };
  const uniqueList = (items: string[], label: string): void => { if (new Set(items).size !== items.length) throw new Error(`Effective contract ${label} contains duplicates`); };
  const allowedPaths = stringList(contract.scope.allowed_paths, 'allowed_paths'); const forbiddenPaths = stringList(contract.scope.forbidden_paths, 'forbidden_paths'); uniqueList(allowedPaths, 'allowed_paths'); uniqueList(forbiddenPaths, 'forbidden_paths');
  const normalizedForbidden = contract.scope.forbidden_paths.map((item) => item.replaceAll('\\', '/').replace(/\/$/, ''));
  for (const path of contract.scope.allowed_paths) { assertRelativeProjectPath(path); const normalized = path.replaceAll('\\', '/'); if (normalized === '.agent-router' || normalized.startsWith('.agent-router/') || normalized === '.codex' || normalized.startsWith('.codex/')) throw new Error(`Effective contract contains an internal path: ${path}`); }
  for (const path of contract.scope.forbidden_paths) assertRelativeProjectPath(path);
  if (contract.scope.allowed_paths.some((path) => normalizedForbidden.includes(path.replaceAll('\\', '/')))) throw new Error('Forbidden paths must override allowed paths');
  if (!Number.isInteger(contract.budgets.maximum_files_read) || contract.budgets.maximum_files_read < 0 || !Number.isInteger(contract.budgets.maximum_context_bytes) || contract.budgets.maximum_context_bytes < 1 || !Number.isInteger(contract.budgets.maximum_single_file_bytes) || contract.budgets.maximum_single_file_bytes < 1 || !Number.isInteger(contract.budgets.maximum_tool_output_chars) || contract.budgets.maximum_tool_output_chars < 1) throw new Error('Effective contract contains invalid context budgets');
  if (allowedPaths.length > contract.budgets.maximum_files_read) throw new Error('Effective contract exceeds maximum file budget');
  stringList(contract.acceptance, 'acceptance'); stringList(contract.tests.targeted, 'targeted tests'); stringList(contract.tests.checkpoint, 'checkpoint tests'); stringList(contract.manual_verification, 'manual verification'); stringList(contract.outputs, 'outputs');
  for (const key of ['repository_wide_scan', 'full_test_suite', 'recursive_delegation'] as const) if (typeof contract.budgets[key] !== 'boolean') throw new Error(`Effective contract budget ${key} must be boolean`);
  if (typeof contract.review.required !== 'boolean') throw new Error('Effective contract review.required must be boolean');
  const requiredRoles = stringList(contract.review.required_roles, 'required review roles'); const sequence = stringList(contract.review.sequence, 'review sequence'); uniqueList(sequence, 'review sequence');
  if (requiredRoles.join('|') !== sequence.join('|')) throw new Error('Effective contract review sequence is invalid');
  if (!contract.review.required && sequence.length) throw new Error('Effective contract cannot have review roles when review is disabled');
  if (contract.review.required && !sequence.length) throw new Error('Effective contract requires at least one review role');
  const definition = profileDefinition ?? PROFILE_DEFINITIONS[contract.profile];
  const authorized = new Set(definition.roles);
  for (const role of contract.review.sequence) if (role !== 'external_reviewer' && !authorized.has(role as RoleId)) throw new Error(`Effective contract review role is not authorized: ${role}`);
  if (projectPolicy?.workflow && typeof projectPolicy.workflow === 'object') {
    const required = (projectPolicy.workflow as Record<string, unknown>).required_review_roles;
    if (Array.isArray(required) && required.some((role) => typeof role !== 'string')) throw new Error('Project review policy is invalid');
  }
}

export async function loadAmendments(stateRoot: string, taskId: string): Promise<TaskAmendmentRecord[]> {
  const dir = resolve(stateRoot, 'tasks/amendments', taskId);
  if (!(await pathExists(dir))) return [];
  const names = (await readdir(dir)).filter((name) => /^\d{4}\.json$/.test(name)).sort();
  const records: TaskAmendmentRecord[] = [];
  for (const name of names) {
    const record = await readJson<TaskAmendmentRecord>(resolve(dir, name));
    validateAmendment(record, taskId);
    const expected = String(record.to_revision).padStart(4, '0');
    if (name !== `${expected}.json`) throw new Error(`Amendment filename does not match revision: ${name}`);
    records.push(record);
  }
  return records;
}

export function materializeEffectiveTaskContract(task: TaskRecord, amendments: TaskAmendmentRecord[]): ReturnType<typeof taskContract> {
  let contract = taskContract(task);
  let expectedRevision = 1;
  let previousHash = canonicalSha256(contract);
  for (const amendment of [...amendments].sort((a, b) => a.to_revision - b.to_revision)) {
    validateAmendment(amendment, task.task_id);
    if (amendment.from_revision !== expectedRevision || amendment.to_revision !== expectedRevision + 1) throw new Error(`Amendment revision gap for ${task.task_id}`);
    if (amendment.previous_contract_sha256 !== previousHash) throw new Error(`Amendment hash-chain mismatch at revision ${amendment.to_revision}`);
    contract = applyAmendment(contract, amendment);
    const resulting = canonicalSha256(contract);
    if (resulting !== amendment.resulting_contract_sha256) throw new Error(`Amendment resulting hash mismatch at revision ${amendment.to_revision}`);
    previousHash = resulting;
    expectedRevision = amendment.to_revision;
  }
  const current = revisionOf(task);
  if (current !== expectedRevision) throw new Error(`Task revision ${current} does not match amendment chain ${expectedRevision}`);
  if (task.effective_contract_sha256 && task.effective_contract_sha256 !== previousHash) throw new Error('Task effective contract hash does not match amendment chain');
  validateEffectiveTaskContract(contract);
  return contract;
}

export async function createTaskAmendment(input: {
  taskId: string; cwd?: string; amendmentKind: TaskAmendmentRecord['amendment_kind']; source: TaskAmendmentRecord['source']; changes: TaskAmendmentRecord['changes']; sourceReviewRole?: string; sourceReviewSha256?: string;
}): Promise<TaskAmendmentRecord> {
  const found = await getTask(input.taskId, input.cwd);
  requireCanonicalTask(found.task, found.path);
  return withFileLock(resolve(found.stateRoot, 'locks', `task-${input.taskId}.lock`), { command: 'task amend', project_id: found.projectId }, async () => {
    const currentFound = await getTask(input.taskId, input.cwd);
    const amendments = await loadAmendments(currentFound.stateRoot, input.taskId);
    const currentRevision = revisionOf(currentFound.task);
    const contract = materializeEffectiveTaskContract(currentFound.task, amendments);
    const previousHash = canonicalSha256(contract);
    const nextContract = applyAmendment(contract, {
      schema_version: 1, amendment_id: 'AMD-placeholder', task_id: input.taskId, from_revision: currentRevision, to_revision: currentRevision + 1,
      amendment_kind: input.amendmentKind, source: input.source, changes: input.changes, previous_contract_sha256: previousHash, resulting_contract_sha256: previousHash, created_at: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    const record: TaskAmendmentRecord = {
      schema_version: 1, amendment_id: `AMD-${randomUUID()}`, task_id: input.taskId,
      from_revision: currentRevision, to_revision: currentRevision + 1, amendment_kind: input.amendmentKind, source: input.source,
      changes: input.changes, ...(input.sourceReviewRole ? { source_review_role: input.sourceReviewRole } : {}), ...(input.sourceReviewSha256 ? { source_review_sha256: input.sourceReviewSha256 } : {}),
      previous_contract_sha256: previousHash, resulting_contract_sha256: canonicalSha256(nextContract), created_at: now,
    };
    validateAmendment(record, input.taskId);
    const amendmentPath = resolve(currentFound.stateRoot, 'tasks/amendments', input.taskId, `${String(record.to_revision).padStart(4, '0')}.json`);
    if (await pathExists(amendmentPath)) throw new Error(`Amendment revision already exists: ${record.to_revision}`);
    await writeJson(amendmentPath, record);
    const task = { ...currentFound.task, schema_version: 2 as const, revision: record.to_revision, previous_revision: record.from_revision, latest_amendment_id: record.amendment_id, effective_contract_sha256: record.resulting_contract_sha256, updated_at: now };
    task.derived_state_status = 'stale';
    validateTask(task);
    await writeJson(currentFound.path, task);
    const assignmentPath = resolve(currentFound.stateRoot, 'assignments/active', `${input.taskId}.json`);
    if (await pathExists(assignmentPath)) {
      const assignment = await readJson<import('./models.js').AssignmentRecord>(assignmentPath);
      assignment.sync_required = true; assignment.updated_at = now; await writeJson(assignmentPath, assignment);
    }
    await appendEvent(currentFound.stateRoot, { task_id: input.taskId, type: 'task_amended', details: { amendment_id: record.amendment_id, from_revision: record.from_revision, to_revision: record.to_revision } });
    return record;
  });
}

export async function listTaskAmendments(taskId: string, cwd?: string): Promise<TaskAmendmentRecord[]> {
  const found = await getTask(taskId, cwd);
  return loadAmendments(found.stateRoot, taskId);
}

export async function getTaskAmendment(taskId: string, revision: number, cwd?: string): Promise<TaskAmendmentRecord> {
  const found = await getTask(taskId, cwd);
  const path = resolve(found.stateRoot, 'tasks/amendments', taskId, `${String(revision).padStart(4, '0')}.json`);
  if (!(await pathExists(path))) throw new Error(`Task amendment not found: ${taskId} revision ${revision}`);
  const record = await readJson<TaskAmendmentRecord>(path);
  validateAmendment(record, taskId);
  return record;
}
