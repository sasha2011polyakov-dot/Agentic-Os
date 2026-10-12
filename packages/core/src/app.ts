import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, type Db } from './db/db.ts';
import { REGISTRY_MIGRATIONS } from './db/registry-migrations.ts';
import { EventBus } from './events/bus.ts';
import { Logger, type LogLevel } from './log/logger.ts';
import { RegistryAudit } from './log/audit.ts';
import { HttpClient } from './net/http.ts';
import { NetworkPolicy, type AiMode, type NetworkState } from './net/policy.ts';
import { AppSettings } from './settings/settings.ts';
import type { AppServices } from './systems/context.ts';
import { SystemManager } from './systems/manager.ts';
import { appPaths, resolveDataDir } from './systems/paths.ts';
import { wireSystemServices } from './wiring.ts';
import { createAppAI } from './ai/app-ai.ts';

export interface AppCoreOptions {
  dataDir?: string;
  logLevel?: LogLevel;
  echoLogs?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Adapters provided by the desktop shell (secret storage, etc.). */
  adapters?: Record<string, unknown>;
}

export const APP_VERSION = '0.1.0';

/**
 * Composition root. Owns application-wide services and the SystemManager. System content is only reached
 * through SystemManager.runtime(systemId).
 */
export class AppCore {
  readonly services: AppServices;
  readonly systems: SystemManager;
  readonly registryDb: Db;
  private stopped = false;

  private constructor(services: AppServices, systems: SystemManager) {
    this.services = services;
    this.systems = systems;
    this.registryDb = services.registryDb;
  }

  static async start(opts: AppCoreOptions = {}): Promise<AppCore> {
    const env = opts.env ?? process.env;
    const paths = appPaths(opts.dataDir ?? resolveDataDir(env));
    mkdirSync(paths.dataDir, { recursive: true });
    const { db: registryDb } = openDb(paths.registryDb, {
      migrations: REGISTRY_MIGRATIONS,
      backupDirBeforeMigrate: join(paths.backupsDir, '_registry'),
    });
    const appSettings = new AppSettings(registryDb);
    const level = opts.logLevel ?? appSettings.get<LogLevel>('log.level');
    const logger = new Logger(paths.logFile, level, 10 * 1024 * 1024, opts.echoLogs ?? false);
    const events = new EventBus();
    const registryAudit = new RegistryAudit(registryDb);

    // The policy needs the SystemManager for per-system AI mode overrides; it is late-bound below.
    let manager: SystemManager | null = null;
    const getState = (systemId?: string): NetworkState => {
      const offline = appSettings.get<boolean>('net.offline');
      let aiMode = appSettings.get<AiMode>('ai.mode');
      if (systemId && manager?.isOpen(systemId)) {
        const rt = manager.openRuntimes().find((r) => r.systemId === systemId);
        if (rt) aiMode = rt.settings.get<AiMode>('ai.mode');
      }
      return { offline, aiMode };
    };
    const policy = new NetworkPolicy(getState, (r) => {
      if (!r.allowed) logger.warn('egress denied', { ...r });
      else logger.debug('egress', { ...r });
    });
    const http = new HttpClient(policy);
    mkdirSync(paths.tmpDir, { recursive: true });

    const services: AppServices = { paths, registryDb, appSettings, events, logger, registryAudit, policy, http, ext: { env, adapters: opts.adapters ?? {} } };
    services.ext.ai = await createAppAI(services, env, opts.adapters ?? {});
    manager = new SystemManager(services);
    const core = new AppCore(services, manager);
    await wireSystemServices(core);
    await manager.startup();
    logger.info('app started', { dataDir: paths.dataDir, version: APP_VERSION, systems: manager.registry.list().length });
    return core;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const ext = this.services.ext as { onStop?: (() => Promise<void>)[] };
    for (const fn of ext.onStop ?? []) {
      try {
        await fn();
      } catch {
        // continue shutting down
      }
    }
    await this.systems.shutdown();
    this.registryDb.close();
    this.services.logger.info('app stopped');
  }
}
