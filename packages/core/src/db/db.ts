import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { nowIso } from '../util/time.ts';

export type SqlValue = SQLInputValue;

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Thin synchronous adapter over node:sqlite. Services depend on this interface, never on
 * node:sqlite directly, so the driver can be swapped (e.g. better-sqlite3) without touching them.
 */
export interface Db {
  run(sql: string, ...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T>(sql: string, ...params: SqlValue[]): T | undefined;
  all<T>(sql: string, ...params: SqlValue[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  /** Consistent online snapshot of the whole database into a new file. */
  vacuumInto(target: string): void;
  close(): void;
  readonly path: string;
  readonly isOpen: boolean;
}

class SqliteDb implements Db {
  private readonly db: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;
  private open = true;
  readonly path: string;

  constructor(path: string, readOnly = false) {
    this.path = path;
    if (path !== ':memory:' && !readOnly) mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    if (!readOnly) {
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
    }
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
  }

  get isOpen(): boolean {
    return this.open;
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlValue[]) {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  get<T>(sql: string, ...params: SqlValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SqlValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Nested calls use SAVEPOINTs so inner failures roll back only their own work. */
  transaction<T>(fn: () => T): T {
    const outer = this.depth === 0;
    const name = `sp_${this.depth}`;
    this.db.exec(outer ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${name}`);
    this.depth++;
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('Db.transaction callback must be synchronous');
      this.depth--;
      this.db.exec(outer ? 'COMMIT' : `RELEASE ${name}`);
      return result;
    } catch (e) {
      this.depth--;
      this.db.exec(outer ? 'ROLLBACK' : `ROLLBACK TO ${name}; RELEASE ${name}`);
      throw e;
    }
  }

  vacuumInto(target: string): void {
    mkdirSync(dirname(target), { recursive: true });
    this.db.prepare('VACUUM INTO ?').run(target);
  }

  close(): void {
    if (!this.open) return;
    this.cache.clear();
    this.db.close();
    this.open = false;
  }
}

export interface OpenDbOptions {
  migrations: Migration[];
  /** When set and the database already has data, a VACUUM INTO copy is written here before pending migrations run. */
  backupDirBeforeMigrate?: string;
  readOnly?: boolean;
}

export interface OpenDbResult {
  db: Db;
  applied: number[];
  fromVersion: number;
  backupPath?: string;
}

export function openDb(path: string, opts: OpenDbOptions): OpenDbResult {
  const db = new SqliteDb(path, opts.readOnly ?? false);
  if (opts.readOnly) return { db, applied: [], fromVersion: currentSchemaVersion(db) };
  try {
    ensureMigrationTable(db);
    const fromVersion = currentSchemaVersion(db);
    const pending = opts.migrations.filter((m) => m.version > fromVersion);
    let backupPath: string | undefined;
    if (pending.length > 0 && fromVersion > 0 && opts.backupDirBeforeMigrate) {
      backupPath = join(opts.backupDirBeforeMigrate, `before-v${pending[0]!.version}-${nowIso().replace(/[:.]/g, '-')}.db`);
      db.vacuumInto(backupPath);
    }
    const applied = applyMigrations(db, opts.migrations);
    return backupPath ? { db, applied, fromVersion, backupPath } : { db, applied, fromVersion };
  } catch (e) {
    db.close();
    throw e;
  }
}

function ensureMigrationTable(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
}

/** Each migration runs in its own transaction: a failure leaves the schema at the last good version. */
export function applyMigrations(db: Db, migrations: Migration[]): number[] {
  ensureMigrationTable(db);
  const done = new Set(db.all<{ version: number }>('SELECT version FROM schema_migrations').map((r) => r.version));
  const applied: number[] = [];
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.run('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)', m.version, m.name, nowIso());
    });
    applied.push(m.version);
  }
  return applied;
}

export function currentSchemaVersion(db: Db): number {
  try {
    return db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0;
  } catch {
    return 0;
  }
}

export function latestVersion(migrations: Migration[]): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0);
}

export function integrityCheck(db: Db): string[] {
  const rows = db.all<{ integrity_check: string }>('PRAGMA integrity_check');
  const problems = rows.map((r) => r.integrity_check).filter((r) => r !== 'ok');
  const fk = db.all<Record<string, unknown>>('PRAGMA foreign_key_check');
  for (const row of fk) problems.push(`foreign key violation: ${JSON.stringify(row)}`);
  return problems;
}

export function dbFileExists(path: string): boolean {
  return existsSync(path);
}
