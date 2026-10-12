import { mkdtemp, rm, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { AppCore } from '../src/app.ts';
import type { SystemRuntime } from '../src/systems/runtime.ts';

export async function tempDir(prefix = 'aos-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface TestApp {
  core: AppCore;
  root: string;
  dataDir: string;
  sysDir(name: string): string;
  cleanup(): Promise<void>;
}

export async function startTestApp(opts: { env?: NodeJS.ProcessEnv } = {}): Promise<TestApp> {
  const root = await tempDir();
  const dataDir = join(root, 'appdata');
  const core = await AppCore.start({ dataDir, logLevel: 'warn', env: { ...process.env, ...opts.env } });
  return {
    core,
    root,
    dataDir,
    sysDir: (name: string) => join(root, 'systems', name),
    async cleanup() {
      await core.stop();
      await removeDir(root);
    },
  };
}

/** Content hash of every file under a folder (relative path → sha256). */
export async function hashTree(dir: string, opts: { skip?: (rel: string) => boolean } = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      const rel = relative(dir, p).split('\\').join('/');
      if (opts.skip?.(rel)) continue;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out[rel] = createHash('sha256').update(await readFile(p)).digest('hex');
    }
  }
  await walk(dir);
  return out;
}

/** Hash of user-visible files + passport; database files are compared logically via dbFingerprint instead. */
export function userTree(dir: string): Promise<Record<string, string>> {
  return hashTree(dir, { skip: (rel) => /^\.aos\/(system\.db(-wal|-shm)?|migration-backups)/.test(rel) });
}

/** Logical fingerprint of a system database: content hash per table (volatile bookkeeping columns excluded). */
export function dbFingerprint(rt: SystemRuntime): Record<string, string> {
  const tables = rt.db
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name NOT LIKE '%_trgm%' ORDER BY name")
    .map((r) => r.name);
  const out: Record<string, string> = {};
  for (const t of tables) {
    const rows = rt.db.all<Record<string, unknown>>(`SELECT * FROM ${t}`);
    const normalized = rows
      .map((r) => {
        const copy: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(r)) {
          if (['updated_at', 'last_checked_at'].includes(k)) continue;
          copy[k] = v instanceof Uint8Array ? Buffer.from(v).toString('base64') : v;
        }
        return JSON.stringify(copy);
      })
      .sort();
    out[t] = createHash('sha256').update(normalized.join('\n')).digest('hex');
  }
  return out;
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor<T>(fn: () => T | Promise<T>, opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${opts.message ?? ''} ${last instanceof Error ? last.message : ''}`);
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 50));
  }
}
