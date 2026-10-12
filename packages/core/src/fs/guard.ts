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
  if (!name || name === '.' || name === '..') throw new AppError('PATH_INVALID', `Недопустимое имя: «${name}»`);
  if (name.length > 255) throw new AppError('PATH_INVALID', 'Имя файла длиннее 255 символов.');
  if (FORBIDDEN_CHARS.test(name)) throw new AppError('PATH_INVALID', `Имя «${name}» содержит недопустимые символы.`);
  if (WINDOWS_RESERVED.test(name)) throw new AppError('PATH_INVALID', `Имя «${name}» зарезервировано в Windows.`);
  if (/[. ]$/.test(name)) throw new AppError('PATH_INVALID', `Имя «${name}» не может заканчиваться точкой или пробелом.`);
}

/** Normalizes a vault-relative path (forward slashes) and rejects traversal / absolute paths. */
export function normalizeRelPath(rel: string): string {
  if (!rel || rel.includes('\0')) throw new AppError('PATH_INVALID');
  const unified = rel.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) throw new AppError('PATH_OUTSIDE_SCOPE', 'Ожидается относительный путь.');
  const parts = unified.split('/').filter((p) => p !== '' && p !== '.');
  for (const p of parts) {
    if (p === '..') throw new AppError('PATH_OUTSIDE_SCOPE', 'Путь не может выходить за пределы папки (..).');
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
      throw new AppError('PATH_OUTSIDE_SCOPE', `Запись в служебную папку «${seg}» запрещена.`);
    }
  }
}

export function toPosix(p: string): string {
  return p.split(sep).join('/');
}
