import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { EventRecord, TaskState } from './models.js';
import { ensureDir } from './lib/fs.js';

export async function appendEvent(stateRoot: string, input: Omit<EventRecord, 'schema_version' | 'event_id' | 'at'>): Promise<EventRecord> {
  const event: EventRecord = {
    schema_version: 1,
    event_id: `evt_${randomUUID()}`,
    at: new Date().toISOString(),
    ...input,
  };
  const path = resolve(stateRoot, 'events/events.jsonl');
  await ensureDir(resolve(stateRoot, 'events'));
  await appendFile(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
  return event;
}

export async function transitionEvent(stateRoot: string, taskId: string, from: TaskState, to: TaskState, details?: Record<string, unknown>): Promise<EventRecord> {
  return appendEvent(stateRoot, { task_id: taskId, type: 'task_transition', from_state: from, to_state: to, details });
}
