import { createHash } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Short stable hash for ids derived from content (e.g. unresolved link targets, URLs). */
export function shortHash(data: string, length = 16): string {
  return sha256(data).slice(0, length);
}
