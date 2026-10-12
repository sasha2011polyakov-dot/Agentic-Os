import type { Db } from '../db/db.ts';
import type { EventBus } from '../events/bus.ts';
import type { Logger } from '../log/logger.ts';
import type { RegistryAudit } from '../log/audit.ts';
import type { HttpClient } from '../net/http.ts';
import type { NetworkPolicy } from '../net/policy.ts';
import type { AppSettings } from '../settings/settings.ts';
import type { AppPaths } from './paths.ts';
import type { SecurityLog } from '../security/log.ts';

/**
 * Application-wide services shared by all systems. Nothing here holds system content: system data is
 * only reachable through a SystemRuntime bound to one system_id.
 */
export interface AppServices {
  paths: AppPaths;
  registryDb: Db;
  appSettings: AppSettings;
  events: EventBus;
  logger: Logger;
  registryAudit: RegistryAudit;
  policy: NetworkPolicy;
  http: HttpClient;
  /** Application-level security journal (extensions, keys, policies). */
  security: SecurityLog;
  /** Late-bound application services (AI Core, agent catalog, secrets) — set by the composition root. */
  ext: Record<string, unknown>;
}
