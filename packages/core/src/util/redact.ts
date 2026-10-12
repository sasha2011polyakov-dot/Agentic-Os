/**
 * Redacts secrets from strings before they reach logs, audit entries, exports or the UI.
 * Two layers: exact known secret values (registered when a secret is loaded) and generic key patterns.
 */
const PATTERNS: { re: RegExp; replacement: string }[] = [
  { re: /\bsk-[A-Za-z0-9_\-]{16,}/g, replacement: '[REDACTED]' }, // OpenAI-style and Anthropic (sk-ant-...)
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED]' }, // AWS access key id
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replacement: '[REDACTED]' }, // GitHub tokens
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g, replacement: '[REDACTED]' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '[REDACTED]' }, // Slack
  { re: /\bAIza[0-9A-Za-z_\-]{35}\b/g, replacement: '[REDACTED]' }, // Google API key
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, replacement: '[REDACTED PRIVATE KEY]' },
  // header / assignment forms: keep the name, hide the value
  { re: /(authorization|x-api-key|x-subscription-token|api[_-]?key)("?\s*[:=]\s*"?)(?:Bearer\s+)?[A-Za-z0-9._\-]{8,}/gi, replacement: '$1$2[REDACTED]' },
];

const known = new Set<string>();

export function registerSecretValue(value: string | undefined | null): void {
  if (value && value.length >= 6) known.add(value);
}

export function unregisterSecretValue(value: string | undefined | null): void {
  if (value) known.delete(value);
}

export function redact(input: string): string {
  let out = input;
  for (const secret of known) {
    if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
  }
  for (const { re, replacement } of PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, replacement);
  }
  return out;
}

export function redactValue<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value) as T;
  try {
    return JSON.parse(redact(JSON.stringify(value))) as T;
  } catch {
    return value;
  }
}

export function maskSecret(value: string): string {
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}
