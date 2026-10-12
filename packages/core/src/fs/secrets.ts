import { basename } from 'node:path';

const SECRET_NAME_PATTERNS: RegExp[] = [
  /^\.env($|\.(?!example$|sample$|template$).+)/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^credentials(\..+)?$/i,
  /^secrets?\.(json|ya?ml|toml|env|txt)$/i,
  /^\.(npmrc|pypirc|netrc|htpasswd|git-credentials)$/i,
  /^service[-_]?account.*\.json$/i,
];

const SECRET_CONTENT_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
];

export function isSecretFileName(relPath: string): boolean {
  const name = basename(relPath);
  return SECRET_NAME_PATTERNS.some((re) => re.test(name));
}

/** Returns the first matching pattern description, or null. Content of such files is never indexed. */
export function detectSecretContent(text: string): string | null {
  for (const re of SECRET_CONTENT_PATTERNS) {
    if (re.test(text)) return re.source.slice(0, 40);
  }
  return null;
}
