import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { appendEvent } from './events.js';
import { pathExists, readJson, writeJson, atomicWrite } from './lib/fs.js';
import { resolveProjectRuntime } from './state.js';

export type PlanAuthor = 'external-chatgpt' | 'owner' | 'local-sol';

export interface PlanRecord {
  schema_version: 1;
  plan_id: string;
  title: string;
  author: PlanAuthor;
  source_file: string;
  content_sha256?: string;
  created_at: string;
}

export function validatePlanId(planId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/.test(planId)) throw new Error(`Invalid plan ID: ${planId}`);
}


export async function createPlan(input: { cwd?: string; id: string; title: string; author: PlanAuthor; content: string }): Promise<PlanRecord> {
  validatePlanId(input.id);
  if (!['external-chatgpt', 'owner', 'local-sol'].includes(input.author)) throw new Error(`Invalid plan author: ${input.author}`);
  if (!input.title.trim()) throw new Error('Plan title is required');
  if (!input.content.trim()) throw new Error('Plan content is empty');
  const runtime = await resolveProjectRuntime(input.cwd);
  const { sha256 } = await import('./lib/hash.js');
  const record: PlanRecord = {
    schema_version: 1,
    plan_id: input.id,
    title: input.title,
    author: input.author,
    source_file: `${input.id}.md`,
    content_sha256: sha256(Buffer.from(input.content)),
    created_at: new Date().toISOString(),
  };
  await atomicWrite(resolve(runtime.stateRoot, 'plans', `${input.id}.md`), input.content.endsWith('\n') ? input.content : `${input.content}\n`);
  await writeJson(resolve(runtime.stateRoot, 'plans', `${input.id}.json`), record);
  await appendEvent(runtime.stateRoot, { type: 'plan_created', details: { plan_id: input.id, author: input.author } });
  return record;
}

export async function importPlan(input: { cwd?: string; id: string; title?: string; author: PlanAuthor; file: string }): Promise<PlanRecord> {
  validatePlanId(input.id);
  if (!['external-chatgpt', 'owner', 'local-sol'].includes(input.author)) throw new Error(`Invalid plan author: ${input.author}`);
  const runtime = await resolveProjectRuntime(input.cwd);
  const source = resolve(input.file);
  if (!(await pathExists(source))) throw new Error(`Plan file does not exist: ${source}`);
  const content = await readFile(source);
  if (!content.length) throw new Error('Plan file is empty');
  const { sha256 } = await import('./lib/hash.js');
  const record: PlanRecord = {
    schema_version: 1,
    plan_id: input.id,
    title: input.title ?? basename(source),
    author: input.author,
    source_file: `${input.id}.md`,
    content_sha256: sha256(content),
    created_at: new Date().toISOString(),
  };
  await atomicWrite(resolve(runtime.stateRoot, 'plans', `${input.id}.md`), content);
  await writeJson(resolve(runtime.stateRoot, 'plans', `${input.id}.json`), record);
  await appendEvent(runtime.stateRoot, { type: 'plan_imported', details: { plan_id: input.id, author: input.author } });
  return record;
}

export async function getPlan(planId: string, cwd?: string): Promise<{ record: PlanRecord; content: string }> {
  validatePlanId(planId);
  const runtime = await resolveProjectRuntime(cwd);
  const recordPath = resolve(runtime.stateRoot, 'plans', `${planId}.json`);
  if (!(await pathExists(recordPath))) throw new Error(`Plan not found: ${planId}`);
  const record = await readJson<PlanRecord>(recordPath);
  const content = await readFile(resolve(runtime.stateRoot, 'plans', record.source_file), 'utf8');
  return { record, content };
}

export async function listPlans(cwd?: string): Promise<PlanRecord[]> {
  const runtime = await resolveProjectRuntime(cwd);
  const dir = resolve(runtime.stateRoot, 'plans');
  if (!(await pathExists(dir))) return [];
  const out: PlanRecord[] = [];
  for (const name of (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()) {
    out.push(await readJson<PlanRecord>(resolve(dir, name)));
  }
  return out;
}
