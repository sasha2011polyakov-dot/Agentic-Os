import { openDb, currentSchemaVersion, integrityCheck, type Db } from '../db/db.ts';
import { SYSTEM_MIGRATIONS } from '../db/system-migrations.ts';
import { SafeFs } from '../fs/safe-fs.ts';
import { SystemAudit } from '../log/audit.ts';
import { SecurityLog } from '../security/log.ts';
import type { Logger } from '../log/logger.ts';
import { SystemSettings } from '../settings/settings.ts';
import { AppError } from '../util/errors.ts';
import { nowIso } from '../util/time.ts';
import { HistoryStore } from '../vault/history.ts';
import type { EventType } from '../events/bus.ts';
import type { AppServices } from './context.ts';
import { readManifest } from './manifest.ts';
import { systemPaths, type SystemPaths } from './paths.ts';
import type { AccessScope } from '../fs/guard.ts';

/** A disposable piece of background work owned by a runtime (watchers, indexing, workflow engine). */
export interface RuntimeService {
  start?(): Promise<void> | void;
  stop(): Promise<void> | void;
}

/**
 * Everything that belongs to ONE system. Services are constructed with this runtime's db and paths, so a
 * background task started here keeps writing to this system even after the UI switches to another one.
 */
export class SystemRuntime {
  readonly systemId: string;
  readonly paths: SystemPaths;
  readonly db: Db;
  readonly settings: SystemSettings;
  readonly audit: SystemAudit;
  /** Append-only, hash-chained security journal of this system (29.15). */
  readonly security: SecurityLog;
  readonly history: HistoryStore;
  readonly fs: SafeFs;
  readonly log: Logger;
  readonly app: AppServices;
  readonly migratedFrom: number;
  readonly migrationBackup: string | undefined;
  private readonly services = new Map<string, RuntimeService>();
  private readonly owned = new Map<string, unknown>();
  private closed = false;
  readonly openedAt = nowIso();

  private constructor(args: { systemId: string; paths: SystemPaths; db: Db; app: AppServices; migratedFrom: number; migrationBackup?: string }) {
    this.systemId = args.systemId;
    this.paths = args.paths;
    this.db = args.db;
    this.app = args.app;
    this.migratedFrom = args.migratedFrom;
    this.migrationBackup = args.migrationBackup;
    this.settings = new SystemSettings(this.db, args.app.appSettings);
    this.audit = new SystemAudit(this.db);
    this.security = new SecurityLog(this.db, args.systemId);
    this.history = new HistoryStore(this.db, this.settings.get<number>('history.maxVersions'));
    this.fs = new SafeFs(this.history);
    this.log = args.app.logger.child({ systemId: args.systemId });
  }

  /**
   * Opens a system folder: verifies the passport matches the expected id (protects against a different
   * system placed at the registered path), migrates the schema with a pre-migration backup.
   */
  static async open(storagePath: string, expectedSystemId: string | null, app: AppServices): Promise<SystemRuntime> {
    const manifest = await readManifest(storagePath);
    if (expectedSystemId && manifest.systemId !== expectedSystemId) {
      throw new AppError('SYSTEM_UNAVAILABLE', 'По сохранённому пути находится другая система.', {
        hint: 'Папку могли заменить. Укажите правильное расположение системы или подключите найденную систему отдельно.',
        details: { expected: expectedSystemId, found: manifest.systemId, path: storagePath },
      });
    }
    const paths = systemPaths(storagePath);
    const { db, fromVersion, backupPath } = openDb(paths.db, { migrations: SYSTEM_MIGRATIONS, backupDirBeforeMigrate: paths.migrationBackups });
    const metaId = db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'system_id'")?.value;
    if (metaId && metaId !== manifest.systemId) {
      db.close();
      throw new AppError('SYSTEM_UNAVAILABLE', 'Идентификатор в базе системы не совпадает с паспортом system.json.', { details: { manifest: manifest.systemId, db: metaId } });
    }
    if (!metaId) {
      db.run("INSERT INTO meta(key, value) VALUES ('system_id', ?)", manifest.systemId);
      db.run("INSERT OR IGNORE INTO meta(key, value) VALUES ('created_at', ?)", manifest.createdAt);
    }
    const rt = new SystemRuntime({ systemId: manifest.systemId, paths, db, app, migratedFrom: fromVersion, ...(backupPath ? { migrationBackup: backupPath } : {}) });
    rt.ensurePrimaryVault();
    return rt;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get schemaVersion(): number {
    return currentSchemaVersion(this.db);
  }

  assertOpen(): void {
    if (this.closed) throw new AppError('SYSTEM_DISCONNECTED');
  }

  emit(type: EventType, data: unknown): void {
    this.app.events.emit(type, data, this.systemId);
  }

  /** Scope covering the system's own vault (writable). */
  vaultScope(): AccessScope {
    return { roots: [this.paths.root], writable: true, label: 'vault' };
  }

  primaryVaultId(): string {
    return `src_vault_${this.systemId.slice(4)}`;
  }

  private ensurePrimaryVault(): void {
    const id = this.primaryVaultId();
    const exists = this.db.get<{ id: string }>('SELECT id FROM sources WHERE id = ?', id);
    if (exists) {
      // keep root_path in sync if the system folder was relocated
      this.db.run('UPDATE sources SET root_path = ? WHERE id = ? AND root_path <> ?', this.paths.root, id, this.paths.root);
      return;
    }
    const now = nowIso();
    this.db.run(
      `INSERT INTO sources(id, kind, name, root_path, purpose, writable, created_at, updated_at, status)
       VALUES (?, 'vault', ?, ?, ?, 1, ?, ?, 'pending')`,
      id,
      'Хранилище системы',
      this.paths.root,
      'Документы и заметки этой системы',
      now,
      now,
    );
  }

  // --- service registry: domain services attach themselves here (see app.ts wiring) ---

  register<T extends RuntimeService>(name: string, service: T): T {
    this.services.set(name, service);
    return service;
  }

  setOwned<T>(name: string, value: T): T {
    this.owned.set(name, value);
    return value;
  }

  getOwned<T>(name: string): T {
    const v = this.owned.get(name);
    if (v === undefined) throw new AppError('INTERNAL', `Сервис «${name}» не инициализирован для системы.`);
    return v as T;
  }

  async startServices(): Promise<void> {
    for (const [name, s] of this.services) {
      try {
        await s.start?.();
      } catch (e) {
        this.log.error('service start failed', { service: name, error: e as Error });
      }
    }
  }

  integrity(): string[] {
    return integrityCheck(this.db);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [name, s] of [...this.services].reverse()) {
      try {
        await s.stop();
      } catch (e) {
        this.log.warn('service stop failed', { service: name, error: e as Error });
      }
    }
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      // ignore
    }
    this.db.close();
  }
}
