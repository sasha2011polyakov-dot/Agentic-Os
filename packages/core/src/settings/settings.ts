import type { Db } from '../db/db.ts';
import { AppError } from '../util/errors.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { SETTINGS, SETTINGS_BY_KEY, type SettingDef } from './schema.ts';

export type SettingSource = 'default' | 'app' | 'system';

export interface ResolvedSetting<T = unknown> {
  key: string;
  value: T;
  source: SettingSource;
  level: SettingDef['level'];
  label: string;
  description: string;
  appValue?: unknown;
  systemValue?: unknown;
}

function readKv(db: Db, table: 'app_settings' | 'settings', key: string): { found: boolean; value: unknown } {
  const row = db.get<{ value: string }>(`SELECT value FROM ${table} WHERE key = ?`, key);
  return row ? { found: true, value: parseJson(row.value, null) } : { found: false, value: undefined };
}

function writeKv(db: Db, table: 'app_settings' | 'settings', key: string, value: unknown): void {
  db.run(
    `INSERT INTO ${table}(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    nowIso(),
  );
}

function def(key: string): SettingDef {
  const d = SETTINGS_BY_KEY.get(key);
  if (!d) throw new AppError('VALIDATION_FAILED', `Неизвестная настройка: ${key}`);
  return d;
}

function validate(d: SettingDef, value: unknown): void {
  if (d.validate && !d.validate(value)) throw new AppError('VALIDATION_FAILED', `Недопустимое значение настройки «${d.label}».`, { details: { key: d.key } });
}

/** Application-level settings (registry.db). */
export class AppSettings {
  constructor(private readonly registry: Db) {}

  get<T>(key: string): T {
    const d = def(key);
    const r = readKv(this.registry, 'app_settings', key);
    return (r.found ? r.value : d.default) as T;
  }

  /** Stored app value without falling back to the default (used for inheritance display). */
  stored(key: string): { found: boolean; value: unknown } {
    def(key);
    return readKv(this.registry, 'app_settings', key);
  }

  set(key: string, value: unknown): void {
    const d = def(key);
    if (d.level === 'system') throw new AppError('VALIDATION_FAILED', `Настройка «${d.label}» задаётся только для системы.`);
    validate(d, value);
    writeKv(this.registry, 'app_settings', key, value);
  }

  reset(key: string): void {
    def(key);
    this.registry.run('DELETE FROM app_settings WHERE key = ?', key);
  }

  resolvedAll(): ResolvedSetting[] {
    return SETTINGS.filter((d) => d.level !== 'system').map((d) => {
      const r = readKv(this.registry, 'app_settings', d.key);
      return { key: d.key, value: r.found ? r.value : d.default, source: r.found ? 'app' : 'default', level: d.level, label: d.label, description: d.description, ...(r.found ? { appValue: r.value } : {}) };
    });
  }
}

/**
 * Settings of one system with inheritance default → app → system. Bound to a single system's database:
 * changing a value here can never affect another system.
 */
export class SystemSettings {
  constructor(
    private readonly systemDb: Db,
    private readonly app: AppSettings,
  ) {}

  resolve<T>(key: string): ResolvedSetting<T> {
    const d = def(key);
    const base = { key, level: d.level, label: d.label, description: d.description };
    if (d.level === 'app') {
      const stored = this.app.stored(key);
      return { ...base, value: (stored.found ? stored.value : d.default) as T, source: stored.found ? 'app' : 'default' };
    }
    const sys = readKv(this.systemDb, 'settings', key);
    if (d.level === 'system') return { ...base, value: (sys.found ? sys.value : d.default) as T, source: sys.found ? 'system' : 'default', ...(sys.found ? { systemValue: sys.value } : {}) };
    const appRow = this.app.stored(key);
    const appValue = appRow.found ? appRow.value : undefined;
    if (sys.found) return { ...base, value: sys.value as T, source: 'system', systemValue: sys.value, ...(appRow.found ? { appValue } : {}) };
    if (appRow.found) return { ...base, value: appValue as T, source: 'app', appValue };
    return { ...base, value: d.default as T, source: 'default' };
  }

  get<T>(key: string): T {
    return this.resolve<T>(key).value;
  }

  set(key: string, value: unknown): void {
    const d = def(key);
    if (d.level === 'app') throw new AppError('VALIDATION_FAILED', `Настройка «${d.label}» задаётся только на уровне приложения.`);
    validate(d, value);
    writeKv(this.systemDb, 'settings', key, value);
  }

  /** Removes the system override so the app/default value applies again. */
  reset(key: string): void {
    def(key);
    this.systemDb.run('DELETE FROM settings WHERE key = ?', key);
  }

  resolvedAll(): ResolvedSetting[] {
    return SETTINGS.filter((d) => d.level !== 'app').map((d) => this.resolve(d.key));
  }
}
