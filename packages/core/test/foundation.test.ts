import { describe, expect, it } from 'vitest';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyMigrations, currentSchemaVersion, openDb, type Migration } from '../src/db/db.ts';
import { SYSTEM_MIGRATIONS } from '../src/db/system-migrations.ts';
import { ulid } from '../src/util/ids.ts';
import { redact, registerSecretValue } from '../src/util/redact.ts';
import { extractJson, getPath } from '../src/util/json.ts';
import { formatDate } from '../src/util/time.ts';
import { assertInScope, normalizeRelPath } from '../src/fs/guard.ts';
import { SafeFs } from '../src/fs/safe-fs.ts';
import { HistoryStore } from '../src/vault/history.ts';
import { NetworkPolicy, isLoopbackHost } from '../src/net/policy.ts';
import { AppError } from '../src/util/errors.ts';
import { removeDir, tempDir } from './helpers.ts';

describe('db', () => {
  it('applies system migrations and reports the schema version', () => {
    const { db, applied } = openDb(':memory:', { migrations: SYSTEM_MIGRATIONS });
    const versions = SYSTEM_MIGRATIONS.map((m) => m.version);
    expect(applied).toEqual(versions);
    expect(currentSchemaVersion(db)).toBe(versions[versions.length - 1]);
    const fts = db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE name = 'documents_fts'");
    expect(fts?.name).toBe('documents_fts');
    db.close();
  });

  it('upgrades a system database created by an older version without losing missions', () => {
    const { db } = openDb(':memory:', { migrations: SYSTEM_MIGRATIONS.filter((m) => m.version === 1) });
    db.run("INSERT INTO missions(id, key, title, original_request, mode, status, phase, priority, scope, policy, limits, created_at, updated_at) VALUES ('m1', 'M-001', 't', 'r', 'execute', 'draft', 'analysis', 'medium', '{}', '{}', '{}', 'x', 'x')");
    const applied = applyMigrations(db, SYSTEM_MIGRATIONS);
    expect(applied).toEqual(SYSTEM_MIGRATIONS.filter((m) => m.version > 1).map((m) => m.version));
    expect(db.get<{ gaps: string }>("SELECT gaps FROM missions WHERE id = 'm1'")?.gaps).toBe('[]');
    db.close();
  });

  it('rolls back a failing migration and keeps the previous version', () => {
    const { db } = openDb(':memory:', { migrations: [{ version: 1, name: 'a', sql: 'CREATE TABLE a(x)' }] });
    const bad: Migration[] = [
      { version: 1, name: 'a', sql: 'CREATE TABLE a(x)' },
      { version: 2, name: 'b', sql: 'CREATE TABLE b(x); INSERT INTO nope VALUES (1);' },
    ];
    expect(() => applyMigrations(db, bad)).toThrow();
    expect(currentSchemaVersion(db)).toBe(1);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'b'")).toBeUndefined();
    db.close();
  });

  it('nested transactions roll back only the inner savepoint', () => {
    const { db } = openDb(':memory:', { migrations: [{ version: 1, name: 't', sql: 'CREATE TABLE t(x INTEGER)' }] });
    db.transaction(() => {
      db.run('INSERT INTO t VALUES (1)');
      try {
        db.transaction(() => {
          db.run('INSERT INTO t VALUES (2)');
          throw new Error('inner');
        });
      } catch {
        // expected
      }
    });
    expect(db.all<{ x: number }>('SELECT x FROM t').map((r) => r.x)).toEqual([1]);
    db.close();
  });

  it('backs up the database before migrating an existing schema', async () => {
    const dir = await tempDir();
    try {
      const path = join(dir, 'x.db');
      const v1: Migration[] = [{ version: 1, name: 'one', sql: 'CREATE TABLE t(x)' }];
      openDb(path, { migrations: v1 }).db.close();
      const v2: Migration[] = [...v1, { version: 2, name: 'two', sql: 'ALTER TABLE t ADD COLUMN y' }];
      const res = openDb(path, { migrations: v2, backupDirBeforeMigrate: join(dir, 'bk') });
      expect(res.backupPath).toBeDefined();
      expect(res.applied).toEqual([2]);
      res.db.close();
      const backup = openDb(res.backupPath!, { migrations: [], readOnly: true });
      expect(currentSchemaVersion(backup.db)).toBe(1);
      backup.db.close();
    } finally {
      await removeDir(dir);
    }
  });
});

describe('utils', () => {
  it('generates sortable unique ULIDs', () => {
    const ids = Array.from({ length: 1000 }, () => ulid());
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
    expect(ids[0]).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('redacts registered secrets and key patterns', () => {
    registerSecretValue('my-very-private-value-123');
    const out = redact('key=my-very-private-value-123 and sk-abcdefghijklmnopqrstuvwxyz012345 and Authorization: Bearer abcdef123456789');
    expect(out).not.toContain('my-very-private-value-123');
    expect(out).not.toContain('sk-' + 'abcdefghijklmnopqrstuvwxyz012345');
    expect(out).not.toContain('abcdef123456789');
  });

  it('extracts JSON from model output with prose and fences', () => {
    expect(extractJson('Sure! ```json\n{"a": 1}\n``` done')).toEqual({ a: 1 });
    expect(extractJson('Result: {"a": {"b": [1, 2]}} trailing')).toEqual({ a: { b: [1, 2] } });
    expect(extractJson('no json here')).toBeUndefined();
    expect(getPath({ a: { b: [{ c: 5 }] } }, 'a.b.0.c')).toBe(5);
  });

  it('formats dates with Moment-style tokens', () => {
    const d = new Date(2026, 9, 12, 9, 5);
    expect(formatDate(d, 'YYYY-MM-DD')).toBe('2026-10-12');
    expect(formatDate(d, 'YYYY/MMMM/YYYY-MMM-DD [at] HH:mm')).toBe('2026/October/2026-Oct-12 at 09:05');
  });
});

describe('path guard', () => {
  it('rejects traversal and invalid names', () => {
    expect(() => normalizeRelPath('../etc/passwd')).toThrow(AppError);
    expect(() => normalizeRelPath('/abs/path.md')).toThrow(AppError);
    expect(() => normalizeRelPath('a/CON.md')).toThrow(AppError);
    expect(() => normalizeRelPath('bad:name.md')).toThrow(AppError);
    expect(normalizeRelPath('./notes//a.md')).toBe('notes/a.md');
  });

  it('blocks symlink escapes out of the scope root', async () => {
    const dir = await tempDir();
    try {
      const root = join(dir, 'vault');
      const outside = join(dir, 'outside');
      await mkdir(root, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, 'secret.txt'), 'secret');
      await symlink(outside, join(root, 'link'));
      const scope = { roots: [root], writable: true };
      await expect(assertInScope(join(root, 'link', 'secret.txt'), scope)).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
      await expect(assertInScope(join(root, 'note.md'), scope)).resolves.toBeTypeOf('string');
      await expect(assertInScope(join(root, '.aos', 'system.db'), scope, { write: true })).rejects.toMatchObject({ code: 'PATH_OUTSIDE_SCOPE' });
      await expect(assertInScope(join(root, 'x.md'), { roots: [root], writable: false }, { write: true })).rejects.toMatchObject({ code: 'READ_ONLY_SOURCE' });
    } finally {
      await removeDir(dir);
    }
  });
});

describe('safe fs', () => {
  it('writes atomically, snapshots history and detects external conflicts', async () => {
    const dir = await tempDir();
    try {
      const { db } = openDb(':memory:', { migrations: SYSTEM_MIGRATIONS });
      const history = new HistoryStore(db);
      const fs = new SafeFs(history);
      const scope = { roots: [dir], writable: true };
      const file = join(dir, 'a.md');
      const h = { sourceId: 's', relPath: 'a.md', docId: null };
      const w1 = await fs.writeText(file, 'v1', { scope, expectedHash: null, reason: 'create', actor: 'user', history: h });
      expect(w1.created).toBe(true);
      await expect(fs.writeText(file, 'dup', { scope, expectedHash: null, reason: 'create', actor: 'user' })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
      const w2 = await fs.writeText(file, 'v2', { scope, expectedHash: w1.hash, reason: 'edit', actor: 'user', history: h });
      expect(w2.previousHash).toBe(w1.hash);
      // external modification
      await writeFile(file, 'external');
      await expect(fs.writeText(file, 'v3', { scope, expectedHash: w2.hash, reason: 'edit', actor: 'user', history: h })).rejects.toMatchObject({ code: 'WRITE_CONFLICT' });
      expect(await readFile(file, 'utf8')).toBe('external');
      const versions = history.list('s', 'a.md');
      expect(versions.map((v) => history.get(v.id)?.content)).toEqual(['v1']);
      db.close();
    } finally {
      await removeDir(dir);
    }
  });
});

describe('network policy', () => {
  it('blocks everything but loopback offline and cloud in local mode', () => {
    let state = { offline: true, aiMode: 'hybrid' as const };
    const policy = new NetworkPolicy(() => state);
    expect(() => policy.check(new URL('https://api.example.com'), 'web-research')).toThrow(expect.objectContaining({ code: 'OFFLINE_MODE' }));
    expect(() => policy.check(new URL('http://127.0.0.1:11434'), 'ai-local')).not.toThrow();
    state = { offline: false, aiMode: 'local' as never };
    expect(() => policy.check(new URL('https://api.anthropic.com/v1/messages'), 'ai-cloud')).toThrow(expect.objectContaining({ code: 'NETWORK_POLICY_DENIED' }));
    expect(() => policy.check(new URL('https://evil.example.com'), 'ai-local')).toThrow(expect.objectContaining({ code: 'NETWORK_POLICY_DENIED' }));
    expect(() => policy.check(new URL('file:///etc/passwd'), 'web-research')).toThrow();
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
  });
});
