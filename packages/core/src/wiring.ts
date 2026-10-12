import type { AppCore } from './app.ts';
import type { SystemRuntime } from './systems/runtime.ts';
import type { SystemStats } from './systems/manager.ts';

/**
 * Attaches domain services to every SystemRuntime when it opens. All services are constructed with the
 * runtime (its db, paths, settings), never with "the active system".
 */
export async function wireSystemServices(core: AppCore): Promise<void> {
  core.systems.hooks = {
    async onOpen(_rt: SystemRuntime) {},
    stats(rt: SystemRuntime): SystemStats {
      const one = (sql: string) => rt.db.get<{ c: number }>(sql)?.c ?? 0;
      return {
        documents: one('SELECT COUNT(*) AS c FROM documents'),
        projects: one("SELECT COUNT(*) AS c FROM sources WHERE kind = 'project'"),
        agents: one('SELECT COUNT(*) AS c FROM agents WHERE enabled = 1'),
        activeRuns: one("SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('pending','running','waiting_for_approval')"),
        indexing: one("SELECT COUNT(*) AS c FROM sources WHERE status = 'indexing'") > 0,
      };
    },
    activeRuns(rt: SystemRuntime): number {
      return rt.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('pending','running')")?.c ?? 0;
    },
    async pauseRuns() {},
    async cancelRuns() {},
  };
}
