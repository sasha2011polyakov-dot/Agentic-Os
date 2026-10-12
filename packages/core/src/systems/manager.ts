import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { AppError, errorMessage, toAppError } from '../util/errors.ts';
import { ulid } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import { isInside, realpathLoose } from '../fs/guard.ts';
import { atomicWrite, exists } from '../fs/safe-fs.ts';
import { latestVersion } from '../db/db.ts';
import { SYSTEM_MIGRATIONS } from '../db/system-migrations.ts';
import type { AppServices } from './context.ts';
import { readManifest, writeManifest, SYSTEM_FORMAT, SYSTEM_FORMAT_VERSION, type SystemManifest } from './manifest.ts';
import { AOS_DIR, systemPaths } from './paths.ts';
import { SystemRegistry, type SystemRecord, type SystemStatus } from './registry.ts';
import { SystemRuntime } from './runtime.ts';
import { STARTER_FILES } from './starter.ts';

export interface SystemStats {
  documents: number | null;
  projects: number | null;
  agents: number | null;
  activeRuns: number | null;
  indexing: boolean;
}

export interface SystemInfo extends SystemRecord {
  isActive: boolean;
  isOpen: boolean;
  stats: SystemStats;
}

/** Wiring points so domain services can be attached without the manager knowing about them. */
export interface RuntimeHooks {
  onOpen(rt: SystemRuntime): Promise<void>;
  stats(rt: SystemRuntime): SystemStats;
  activeRuns(rt: SystemRuntime): number;
  pauseRuns(rt: SystemRuntime): Promise<void>;
  cancelRuns(rt: SystemRuntime): Promise<void>;
}

export const noopHooks: RuntimeHooks = {
  async onOpen() {},
  stats: () => ({ documents: null, projects: null, agents: null, activeRuns: null, indexing: false }),
  activeRuns: () => 0,
  async pauseRuns() {},
  async cancelRuns() {},
};

export interface CreateSystemInput {
  name: string;
  description?: string;
  storagePath: string;
  template?: 'empty' | 'starter';
  /** Allow creating the system inside an existing non-empty folder (e.g. an Obsidian vault). Only .aos/ is added. */
  adoptExistingFolder?: boolean;
  icon?: string;
  color?: string;
}

export type ActiveRunsPolicy = 'refuse' | 'pause' | 'cancel';

const PALETTE = ['#4f6bed', '#0e9f6e', '#d97706', '#db2777', '#7c3aed', '#0891b2', '#65a30d', '#dc2626'];

/**
 * Lifecycle of systems. Invariant: an operation on system X never modifies data of any other system —
 * each runtime owns a separate database and folder, and the registry only stores metadata.
 */
export class SystemManager {
  readonly registry: SystemRegistry;
  private readonly runtimes = new Map<string, SystemRuntime>();
  private readonly opening = new Map<string, Promise<SystemRuntime>>();
  hooks: RuntimeHooks = noopHooks;

  constructor(private readonly app: AppServices) {
    this.registry = new SystemRegistry(app.registryDb);
  }

  // ---------- startup / availability ----------

  async startup(): Promise<void> {
    const interrupted = this.registry.markInterruptedOperations();
    if (interrupted) this.app.logger.warn('interrupted registry operations found', { count: interrupted });
    for (const rec of this.registry.list()) {
      const status = await this.checkAvailability(rec.systemId);
      if (status === 'connected') {
        try {
          await this.runtime(rec.systemId);
        } catch (e) {
          // One broken system must never prevent the others from opening.
          this.app.logger.error('system failed to open on startup', { systemId: rec.systemId, error: e as Error });
        }
      }
    }
  }

  /** Re-checks the storage folder. Unavailable systems are marked, never removed. */
  async checkAvailability(systemId: string): Promise<SystemStatus> {
    const rec = this.registry.require(systemId);
    const now = nowIso();
    if (rec.status === 'disconnected') {
      this.registry.update(systemId, { lastCheckedAt: now });
      return 'disconnected';
    }
    try {
      const manifest = await readManifest(rec.storagePath);
      if (manifest.systemId !== systemId) {
        this.registry.update(systemId, { status: 'error', statusDetail: `В папке находится другая система (${manifest.systemId}).`, lastCheckedAt: now });
        return 'error';
      }
      if (rec.status !== 'connected' || rec.statusDetail) this.registry.update(systemId, { status: 'connected', statusDetail: null, lastCheckedAt: now });
      else this.registry.update(systemId, { lastCheckedAt: now });
      return 'connected';
    } catch (e) {
      const err = toAppError(e);
      const detail = err.code === 'SYSTEM_NOT_FOUND_AT_PATH' ? 'Папка системы не найдена или в ней нет .aos/system.json.' : err.message;
      this.registry.update(systemId, { status: 'unavailable', statusDetail: detail, lastCheckedAt: now });
      const rt = this.runtimes.get(systemId);
      if (rt) await this.closeRuntime(systemId);
      return 'unavailable';
    }
  }

  // ---------- access ----------

  isOpen(systemId: string): boolean {
    const rt = this.runtimes.get(systemId);
    return !!rt && !rt.isClosed;
  }

  openRuntimes(): SystemRuntime[] {
    return [...this.runtimes.values()].filter((r) => !r.isClosed);
  }

  /** Returns the runtime bound to systemId, opening it on first use. Never returns another system's runtime. */
  async runtime(systemId: string): Promise<SystemRuntime> {
    const existing = this.runtimes.get(systemId);
    if (existing && !existing.isClosed) return existing;
    const pending = this.opening.get(systemId);
    if (pending) return pending;
    const rec = this.registry.require(systemId);
    if (rec.status === 'disconnected') throw new AppError('SYSTEM_DISCONNECTED', undefined, { details: { systemId, name: rec.name } });
    const p = (async () => {
      try {
        const rt = await SystemRuntime.open(rec.storagePath, systemId, this.app);
        try {
          await this.hooks.onOpen(rt);
          await rt.startServices();
        } catch (e) {
          await rt.close();
          throw e;
        }
        this.runtimes.set(systemId, rt);
        this.registry.update(systemId, { status: 'connected', statusDetail: null, schemaVersion: rt.schemaVersion });
        if (rt.migrationBackup) {
          this.app.registryAudit.record({ actor: 'system', action: 'system.migrate', systemId, details: { from: rt.migratedFrom, to: rt.schemaVersion, backup: rt.migrationBackup } });
        }
        return rt;
      } catch (e) {
        const err = toAppError(e);
        const status: SystemStatus = err.code === 'SYSTEM_NOT_FOUND_AT_PATH' || err.code === 'SYSTEM_UNAVAILABLE' ? 'unavailable' : 'error';
        this.registry.update(systemId, { status, statusDetail: err.message });
        if (err.code === 'SYSTEM_NOT_FOUND_AT_PATH') throw new AppError('SYSTEM_UNAVAILABLE', undefined, { details: { systemId, path: rec.storagePath }, cause: e });
        throw err;
      } finally {
        this.opening.delete(systemId);
      }
    })();
    this.opening.set(systemId, p);
    return p;
  }

  info(rec: SystemRecord): SystemInfo {
    const rt = this.runtimes.get(rec.systemId);
    const open = !!rt && !rt.isClosed;
    let stats: SystemStats = { documents: null, projects: null, agents: null, activeRuns: null, indexing: false };
    if (open) {
      try {
        stats = this.hooks.stats(rt);
      } catch {
        // stats are best-effort
      }
    }
    return { ...rec, isActive: this.activeSystemId() === rec.systemId, isOpen: open, stats };
  }

  list(): SystemInfo[] {
    return this.registry.list().map((r) => this.info(r));
  }

  get(systemId: string): SystemInfo {
    return this.info(this.registry.require(systemId));
  }

  activeSystemId(): string | null {
    const id = this.app.appSettings.get<string | null>('ui.activeSystemId');
    if (id && this.registry.get(id)) return id;
    return null;
  }

  /** Switching only changes the UI context; no system is closed or modified (except its last_opened_at). */
  async switchTo(systemId: string): Promise<SystemInfo> {
    this.registry.require(systemId);
    await this.runtime(systemId);
    this.app.appSettings.set('ui.activeSystemId', systemId);
    this.registry.update(systemId, { lastOpenedAt: nowIso() });
    this.app.events.emit('systems.changed', { reason: 'switch', systemId });
    return this.get(systemId);
  }

  // ---------- create / attach ----------

  private async assertNoOverlap(target: string, ignoreSystemId?: string): Promise<void> {
    const real = await realpathLoose(target);
    const dataDir = await realpathLoose(this.app.paths.dataDir);
    if (isInside(real, dataDir) || isInside(dataDir, real)) {
      throw new AppError('SYSTEM_PATH_CONFLICT', 'Нельзя размещать систему в папке данных приложения или выше неё.');
    }
    for (const rec of this.registry.list()) {
      if (rec.systemId === ignoreSystemId) continue;
      const other = await realpathLoose(rec.storagePath);
      if (isInside(real, other) || isInside(other, real)) {
        throw new AppError('SYSTEM_PATH_CONFLICT', undefined, { details: { conflictsWith: { systemId: rec.systemId, name: rec.name, path: rec.storagePath } } });
      }
    }
  }

  async create(input: CreateSystemInput): Promise<SystemInfo> {
    const name = input.name.trim();
    if (!name || name.length > 120) throw new AppError('VALIDATION_FAILED', 'Название системы должно содержать от 1 до 120 символов.');
    if (!isAbsolute(input.storagePath)) throw new AppError('VALIDATION_FAILED', 'Укажите абсолютный путь к папке хранилища.');
    const storagePath = resolve(input.storagePath);
    await this.assertNoOverlap(storagePath);

    let createdFolder = false;
    if (await exists(storagePath)) {
      const st = await stat(storagePath);
      if (!st.isDirectory()) throw new AppError('VALIDATION_FAILED', 'По указанному пути находится файл, а не папка.');
      if (await exists(systemPaths(storagePath).manifest)) {
        throw new AppError('VALIDATION_FAILED', 'В этой папке уже есть система Agentic OS.', { hint: 'Используйте «Подключить существующую».' });
      }
      const entries = (await readdir(storagePath)).filter((e) => e !== '.DS_Store');
      if (entries.length > 0 && !input.adoptExistingFolder) {
        throw new AppError('VALIDATION_FAILED', 'Папка не пуста.', { hint: 'Выберите пустую папку или включите «Создать систему в существующей папке» — тогда будет добавлена только служебная папка .aos, ваши файлы не изменятся.' });
      }
    } else {
      await mkdir(storagePath, { recursive: true });
      createdFolder = true;
    }

    const systemId = `sys_${ulid()}`;
    const opId = this.registry.startOperation('system.create', systemId, { name, storagePath });
    const createdAt = nowIso();
    let rt: SystemRuntime | null = null;
    try {
      await mkdir(systemPaths(storagePath).aosDir, { recursive: true });
      const manifest: SystemManifest = { format: SYSTEM_FORMAT, formatVersion: SYSTEM_FORMAT_VERSION, systemId, name, createdAt };
      await writeManifest(storagePath, manifest);
      this.registry.addStep(opId, { name: 'Паспорт системы записан', status: 'done' });

      if (input.template === 'starter') {
        for (const f of STARTER_FILES) {
          const target = join(storagePath, f.path);
          if (!(await exists(target))) await atomicWrite(target, f.content);
        }
        this.registry.addStep(opId, { name: 'Стартовые заметки созданы', status: 'done' });
      }

      const count = this.registry.list().length;
      this.registry.insert({
        systemId,
        name,
        description: input.description?.trim() ?? '',
        icon: input.icon ?? 'library',
        color: input.color ?? PALETTE[count % PALETTE.length]!,
        storagePath,
        status: 'connected',
        schemaVersion: latestVersion(SYSTEM_MIGRATIONS),
        settings: {},
        createdAt,
        lastOpenedAt: null,
      });
      this.registry.addStep(opId, { name: 'Система зарегистрирована', status: 'done' });

      rt = await this.runtime(systemId);
      rt.audit.record({ actor: 'user', action: 'system.create', target: systemId, details: { name } });
      this.registry.addStep(opId, { name: 'База системы создана', status: 'done' });
      this.registry.finishOperation(opId, 'completed');
      this.app.registryAudit.record({ actor: 'user', action: 'system.create', systemId, details: { name, storagePath } });
      if (!this.activeSystemId()) this.app.appSettings.set('ui.activeSystemId', systemId);
      this.app.events.emit('systems.changed', { reason: 'create', systemId });
      return this.get(systemId);
    } catch (e) {
      // Roll back only what this operation created. Pre-existing user files are never touched.
      this.registry.addStep(opId, { name: 'Ошибка', status: 'failed', detail: errorMessage(e) });
      if (rt) await this.closeRuntime(systemId);
      this.registry.remove(systemId);
      await rm(systemPaths(storagePath).aosDir, { recursive: true, force: true }).catch(() => {});
      if (createdFolder) await rm(storagePath, { recursive: true, force: true }).catch(() => {});
      this.registry.finishOperation(opId, 'failed', errorMessage(e));
      this.app.registryAudit.record({ actor: 'user', action: 'system.create', systemId, outcome: 'error', details: { error: errorMessage(e) } });
      throw toAppError(e);
    }
  }

  /** Inspects a folder before attaching: tells the UI whether it is a system and whether its id is already registered. */
  async inspectFolder(storagePath: string): Promise<{ manifest: SystemManifest; registered: SystemRecord | null; samePath: boolean }> {
    const p = resolve(storagePath);
    const manifest = await readManifest(p);
    const registered = this.registry.get(manifest.systemId);
    const samePath = !!registered && (await realpathLoose(registered.storagePath)) === (await realpathLoose(p));
    return { manifest, registered, samePath };
  }

  /**
   * Attaches an existing system folder. If its id is already registered elsewhere the caller must choose:
   * open the existing one (no-op), or attach as a copy with a NEW id (asCopy) — never a silent merge/overwrite.
   */
  async attach(storagePath: string, opts: { asCopy?: boolean; name?: string } = {}): Promise<SystemInfo> {
    const p = resolve(storagePath);
    const { manifest, registered, samePath } = await this.inspectFolder(p);
    if (registered && samePath) {
      if (registered.status === 'disconnected') return this.reconnect(registered.systemId);
      return this.get(registered.systemId);
    }
    if (registered && !opts.asCopy) {
      throw new AppError('SYSTEM_ID_CONFLICT', undefined, { details: { systemId: manifest.systemId, existing: { name: registered.name, path: registered.storagePath, status: registered.status }, found: { name: manifest.name, path: p } } });
    }
    await this.assertNoOverlap(p);
    let finalManifest = manifest;
    const opId = this.registry.startOperation(opts.asCopy ? 'system.attach-copy' : 'system.attach', manifest.systemId, { path: p });
    try {
      if (registered && opts.asCopy) {
        finalManifest = { ...manifest, systemId: `sys_${ulid()}`, name: opts.name ?? `${manifest.name} (копия)` };
        await reassignSystemId(p, manifest.systemId, finalManifest, this.app);
        this.registry.addStep(opId, { name: 'Копии присвоен новый идентификатор', status: 'done', detail: finalManifest.systemId });
      }
      this.registry.insert({
        systemId: finalManifest.systemId,
        name: opts.name ?? finalManifest.name,
        description: '',
        icon: 'library',
        color: PALETTE[this.registry.list().length % PALETTE.length]!,
        storagePath: p,
        status: 'connected',
        schemaVersion: 0,
        settings: {},
        createdAt: finalManifest.createdAt,
        lastOpenedAt: null,
      });
      await this.runtime(finalManifest.systemId);
      this.registry.addStep(opId, { name: 'Система подключена', status: 'done' });
      this.registry.finishOperation(opId, 'completed');
      this.app.registryAudit.record({ actor: 'user', action: opts.asCopy ? 'system.attach-copy' : 'system.attach', systemId: finalManifest.systemId, details: { path: p } });
      this.app.events.emit('systems.changed', { reason: 'attach', systemId: finalManifest.systemId });
      return this.get(finalManifest.systemId);
    } catch (e) {
      if (this.registry.get(finalManifest.systemId) && !registered) this.registry.remove(finalManifest.systemId);
      if (registered && opts.asCopy && this.registry.get(finalManifest.systemId)) this.registry.remove(finalManifest.systemId);
      this.registry.finishOperation(opId, 'failed', errorMessage(e));
      throw toAppError(e);
    }
  }

  // ---------- metadata ----------

  async update(systemId: string, patch: { name?: string; description?: string; icon?: string; color?: string }): Promise<SystemInfo> {
    const rec = this.registry.require(systemId);
    const clean: { name?: string; description?: string; icon?: string; color?: string } = {};
    if (patch.name !== undefined) {
      const n = patch.name.trim();
      if (!n || n.length > 120) throw new AppError('VALIDATION_FAILED', 'Название системы должно содержать от 1 до 120 символов.');
      clean.name = n;
    }
    if (patch.description !== undefined) clean.description = patch.description.slice(0, 2000);
    if (patch.icon !== undefined) clean.icon = patch.icon.slice(0, 40);
    if (patch.color !== undefined) {
      if (!/^#[0-9a-fA-F]{6}$/.test(patch.color)) throw new AppError('VALIDATION_FAILED', 'Цвет задаётся в формате #RRGGBB.');
      clean.color = patch.color;
    }
    this.registry.update(systemId, clean);
    if (clean.name && clean.name !== rec.name) {
      // Best effort: keep the passport's display name in sync (identity is the id, which never changes).
      try {
        const m = await readManifest(rec.storagePath);
        if (m.systemId === systemId) await writeManifest(rec.storagePath, { ...m, name: clean.name });
      } catch {
        this.app.logger.warn('could not update system.json name', { systemId });
      }
    }
    this.app.registryAudit.record({ actor: 'user', action: 'system.update', systemId, details: clean });
    this.app.events.emit('systems.changed', { reason: 'update', systemId });
    return this.get(systemId);
  }

  /** Points a moved system at its new folder after verifying the passport id matches. */
  async relocate(systemId: string, newPath: string): Promise<SystemInfo> {
    this.registry.require(systemId);
    const p = resolve(newPath);
    const manifest = await readManifest(p);
    if (manifest.systemId !== systemId) {
      throw new AppError('SYSTEM_ID_CONFLICT', 'В выбранной папке находится другая система.', { details: { expected: systemId, found: manifest.systemId } });
    }
    await this.assertNoOverlap(p, systemId);
    await this.closeRuntime(systemId);
    this.registry.update(systemId, { storagePath: p, status: 'connected', statusDetail: null });
    await this.runtime(systemId);
    this.app.registryAudit.record({ actor: 'user', action: 'system.relocate', systemId, details: { path: p } });
    this.app.events.emit('systems.changed', { reason: 'relocate', systemId });
    return this.get(systemId);
  }

  // ---------- disconnect / reconnect ----------

  private async handleActiveRuns(rt: SystemRuntime, policy: ActiveRunsPolicy): Promise<void> {
    const active = this.hooks.activeRuns(rt);
    if (active === 0) return;
    if (policy === 'refuse') throw new AppError('SYSTEM_HAS_ACTIVE_RUNS', undefined, { details: { activeRuns: active } });
    if (policy === 'pause') await this.hooks.pauseRuns(rt);
    else await this.hooks.cancelRuns(rt);
  }

  async disconnect(systemId: string, policy: ActiveRunsPolicy = 'refuse'): Promise<SystemInfo> {
    this.registry.require(systemId);
    const rt = this.runtimes.get(systemId);
    if (rt && !rt.isClosed) await this.handleActiveRuns(rt, policy);
    await this.closeRuntime(systemId);
    this.registry.update(systemId, { status: 'disconnected', statusDetail: null });
    if (this.activeSystemId() === systemId) this.app.appSettings.set('ui.activeSystemId', this.firstConnectedId(systemId));
    this.app.registryAudit.record({ actor: 'user', action: 'system.disconnect', systemId, details: { policy } });
    this.app.events.emit('systems.changed', { reason: 'disconnect', systemId });
    return this.get(systemId);
  }

  async reconnect(systemId: string): Promise<SystemInfo> {
    this.registry.require(systemId);
    this.registry.update(systemId, { status: 'connected', statusDetail: null });
    const status = await this.checkAvailability(systemId);
    if (status === 'connected') await this.runtime(systemId);
    this.app.registryAudit.record({ actor: 'user', action: 'system.reconnect', systemId, outcome: status === 'connected' ? 'ok' : 'error' });
    this.app.events.emit('systems.changed', { reason: 'reconnect', systemId });
    return this.get(systemId);
  }

  private firstConnectedId(except: string): string | null {
    return this.registry.list().find((r) => r.systemId !== except && r.status === 'connected')?.systemId ?? null;
  }

  async closeRuntime(systemId: string): Promise<void> {
    const rt = this.runtimes.get(systemId);
    this.runtimes.delete(systemId);
    if (rt) await rt.close();
  }

  // ---------- removal ----------

  /** Removes the registration only. Files stay exactly where they are and can be attached again. */
  async forget(systemId: string, policy: ActiveRunsPolicy = 'refuse'): Promise<void> {
    const rec = this.registry.require(systemId);
    const rt = this.runtimes.get(systemId);
    if (rt && !rt.isClosed) await this.handleActiveRuns(rt, policy);
    await this.closeRuntime(systemId);
    this.registry.remove(systemId);
    if (this.activeSystemId() === systemId || this.app.appSettings.get('ui.activeSystemId') === systemId) {
      this.app.appSettings.set('ui.activeSystemId', this.firstConnectedId(systemId));
    }
    this.app.registryAudit.record({ actor: 'user', action: 'system.forget', systemId, details: { name: rec.name, path: rec.storagePath } });
    this.app.events.emit('systems.changed', { reason: 'forget', systemId });
  }

  /** What a physical deletion would remove — shown to the user before confirmation. */
  async deletionPlan(systemId: string): Promise<{ systemId: string; name: string; storagePath: string; serviceDataPath: string; documentFiles: number; totalFiles: number; totalBytes: number; backups: string[]; activeRuns: number }> {
    const rec = this.registry.require(systemId);
    const counts = await countFiles(rec.storagePath);
    const rt = this.runtimes.get(systemId);
    const backupsDir = join(this.app.paths.backupsDir, systemId);
    const backups = (await exists(backupsDir)) ? (await readdir(backupsDir)).filter((f) => f.endsWith('.aosys')) : [];
    return {
      systemId,
      name: rec.name,
      storagePath: rec.storagePath,
      serviceDataPath: systemPaths(rec.storagePath).aosDir,
      documentFiles: counts.userFiles,
      totalFiles: counts.total,
      totalBytes: counts.bytes,
      backups,
      activeRuns: rt && !rt.isClosed ? this.hooks.activeRuns(rt) : 0,
    };
  }

  /**
   * Physical deletion — a separate, explicitly confirmed procedure. mode 'service-data' removes only .aos/
   * (index, history, agents); 'everything' removes the whole system folder. Each step is journaled, and the
   * result is reported as 'partial' if anything failed.
   */
  async deleteData(systemId: string, opts: { mode: 'service-data' | 'everything'; confirmName: string; activeRuns?: ActiveRunsPolicy }): Promise<{ status: 'completed' | 'partial'; steps: { name: string; status: string; detail?: string }[] }> {
    const rec = this.registry.require(systemId);
    if (opts.confirmName !== rec.name) throw new AppError('CONFIRMATION_REQUIRED', 'Введённое название не совпадает с названием системы.');
    const opId = this.registry.startOperation('system.delete-data', systemId, { mode: opts.mode, path: rec.storagePath, name: rec.name });
    const rt = this.runtimes.get(systemId);
    if (rt && !rt.isClosed) {
      try {
        await this.handleActiveRuns(rt, opts.activeRuns ?? 'refuse');
      } catch (e) {
        this.registry.finishOperation(opId, 'failed', errorMessage(e));
        throw e;
      }
    }
    // Safety: never delete a folder whose passport does not belong to this system.
    if (await exists(rec.storagePath)) {
      try {
        const m = await readManifest(rec.storagePath);
        if (m.systemId !== systemId) throw new AppError('SYSTEM_ID_CONFLICT', 'В папке находится другая система — удаление отменено.');
      } catch (e) {
        const err = toAppError(e);
        if (err.code !== 'SYSTEM_NOT_FOUND_AT_PATH') {
          this.registry.finishOperation(opId, 'failed', err.message);
          throw err;
        }
        if (opts.mode === 'everything') {
          this.registry.finishOperation(opId, 'failed', 'passport missing');
          throw new AppError('CONFIRMATION_REQUIRED', 'В папке нет паспорта системы — удаление всей папки отменено для безопасности.', { hint: 'Удалите папку вручную, если уверены, или выберите «Удалить из списка».' });
        }
      }
    }
    await this.closeRuntime(systemId);
    this.registry.addStep(opId, { name: 'Система закрыта', status: 'done' });
    let failed = false;
    const target = opts.mode === 'everything' ? rec.storagePath : systemPaths(rec.storagePath).aosDir;
    try {
      await rm(target, { recursive: true, force: true, maxRetries: 3 });
      if (await exists(target)) throw new Error('folder still exists after removal');
      this.registry.addStep(opId, { name: opts.mode === 'everything' ? 'Папка системы удалена' : 'Служебные данные (.aos) удалены', status: 'done', detail: target });
    } catch (e) {
      failed = true;
      this.registry.addStep(opId, { name: 'Удаление файлов', status: 'failed', detail: errorMessage(e) });
    }
    if (!failed) {
      this.registry.remove(systemId);
      this.registry.addStep(opId, { name: 'Регистрация удалена', status: 'done' });
      if (this.app.appSettings.get('ui.activeSystemId') === systemId) this.app.appSettings.set('ui.activeSystemId', this.firstConnectedId(systemId));
    } else {
      this.registry.update(systemId, { status: 'error', statusDetail: 'Удаление завершено не полностью. Подробности — в журнале операций.' });
    }
    const status = failed ? 'partial' : 'completed';
    this.registry.finishOperation(opId, status);
    this.app.registryAudit.record({ actor: 'user', action: 'system.delete-data', systemId, outcome: failed ? 'error' : 'ok', details: { mode: opts.mode, path: rec.storagePath } });
    this.app.events.emit('systems.changed', { reason: 'delete', systemId });
    const op = this.registry.operations(systemId, 1)[0];
    return { status, steps: op?.steps ?? [] };
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.runtimes.keys()]) await this.closeRuntime(id);
  }
}

async function countFiles(root: string): Promise<{ total: number; userFiles: number; bytes: number }> {
  let total = 0;
  let userFiles = 0;
  let bytes = 0;
  async function walk(dir: string, inAos: boolean): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, inAos || e.name === AOS_DIR);
      else if (e.isFile()) {
        total++;
        if (!inAos) userFiles++;
        try {
          bytes += (await stat(p)).size;
        } catch {
          // ignore
        }
      }
    }
  }
  await walk(root, false);
  return { total, userFiles, bytes };
}

/** Gives an attached copy a new identity: rewrites the passport and the id stored inside its database. */
async function reassignSystemId(root: string, oldSystemId: string, manifest: SystemManifest, app: AppServices): Promise<void> {
  const { openDb } = await import('../db/db.ts');
  const { db } = openDb(systemPaths(root).db, { migrations: SYSTEM_MIGRATIONS, backupDirBeforeMigrate: systemPaths(root).migrationBackups });
  try {
    db.run("INSERT INTO meta(key, value) VALUES ('system_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", manifest.systemId);
    db.run("INSERT INTO meta(key, value) VALUES ('copied_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", nowIso());
    // The primary vault source id embeds the system id; move it to the new one.
    const oldVault = db.get<{ id: string }>('SELECT id FROM sources WHERE id = ?', `src_vault_${oldSystemId.slice(4)}`);
    if (oldVault) {
      const newVaultId = `src_vault_${manifest.systemId.slice(4)}`;
      db.exec('PRAGMA foreign_keys = OFF');
      db.transaction(() => {
        for (const t of ['files', 'documents']) db.run(`UPDATE ${t} SET source_id = ? WHERE source_id = ?`, newVaultId, oldVault.id);
        db.run('UPDATE doc_versions SET source_id = ? WHERE source_id = ?', newVaultId, oldVault.id);
        db.run('UPDATE graph_nodes SET source_id = ? WHERE source_id = ?', newVaultId, oldVault.id);
        db.run('UPDATE sources SET id = ?, root_path = ? WHERE id = ?', newVaultId, root, oldVault.id);
      });
      db.exec('PRAGMA foreign_keys = ON');
    }
  } finally {
    db.close();
  }
  await writeManifest(root, manifest);
  app.logger.info('system id reassigned for copy', { systemId: manifest.systemId });
}
