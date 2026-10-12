import type { AppCore } from './app.ts';
import type { SystemRuntime } from './systems/runtime.ts';
import type { SystemStats } from './systems/manager.ts';
import { GraphService } from './graph/graph.ts';
import { Indexer } from './index/indexer.ts';
import { SourceService } from './sources/sources.ts';
import { DocumentService } from './vault/documents.ts';
import { SearchService } from './search/search.ts';
import { ChangeSetService } from './changes/change-sets.ts';
import { AgentService } from './agents/service.ts';
import { AgentRuntime } from './agents/runtime.ts';
import { PermissionGuard } from './agents/permissions.ts';
import { appAI } from './ai/app-ai.ts';
import { TaskService } from './tasks/tasks.ts';
import { WorkflowEngine } from './workflows/engine.ts';
import { registerFunctions } from './workflows/functions.ts';
import { BUILTIN_WORKFLOWS } from './workflows/builtin.ts';
import { SPEC_FUNCTIONS } from './spec/functions.ts';
import { RESEARCH_FUNCTIONS } from './research/functions.ts';

registerFunctions([...SPEC_FUNCTIONS, ...RESEARCH_FUNCTIONS]);

/** Typed accessors for the services attached to a runtime (one instance per system). */
export interface SystemServices {
  graph: GraphService;
  indexer: Indexer;
  sources: SourceService;
  docs: DocumentService;
  search: SearchService;
  changes: ChangeSetService;
  guard: PermissionGuard;
  agentRuntime: AgentRuntime;
  agents: AgentService;
  tasks: TaskService;
  workflows: WorkflowEngine;
}

export function services(rt: SystemRuntime): SystemServices {
  return rt.getOwned<SystemServices>('services');
}

export type SystemHook = (rt: SystemRuntime, s: SystemServices) => Promise<void> | void;

/**
 * Attaches domain services to every SystemRuntime when it opens. All services are constructed with the
 * runtime (its db, paths, settings), never with "the active system".
 */
export async function wireSystemServices(core: AppCore): Promise<void> {
  const extraHooks: SystemHook[] = [];
  (core.services.ext as { onSystemOpen?: SystemHook[] }).onSystemOpen = extraHooks;

  core.systems.hooks = {
    async onOpen(rt: SystemRuntime) {
      const ai = appAI(rt.app);
      const graph = new GraphService(rt.db);
      const indexer = new Indexer(rt, graph);
      const sources = rt.register('sources', new SourceService(rt, indexer, graph));
      const docs = new DocumentService(rt, indexer);
      const search = new SearchService(rt.db);
      const changes = new ChangeSetService(rt, indexer);
      const guard = new PermissionGuard(rt.db);
      const agentRuntime = new AgentRuntime(rt, ai.ai, { web: ai.web, systems: core.systems, guard });
      const agents = new AgentService(rt, ai.catalog, agentRuntime);
      const tasks = new TaskService(rt, graph);
      const workflows = rt.register('workflows', new WorkflowEngine(rt, agents, agentRuntime));
      workflows.installBuiltins(BUILTIN_WORKFLOWS);
      const s: SystemServices = { graph, indexer, sources, docs, search, changes, guard, agentRuntime, agents, tasks, workflows };
      rt.setOwned('services', s);
      for (const hook of extraHooks) await hook(rt, s);
    },
    stats(rt: SystemRuntime): SystemStats {
      const one = (sql: string) => rt.db.get<{ c: number }>(sql)?.c ?? 0;
      let indexing = false;
      try {
        indexing = services(rt).indexer.isIndexing();
      } catch {
        indexing = one("SELECT COUNT(*) AS c FROM sources WHERE status = 'indexing'") > 0;
      }
      return {
        documents: one('SELECT COUNT(*) AS c FROM documents'),
        projects: one("SELECT COUNT(*) AS c FROM sources WHERE kind = 'project'"),
        agents: one('SELECT COUNT(*) AS c FROM agents WHERE enabled = 1'),
        activeRuns:
          one("SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('pending','running','waiting_for_approval')") +
          one("SELECT COUNT(*) AS c FROM missions WHERE status IN ('analyzing','researching','planning','executing','verifying','needs_fix')"),
        indexing,
      };
    },
    activeRuns(rt: SystemRuntime): number {
      return (
        (rt.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('pending','running')")?.c ?? 0) +
        (rt.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM missions WHERE status IN ('analyzing','researching','planning','executing','verifying','needs_fix')")?.c ?? 0)
      );
    },
    async pauseRuns(rt: SystemRuntime) {
      await services(rt).workflows.pauseAll('Приостановлено: система отключается или переключается.');
    },
    async cancelRuns(rt: SystemRuntime) {
      await services(rt).workflows.cancelAll('Отменено: система отключается.');
    },
  };
}
