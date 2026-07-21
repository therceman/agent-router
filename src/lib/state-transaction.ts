import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { StateTransactionRecord } from '../models.js';
import { sha256 } from './hash.js';
import { atomicWrite, ensureDir, pathExists, readJson, withFileLock } from './fs.js';

export interface StateTransactionOperation {
  kind: 'write' | 'move' | 'remove';
  target: string;
  data?: string | Buffer;
}

export interface StateTransactionOptions {
  stateRoot: string;
  projectId: string;
  operation: string;
  plan?: StateTransactionOperation[];
  faultAfter?: 'prepared' | 'staged' | 'rename' | 'committing' | 'committed';
}

function transactionDir(stateRoot: string, id: string): string { return resolve(stateRoot, 'transactions', id); }
function journalPath(stateRoot: string, id: string): string { return resolve(transactionDir(stateRoot, id), 'journal.json'); }
function hash(value: string | Buffer): string { return sha256(value); }

async function persistJournal(path: string, record: StateTransactionRecord): Promise<void> { record.updated_at = new Date().toISOString(); await atomicWrite(path, `${JSON.stringify(record, null, 2)}\n`); }

export async function withStateTransaction<T>(options: StateTransactionOptions, execute?: () => Promise<T>): Promise<T> {
  const id = `TX-${randomUUID()}`;
  const dir = transactionDir(options.stateRoot, id); const stageDir = resolve(dir, 'staging'); const backupDir = resolve(dir, 'backups');
  const now = new Date().toISOString();
  const operations: StateTransactionRecord['operations'] = [];
  for (const item of [...(options.plan ?? [])].sort((a, b) => a.target.localeCompare(b.target))) operations.push({ kind: item.kind, target: item.target, before_sha256: null, after_sha256: item.data === undefined ? null : hash(item.data) });
  const journal: StateTransactionRecord = { schema_version: 1, transaction_id: id, project_id: options.projectId, operation: options.operation, status: 'prepared', created_at: now, updated_at: now, operations };
  return withFileLock(resolve(options.stateRoot, 'locks', 'state-transaction.lock'), { command: options.operation, project_id: options.projectId }, async () => {
    await ensureDir(stageDir); await ensureDir(backupDir); const journalFile = journalPath(options.stateRoot, id); await persistJournal(journalFile, journal);
    if (options.faultAfter === 'prepared') throw new Error(`Injected transaction fault after prepared: ${id}`);
    for (let index = 0; index < (options.plan ?? []).length; index++) {
      const item = options.plan![index]!; const target = resolve(item.target); const op = journal.operations.find((entry) => entry.target === item.target)!;
      if (await pathExists(target)) { const before = await readFile(target); op.before_sha256 = hash(before); await atomicWrite(resolve(backupDir, `${index}.bak`), before); op.backup_path = resolve(backupDir, `${index}.bak`); }
      if (item.kind === 'write') { const staged = resolve(stageDir, `${index}.stage`); await atomicWrite(staged, item.data ?? ''); op.staged_path = staged; }
      if (item.kind === 'move') { const staged = resolve(stageDir, `${index}.move`); await atomicWrite(staged, await readFile(target)); op.staged_path = staged; }
    }
    if (options.faultAfter === 'staged') throw new Error(`Injected transaction fault after staged: ${id}`);
    journal.status = 'committing'; await persistJournal(journalFile, journal);
    if (options.faultAfter === 'committing') throw new Error(`Injected transaction fault after committing: ${id}`);
    for (const op of journal.operations) {
      if (op.kind === 'remove') { await rm(op.target, { force: true, recursive: true }); continue; }
      if (op.staged_path) { await ensureDir(dirname(op.target)); await import('node:fs/promises').then(({ rename }) => rename(op.staged_path!, op.target)); }
      if (options.faultAfter === 'rename') throw new Error(`Injected transaction fault after rename: ${id}`);
    }
    journal.status = 'committed'; await persistJournal(journalFile, journal);
    if (options.faultAfter === 'committed') throw new Error(`Injected transaction fault after committed: ${id}`);
    await rm(stageDir, { recursive: true, force: true });
    return execute ? execute() : undefined as T;
  });
}

export async function listStateTransactions(stateRoot: string, pendingOnly = false): Promise<StateTransactionRecord[]> {
  const root = resolve(stateRoot, 'transactions'); if (!(await pathExists(root))) return [];
  const out: StateTransactionRecord[] = [];
  for (const name of (await readdir(root)).sort()) { const path = journalPath(stateRoot, name); if (!(await pathExists(path))) continue; const record = await readJson<StateTransactionRecord>(path); if (!pendingOnly || !['committed', 'rolled_back'].includes(record.status)) out.push(record); }
  return out;
}

export async function recoverStateTransactions(stateRoot: string, apply = false): Promise<Record<string, unknown>> {
  const transactions = await listStateTransactions(stateRoot, true); const repairs: string[] = [];
  if (!apply) return { pending: transactions, applied: false, repairs };
  for (const record of transactions) {
    const journalFile = journalPath(stateRoot, record.transaction_id); const dir = transactionDir(stateRoot, record.transaction_id);
    if (record.status === 'prepared') { await rm(resolve(dir, 'staging'), { recursive: true, force: true }); record.status = 'rolled_back'; await persistJournal(journalFile, record); repairs.push(`rolled_back:${record.transaction_id}`); continue; }
    if (record.status === 'committing' || record.status === 'recovery_required') {
      let ambiguous = false;
      const complete: boolean[] = [];
      for (const op of record.operations) {
        const exists = await pathExists(op.target);
        const current = exists ? hash(await readFile(op.target)) : null;
        if (op.after_sha256 !== null && op.after_sha256 !== undefined && current === op.after_sha256) { complete.push(true); continue; }
        if (op.after_sha256 === null && !exists) { complete.push(true); continue; }
        const atBefore = op.before_sha256 === null ? !exists : current === op.before_sha256;
        if (!atBefore) { ambiguous = true; complete.push(false); continue; }
        complete.push(false);
      }
      if (ambiguous) { record.status = 'recovery_required'; record.error = 'Ambiguous transaction state; operator review required'; await persistJournal(journalFile, record); continue; }
      for (let index = 0; index < record.operations.length; index++) {
        if (complete[index]) continue;
        const op = record.operations[index]!;
        if (op.kind === 'remove') { await rm(op.target, { force: true, recursive: true }); continue; }
        if (!op.staged_path || !(await pathExists(op.staged_path))) { record.status = 'recovery_required'; record.error = `Missing staged data for ${op.target}`; ambiguous = true; break; }
        await ensureDir(dirname(op.target)); await import('node:fs/promises').then(({ rename }) => rename(op.staged_path!, op.target));
      }
      if (ambiguous) { await persistJournal(journalFile, record); continue; }
      record.status = 'committed'; await persistJournal(journalFile, record); repairs.push(`completed:${record.transaction_id}`);
    }
  }
  return { pending: transactions, applied: true, repairs };
}
