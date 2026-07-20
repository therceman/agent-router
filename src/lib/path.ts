import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathExists } from './fs.js';

export async function findGitRoot(start = process.cwd()): Promise<string> {
  let current = resolve(start);
  while (true) {
    if (await pathExists(resolve(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`No Git repository found from ${start}`);
    current = parent;
  }
}

export function assertRelativeProjectPath(input: string): void {
  if (!input || input.includes('\0')) throw new Error('Path is empty or contains NUL');
  if (isAbsolute(input)) throw new Error(`Absolute path is not allowed: ${input}`);
  const normalized = input.replaceAll('\\', '/');
  if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Path traversal is not allowed: ${input}`);
  }
}

export async function safeProjectPath(root: string, input: string, allowMissing = false): Promise<string> {
  assertRelativeProjectPath(input);
  const rootReal = await realpath(root);
  const candidate = resolve(root, input);
  const rel = relative(rootReal, candidate);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes project root: ${input}`);
  }
  if (!(await pathExists(candidate))) {
    if (allowMissing) return candidate;
    throw new Error(`Path does not exist: ${input}`);
  }
  const info = await lstat(candidate);
  if (info.isSymbolicLink()) {
    const target = await realpath(candidate);
    const targetRel = relative(rootReal, target);
    if (targetRel.startsWith('..') || targetRel === '..' || targetRel.startsWith(`..${sep}`)) {
      throw new Error(`Symlink escapes project root: ${input}`);
    }
  }
  const resolved = await realpath(candidate);
  const resolvedRel = relative(rootReal, resolved);
  if (resolvedRel.startsWith('..') || resolvedRel === '..' || resolvedRel.startsWith(`..${sep}`)) {
    throw new Error(`Resolved path escapes project root: ${input}`);
  }
  return candidate;
}
