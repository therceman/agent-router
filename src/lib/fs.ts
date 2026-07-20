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
