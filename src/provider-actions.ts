import { randomUUID } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProviderActionRecord, SessionRetireReason } from './models.js';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs.js';
import { resolveProjectRuntime } from './state.js';

function pendingDir(stateRoot: string): string { return resolve(stateRoot, 'provider-actions/pending'); }
function historyDir(stateRoot: string): string { return resolve(stateRoot, 'provider-actions/history'); }
function validate(value: ProviderActionRecord): void {
  if (value.schema_version !== 1 || !/^PAC-[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(value.action_id) || value.provider !== 'codex' || value.action !== 'close') throw new Error('Invalid provider action');
  if (!value.project_id || !value.session_id || !value.provider_agent_id || !value.reason) throw new Error('Provider action identity is incomplete');
  if (!['pending', 'confirmed', 'failed'].includes(value.status)) throw new Error('Invalid provider action status');
  if (!Number.isFinite(Date.parse(value.created_at)) || !Number.isFinite(Date.parse(value.updated_at))) throw new Error('Invalid provider action timestamp');
}

async function all(stateRoot: string, history = false): Promise<ProviderActionRecord[]> {
  const dir = history ? historyDir(stateRoot) : pendingDir(stateRoot); if (!(await pathExists(dir))) return [];
  const out: ProviderActionRecord[] = [];
  for (const name of (await readdir(dir)).filter((item) => item.endsWith('.json')).sort()) { const item = await readJson<ProviderActionRecord>(resolve(dir, name)); validate(item); out.push(item); }
  return out;
}

export async function enqueueProviderClose(input: { stateRoot: string; projectId: string; sessionId: string; providerAgentId?: string; reason: SessionRetireReason }): Promise<ProviderActionRecord | null> {
  if (!input.providerAgentId) return null;
  const existing = (await all(input.stateRoot)).find((item) => item.session_id === input.sessionId && item.provider_agent_id === input.providerAgentId && item.status === 'pending'); if (existing) return existing;
  const now = new Date().toISOString(); const item: ProviderActionRecord = { schema_version: 1, action_id: `PAC-${randomUUID()}`, provider: 'codex', action: 'close', project_id: input.projectId, session_id: input.sessionId, provider_agent_id: input.providerAgentId, reason: input.reason, status: 'pending', created_at: now, updated_at: now };
  validate(item); await ensureDir(pendingDir(input.stateRoot)); await writeJson(resolve(pendingDir(input.stateRoot), `${item.action_id}.json`), item); return item;
}

export async function listProviderActions(cwd?: string, pendingOnly = false): Promise<ProviderActionRecord[]> { const runtime = await resolveProjectRuntime(cwd); return pendingOnly ? all(runtime.stateRoot) : [...(await all(runtime.stateRoot)), ...(await all(runtime.stateRoot, true))]; }
export async function listProviderActionsAtState(stateRoot: string, pendingOnly = false): Promise<ProviderActionRecord[]> { return pendingOnly ? all(stateRoot) : [...(await all(stateRoot)), ...(await all(stateRoot, true))]; }
export async function nextProviderAction(cwd?: string): Promise<ProviderActionRecord | null> { return (await listProviderActions(cwd, true))[0] ?? null; }

async function getPending(actionId: string, cwd?: string): Promise<{ runtime: Awaited<ReturnType<typeof resolveProjectRuntime>>; action: ProviderActionRecord; path: string }> {
  const runtime = await resolveProjectRuntime(cwd); if (!/^PAC-[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(actionId)) throw new Error(`Invalid provider action ID: ${actionId}`); const path = resolve(pendingDir(runtime.stateRoot), `${actionId}.json`); if (!(await pathExists(path))) throw new Error(`Pending provider action not found: ${actionId}`); const action = await readJson<ProviderActionRecord>(path); validate(action); return { runtime, action, path };
}

export async function confirmProviderAction(actionId: string, cwd?: string): Promise<ProviderActionRecord> { const found = await getPending(actionId, cwd); found.action.status = 'confirmed'; found.action.confirmed_at = new Date().toISOString(); found.action.updated_at = found.action.confirmed_at; validate(found.action); await ensureDir(historyDir(found.runtime.stateRoot)); await writeJson(resolve(historyDir(found.runtime.stateRoot), `${actionId}.json`), found.action); await rm(found.path, { force: true }); return found.action; }
export async function failProviderAction(actionId: string, detail: string, cwd?: string): Promise<ProviderActionRecord> { if (!detail.trim()) throw new Error('Provider action failure detail is required'); const found = await getPending(actionId, cwd); found.action.status = 'failed'; found.action.failure_detail = detail; found.action.failed_at = new Date().toISOString(); found.action.updated_at = found.action.failed_at; validate(found.action); await writeJson(found.path, found.action); return found.action; }
export async function retryProviderAction(actionId: string, cwd?: string): Promise<ProviderActionRecord> {
  const runtime = await resolveProjectRuntime(cwd);
  const pendingPath = resolve(pendingDir(runtime.stateRoot), `${actionId}.json`);
  if (await pathExists(pendingPath)) {
    const action = await readJson<ProviderActionRecord>(pendingPath); validate(action);
    if (action.status === 'failed') { action.status = 'pending'; action.failure_detail = undefined; action.failed_at = undefined; action.updated_at = new Date().toISOString(); validate(action); await writeJson(pendingPath, action); }
    return action;
  }
  const historyPath = resolve(historyDir(runtime.stateRoot), `${actionId}.json`);
  if (!(await pathExists(historyPath))) throw new Error(`Provider action not found: ${actionId}`);
  const prior = await readJson<ProviderActionRecord>(historyPath); validate(prior);
  if (prior.status === 'confirmed') throw new Error(`Provider action is already confirmed: ${actionId}`);
  return (await enqueueProviderClose({ stateRoot: runtime.stateRoot, projectId: prior.project_id, sessionId: prior.session_id, providerAgentId: prior.provider_agent_id, reason: prior.reason }))!;
}
