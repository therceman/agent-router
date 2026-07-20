export interface ManagedBlockOptions { start: string; end: string; body: string; }

export function upsertManagedBlock(existing: string, options: ManagedBlockOptions): string {
  const { start, end, body } = options;
  const starts = existing.split(start).length - 1;
  const ends = existing.split(end).length - 1;
  if (starts > 1 || ends > 1 || starts !== ends) throw new Error('Malformed or duplicate managed block');
  const block = `${start}\n${body.trim()}\n${end}`;
  if (starts === 1) {
    const startIndex = existing.indexOf(start);
    const endIndex = existing.indexOf(end, startIndex) + end.length;
    return `${existing.slice(0, startIndex)}${block}${existing.slice(endIndex)}`.replace(/\s+$/u, '') + '\n';
  }
  const prefix = existing.trimEnd();
  return `${prefix}${prefix ? '\n\n' : ''}${block}\n`;
}

export function removeManagedBlock(existing: string, start: string, end: string): string {
  const starts = existing.split(start).length - 1;
  const ends = existing.split(end).length - 1;
  if (starts === 0 && ends === 0) return existing;
  if (starts !== 1 || ends !== 1) throw new Error('Malformed or duplicate managed block');
  const startIndex = existing.indexOf(start);
  const endIndex = existing.indexOf(end, startIndex) + end.length;
  return `${existing.slice(0, startIndex)}${existing.slice(endIndex)}`.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
