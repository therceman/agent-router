import { resolve } from 'node:path';
import { globalPaths } from './config.js';
import type { ProviderSessionCapabilities } from './models.js';
import { pathExists, readJson, writeJson } from './lib/fs.js';

const defaults: ProviderSessionCapabilities = {
  provider: 'codex', spawn: true, send_input: true, resume: 'unknown', close: true, wait: true,
  persistent_across_parent_restart: 'unknown', detected_at: new Date(0).toISOString(), source: 'configured',
};

function capabilitiesPath(): string { return resolve(globalPaths().root, 'providers', 'codex-capabilities.json'); }

export async function providerCapabilities(): Promise<ProviderSessionCapabilities> {
  const path = capabilitiesPath();
  if (!(await pathExists(path))) return { ...defaults };
  const value = await readJson<ProviderSessionCapabilities>(path);
  validateProviderCapabilities(value);
  return value;
}

export function validateProviderCapabilities(value: ProviderSessionCapabilities): void {
  if (value.provider !== 'codex') throw new Error('Unsupported provider capability record');
  for (const key of ['spawn', 'send_input', 'close', 'wait'] as const) if (typeof value[key] !== 'boolean') throw new Error(`Invalid provider capability: ${key}`);
  if (![true, false, 'unknown'].includes(value.resume)) throw new Error('Invalid provider resume capability');
  if (![true, false, 'unknown'].includes(value.persistent_across_parent_restart)) throw new Error('Invalid provider persistence capability');
  if (!['configured', 'manual-smoke-test', 'runtime-observation'].includes(value.source)) throw new Error('Invalid provider capability source');
  if (!Number.isFinite(Date.parse(value.detected_at))) throw new Error('Invalid provider capability timestamp');
}

export async function setProviderCapabilities(input: Partial<Pick<ProviderSessionCapabilities, 'resume' | 'persistent_across_parent_restart'>> & { source: ProviderSessionCapabilities['source'] }): Promise<ProviderSessionCapabilities> {
  const current = await providerCapabilities();
  const next: ProviderSessionCapabilities = { ...current, ...input, detected_at: new Date().toISOString() };
  validateProviderCapabilities(next);
  await writeJson(capabilitiesPath(), next);
  return next;
}

export async function ensureProviderCapabilities(): Promise<ProviderSessionCapabilities> {
  const path = capabilitiesPath();
  if (await pathExists(path)) return providerCapabilities();
  const value: ProviderSessionCapabilities = { ...defaults, detected_at: new Date().toISOString() };
  await writeJson(path, value);
  return value;
}
