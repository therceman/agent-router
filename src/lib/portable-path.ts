import { isAbsolute, normalize, resolve, win32, posix } from 'node:path';

const WINDOWS_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const WINDOWS_DRIVE_RELATIVE = /^[A-Za-z]:[^\\/]/;
const WINDOWS_UNC = /^\\\\[^\\]+[\\/][^\\/]+/;

export function portablePathFlavor(value: string): 'posix' | 'windows' {
  if (WINDOWS_DRIVE_ABSOLUTE.test(value) || WINDOWS_UNC.test(value) || value.includes('\\')) return 'windows';
  return 'posix';
}

export function isPortableAbsolutePath(value: string): boolean {
  if (typeof value !== 'string' || !value) return false;
  if (WINDOWS_DRIVE_RELATIVE.test(value)) return false;
  if (WINDOWS_DRIVE_ABSOLUTE.test(value) || WINDOWS_UNC.test(value)) return true;
  return value.startsWith('/') && isAbsolute(value);
}

export function normalizePortableAbsolutePath(value: string): string {
  if (!isPortableAbsolutePath(value)) throw new Error(`Expected a portable absolute path: ${value}`);
  if (portablePathFlavor(value) === 'windows') return win32.normalize(value.replaceAll('/', '\\'));
  return posix.normalize(value.replaceAll('\\', '/'));
}

export function normalizeRepositoryRoot(value: string): string {
  if (isPortableAbsolutePath(value)) return normalizePortableAbsolutePath(value);
  return normalize(resolve(value));
}
