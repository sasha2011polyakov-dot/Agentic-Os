import { realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { AppError } from '../util/errors.ts';

export interface AccessScope {
  /** Absolute root folders this operation may touch. */
  roots: string[];
  writable: boolean;
  label?: string;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u001f<>:"|?*\\]/;

/** Validates one path segment (file or folder name) for cross-platform safety. */
export function validateSegment(name: string): void {
  if (!name || name === '.' || name === '..') throw new AppError('PATH_INVALID', `Invalid name: "${name}"`);
  if (name.length > 255) throw new AppError('PATH_INVALID', 'The file name is longer than 255 characters.');
  if (FORBIDDEN_CHARS.test(name)) throw new AppError('PATH_INVALID', `The name "${name}" contains characters that are not allowed.`);
  if (WINDOWS_RESERVED.test(name)) throw new AppError('PATH_INVALID', `The name "${name}" is reserved on Windows.`);
  if (/[. ]$/.test(name)) throw new AppError('PATH_INVALID', `The name "${name}" cannot end with a dot or a space.`);
}

/** Normalizes a vault-relative path (forward slashes) and rejects traversal / absolute paths. */
export function normalizeRelPath(rel: string): string {
  if (!rel || rel.includes('\0')) throw new AppError('PATH_INVALID');
  const unified = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) throw new AppError('PATH_OUTSIDE_SCOPE', 'A relative path is expected.');
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new AppError('PATH_OUTSIDE_SCOPE', 'The path cannot leave the folder (..).');
    validateSegment(p);
  }
  if (parts.length === 0) throw new AppError('PATH_INVALID');
  return parts.join('/');
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** realpath of the path itself, or of its nearest existing ancestor joined with the missing tail. */
export async function realpathLoose(p: string): Promise<string> {
  const abs = resolve(p);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      const real = await realpath(cur);
      return missing.length ? join(real, ...missing.reverse()) : real;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e;
      const parent = resolve(cur, '..');
      if (parent === cur) return abs;
      missing.push(cur.slice(parent.length).replace(/^[\\/]+/, ''));
      cur = parent;
    }
  }
}

/**
 * Resolves an absolute target and proves it is inside one of the scope roots AFTER resolving symlinks
 * on both sides. Defeats `..`, absolute paths and symlink escapes.
 */
export async function assertInScope(target: string, scope: AccessScope, opts: { write?: boolean } = {}): Promise<string> {
  if (opts.write && !scope.writable) throw new AppError('READ_ONLY_SOURCE');
  const real = await realpathLoose(normalize(target));
  for (const root of scope.roots) {
    const realRoot = await realpathLoose(root);
    if (isInside(real, realRoot)) {
      if (opts.write) assertWritableLocation(real, realRoot);
      return real;
    }
  }
  throw new AppError('PATH_OUTSIDE_SCOPE', undefined, { details: { target } });
}

const PROTECTED_WRITE_SEGMENTS = new Set(['.git', 'node_modules', '.aos']);

function assertWritableLocation(real: string, root: string): void {
  const rel = relative(root, real);
  for (const seg of rel.split(sep)) {
    if (PROTECTED_WRITE_SEGMENTS.has(seg)) {
      throw new AppError('PATH_OUTSIDE_SCOPE', `Writing to the service folder "${seg}" is not allowed.`);
    }
  }
}

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}
