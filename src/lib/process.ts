import { spawnSync } from 'node:child_process';

export interface RunResult { status: number; stdout: string; stderr: string; }
export function run(command: string, args: string[], cwd?: string): RunResult {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', shell: false, env: process.env });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}
export function runChecked(command: string, args: string[], cwd?: string): string {
  const result = run(command, args, cwd);
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${result.stderr.trim()}`);
  return result.stdout;
}
