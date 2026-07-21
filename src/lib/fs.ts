import { hostname } from 'node:os';
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  await ensureDir(dirname(path));
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temp, path);
}

export async function readJson<T>(path: string): Promise<T> {
  const raw = await readFile(path, 'utf8');
  try { return JSON.parse(raw) as T; }
  catch (error) { throw new Error(`Invalid JSON in ${path}: ${(error as Error).message}`); }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function backupFile(path: string): Promise<string | null> {
  if (!(await pathExists(path))) return null;
  const suffix = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${path}.agent-router-backup-${suffix}`;
  await writeFile(backup, await readFile(path));
  return backup;
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}

export interface LockMetadata {
  pid: number;
  host: string;
  nonce: string;
  acquired_at: string;
  heartbeat_at: string;
  /** v0.8 compatibility field. */
  timestamp?: string;
  command: string;
  project_id: string;
}

function processAlive(pid: number, host: string): boolean {
  if (host !== hostname()) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function withFileLock<T>(
  path: string,
  metadata: Pick<LockMetadata, 'command' | 'project_id'>,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; staleMs?: number; pollMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 120_000;
  const pollMs = options.pollMs ?? 25;
  const started = Date.now();
  await ensureDir(dirname(path));
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let owner: LockMetadata | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  while (!handle) {
    try {
      handle = await open(path, 'wx', 0o600);
      const now = new Date().toISOString();
      const record: LockMetadata = { ...metadata, pid: process.pid, host: hostname(), nonce: randomUUID(), acquired_at: now, heartbeat_at: now, timestamp: now };
      owner = record;
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
      heartbeat = setInterval(async () => {
        if (!owner) return;
        try {
          const current = JSON.parse(await readFile(path, 'utf8')) as Partial<LockMetadata>;
          if (current.nonce !== owner.nonce) return;
          const updated = { ...owner, heartbeat_at: new Date().toISOString(), timestamp: new Date().toISOString() };
          await atomicWrite(path, `${JSON.stringify(updated)}\n`);
          owner = updated;
        } catch { /* The critical section will fail or release conservatively. */ }
      }, Math.max(250, Math.min(5000, Math.floor(staleMs / 3))));
      heartbeat.unref?.();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      handle = undefined;
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let stale = false;
      try {
        const info = JSON.parse(await readFile(path, 'utf8')) as Partial<LockMetadata>;
        const at = Date.parse(String(info.heartbeat_at ?? info.acquired_at ?? info.timestamp ?? ''));
        stale = !Number.isFinite(at) || (!processAlive(Number(info.pid), String(info.host ?? '')) && Date.now() - at > staleMs);
      } catch {
        // A malformed lock is only recoverable once it has aged beyond the stale threshold.
        try { stale = Date.now() - (await stat(path)).mtimeMs > staleMs; } catch { stale = false; }
      }
      if (stale) { await rm(path, { force: true }); continue; }
      if (Date.now() - started >= timeoutMs) throw new Error(`Timed out acquiring lock: ${path}`);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await handle.close().catch(() => undefined);
    try {
      const current = JSON.parse(await readFile(path, 'utf8')) as Partial<LockMetadata>;
      if (owner && current.nonce === owner.nonce) await rm(path, { force: true });
    } catch { /* A replaced or already removed lock belongs to another owner. */ }
  }
}
