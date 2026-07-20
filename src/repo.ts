import { lstat, readdir, readFile, rename, stat } from 'node:fs/promises';
import { basename, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveProjectRuntime } from './state.js';
import { ensureDir, pathExists, readJson, writeJson } from './lib/fs.js';
import { sha256 } from './lib/hash.js';

type Classification = 'canonical_source' | 'canonical_project_data' | 'generated' | 'cache' | 'runtime_state' | 'external_artifact' | 'historical_archive' | 'ambiguous';

export interface RepoEntry {
  path: string;
  bytes: number;
  kind: 'file' | 'directory' | 'symlink';
  classification: Classification;
  reason: string;
}

function classify(path: string, isDir: boolean): { classification: Classification; reason: string } {
  const p = path.replaceAll('\\', '/').toLowerCase();
  if (p === '.agent-router' || p.startsWith('.agent-router/') || p === '.codex' || p.startsWith('.codex/')) return { classification: 'ambiguous', reason: 'Unexpected repository-local Agent Router or Codex state; zero-footprint storage invariant requires owner review' };
  if (p === '.git' || p.startsWith('.git/')) return { classification: 'canonical_project_data', reason: 'Git metadata' };
  if (/(^|\/)(node_modules|vendor|dist|build|coverage|__pycache__|\.cache|\.venv|venv)(\/|$)/.test(p)) return { classification: p.includes('dist') || p.includes('build') || p.includes('coverage') ? 'generated' : 'cache', reason: 'Known generated or dependency directory' };
  if (/(^|\/)(docker-data|docker-volumes|volumes|overlay2|splunk-var|runtime)(\/|$)/.test(p)) return { classification: 'runtime_state', reason: 'Runtime or container state indicator' };
  if (/(^|\/)(ghidra|codeql-db|semgrep|scan-results|scanner-output)(\/|$)/.test(p) || /\.(gpr|rep|gzf)$/.test(p)) return { classification: 'external_artifact', reason: 'Large analysis artifact indicator' };
  if (/\.(zip|tar|tgz|tar\.gz|7z|rar)$/.test(p)) return { classification: 'historical_archive', reason: 'Archive file' };
  if (isDir) return { classification: 'ambiguous', reason: 'Directory requires owner review' };
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|php|java|kt|rb|md|json|yaml|yml|toml|css|html|sql|sh|ps1)$/.test(p) || ['package.json', 'makefile', 'license'].includes(basename(p))) return { classification: 'canonical_source', reason: 'Source or project document' };
  return { classification: 'ambiguous', reason: 'Unknown artifact type' };
}

async function walk(root: string, current = root, depth = 0): Promise<RepoEntry[]> {
  if (depth > 20) return [];
  const out: RepoEntry[] = [];
  for (const item of await readdir(current, { withFileTypes: true })) {
    const full = resolve(current, item.name);
    const rel = relative(root, full).replaceAll('\\', '/');
    if (rel === '.git') continue;
    const info = await lstat(full);
    const cls = classify(rel, item.isDirectory());
    out.push({ path: rel, bytes: info.size, kind: info.isSymbolicLink() ? 'symlink' : item.isDirectory() ? 'directory' : 'file', ...cls });
    if (item.isDirectory() && !info.isSymbolicLink()) out.push(...await walk(root, full, depth + 1));
  }
  return out;
}

export async function inspectRepository(cwd?: string): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd);
  const root = runtime.repoRoot;
  const entries = await walk(root);
  const files = entries.filter((e) => e.kind === 'file');
  const report = {
    schema_version: 1,
    root,
    totals: { entries: entries.length, files: files.length, bytes: files.reduce((s, e) => s + e.bytes, 0) },
    large_files: files.filter((e) => e.bytes > 20 * 1024 * 1024).sort((a, b) => b.bytes - a.bytes),
    classifications: Object.fromEntries(['canonical_source', 'canonical_project_data', 'generated', 'cache', 'runtime_state', 'external_artifact', 'historical_archive', 'ambiguous'].map((c) => [c, entries.filter((e) => e.classification === c).length])),
    entries,
    created_at: new Date().toISOString(),
  };
  const path = resolve(runtime.stateRoot, 'manifests', 'repo-inspect.json');
  await writeJson(path, report);
  return report;
}

export async function createDietPlan(cwd?: string): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(cwd);
  const root = runtime.repoRoot;
  const inspectPath = resolve(runtime.stateRoot, 'manifests', 'repo-inspect.json');
  const report = (await pathExists(inspectPath)) ? await readJson<{ entries: RepoEntry[] }>(inspectPath) : await inspectRepository(root) as { entries: RepoEntry[] };
  const movable = new Set<Classification>(['generated', 'cache', 'runtime_state', 'external_artifact', 'historical_archive']);
  const actions = report.entries
    .filter((e) => e.kind !== 'directory' && movable.has(e.classification))
    .map((entry) => ({ action: 'move', path: entry.path, classification: entry.classification, reason: entry.reason }));
  const planId = `diet_${randomUUID()}`;
  const plan = { schema_version: 1, plan_id: planId, root, actions, ambiguous: report.entries.filter((e) => e.classification === 'ambiguous').map((e) => e.path), created_at: new Date().toISOString() };
  const path = resolve(runtime.stateRoot, 'manifests', `${planId}.json`);
  await writeJson(path, plan);
  return { ...plan, path };
}

export async function applyDietPlan(input: { planPath: string; destination: string; confirm: string; cwd?: string }): Promise<Record<string, unknown>> {
  const runtime = await resolveProjectRuntime(input.cwd);
  const root = runtime.repoRoot;
  const plan = await readJson<{ plan_id: string; root: string; actions: Array<{ path: string; classification: string }> }>(resolve(input.planPath));
  if (input.confirm !== plan.plan_id) throw new Error('Diet plan confirmation does not match plan ID');
  if (resolve(plan.root) !== root) throw new Error('Diet plan belongs to a different repository');
  const moved: Array<{ path: string; destination: string; bytes: number; sha256: string }> = [];
  for (const action of plan.actions) {
    const source = resolve(root, action.path);
    if (!(await pathExists(source))) continue;
    const info = await stat(source);
    if (!info.isFile()) continue;
    const data = await readFile(source);
    const destination = resolve(input.destination, action.path);
    await ensureDir(resolve(destination, '..'));
    await rename(source, destination);
    moved.push({ path: action.path, destination, bytes: info.size, sha256: sha256(data) });
  }
  const manifest = { schema_version: 1, plan_id: plan.plan_id, moved, applied_at: new Date().toISOString() };
  await writeJson(resolve(runtime.stateRoot, 'manifests', `${plan.plan_id}.applied.json`), manifest);
  return manifest;
}
