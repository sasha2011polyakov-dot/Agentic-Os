import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from '../util/errors.ts';
import { sha256 } from '../util/hash.ts';
import { assertInScope, type AccessScope } from './guard.ts';
import type { HistoryStore } from '../vault/history.ts';

export interface ReadResult {
  text: string;
  hash: string;
  mtimeMs: number;
  size: number;
}

export interface WriteOptions {
  scope: AccessScope;
  /** undefined = no conflict check; null = file must not exist; string = file must still have this hash. */
  expectedHash?: string | null;
  reason: string;
  actor: string;
  history?: { sourceId: string; relPath: string; docId: string | null };
}

export interface WriteResult {
  path: string;
  hash: string;
  created: boolean;
  previousHash: string | null;
}

/**
 * The only write path to user files. Guarantees: scope check (symlink-safe), conflict detection against
 * external edits, snapshot of the previous content into history, atomic replace (tmp + fsync + rename).
 */
export class SafeFs {
  constructor(private readonly history: HistoryStore | null) {}

  async readText(absPath: string, scope: AccessScope): Promise<ReadResult> {
    const real = await assertInScope(absPath, scope);
    try {
      const buf = await readFile(real);
      const st = await stat(real);
      return { text: buf.toString('utf8'), hash: sha256(buf), mtimeMs: Math.floor(st.mtimeMs), size: st.size };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new AppError('NOT_FOUND', 'Файл не найден на диске.');
      throw new AppError('SOURCE_NOT_ACCESSIBLE', undefined, { cause: e });
    }
  }

  async readBytes(absPath: string, scope: AccessScope): Promise<Buffer> {
    const real = await assertInScope(absPath, scope);
    return readFile(real);
  }

  async writeText(absPath: string, text: string, opts: WriteOptions): Promise<WriteResult> {
    const real = await assertInScope(absPath, opts.scope, { write: true });
    let previous: string | null = null;
    let previousHash: string | null = null;
    try {
      previous = await readFile(real, 'utf8');
      previousHash = sha256(previous);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('SOURCE_NOT_ACCESSIBLE', undefined, { cause: e });
    }
    if (opts.expectedHash === null && previousHash !== null) {
      throw new AppError('WRITE_CONFLICT', 'Файл с таким именем уже существует.', { details: { currentHash: previousHash } });
    }
    if (typeof opts.expectedHash === 'string' && previousHash !== opts.expectedHash) {
      throw new AppError('WRITE_CONFLICT', undefined, {
        details: { expectedHash: opts.expectedHash, currentHash: previousHash, currentText: previous, deleted: previousHash === null },
      });
    }
    const newHash = sha256(text);
    if (previousHash === newHash) return { path: real, hash: newHash, created: false, previousHash };
    if (previous !== null && this.history && opts.history) {
      this.history.snapshot({ ...opts.history, content: previous, reason: `before:${opts.reason}`, actor: opts.actor });
    }
    await atomicWrite(real, text);
    return { path: real, hash: newHash, created: previous === null, previousHash };
  }

  async move(fromAbs: string, toAbs: string, scope: AccessScope): Promise<void> {
    const from = await assertInScope(fromAbs, scope, { write: true });
    const to = await assertInScope(toAbs, scope, { write: true });
    if (await exists(to)) throw new AppError('WRITE_CONFLICT', 'В месте назначения уже есть файл с таким именем.');
    await mkdir(dirname(to), { recursive: true });
    await rename(from, to);
  }

  /** Moves a file into <trashRoot>/<timestamp>/<relPath> instead of deleting it. Returns the trash location. */
  async trash(absPath: string, relPath: string, trashRoot: string, scope: AccessScope): Promise<string> {
    const from = await assertInScope(absPath, scope, { write: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(trashRoot, stamp, relPath);
    await mkdir(dirname(target), { recursive: true });
    await rename(from, target);
    return target;
  }

  async mkdirp(absDir: string, scope: AccessScope): Promise<void> {
    const real = await assertInScope(absDir, scope, { write: true });
    await mkdir(real, { recursive: true });
  }
}

export async function atomicWrite(target: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.aos-tmp-${randomBytes(6).toString('hex')}`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, target);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
