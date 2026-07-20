const PATTERNS: Array<[string, RegExp]> = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['aws-access-key', /AKIA[0-9A-Z]{16}/],
  ['github-token', /gh[pousr]_[A-Za-z0-9_]{30,}/],
  ['generic-secret-assignment', /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9_\-\/.+=]{12,}/i],
];
export function scanSecrets(text: string): string[] {
  return PATTERNS.filter(([, regex]) => regex.test(text)).map(([name]) => name);
}
