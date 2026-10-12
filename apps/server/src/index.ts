import { AppCore, type AppCoreOptions } from '@aos/core';
import { Router } from './http/router.ts';
import { startServer, type RunningServer } from './http/server.ts';
import { registerAppRoutes, registerSystemRoutes } from './routes/systems.ts';
import { registerDocRoutes, registerFsRoutes, registerGraphRoutes, registerSourceRoutes } from './routes/knowledge.ts';
import { registerAgentRoutes, registerAiRoutes, registerChangeRoutes, registerSecurityRoutes, registerWebRoutes } from './routes/ai.ts';
import { registerTaskRoutes, registerWorkflowRoutes } from './routes/workflows.ts';

export function createApiRouter(): Router {
  const r = new Router();
  registerAppRoutes(r);
  registerSystemRoutes(r);
  registerFsRoutes(r);
  registerSourceRoutes(r);
  registerDocRoutes(r);
  registerGraphRoutes(r);
  registerAiRoutes(r);
  registerAgentRoutes(r);
  registerChangeRoutes(r);
  registerWebRoutes(r);
  registerSecurityRoutes(r);
  registerWorkflowRoutes(r);
  registerTaskRoutes(r);
  return r;
}

export interface StartAppOptions extends AppCoreOptions {
  port?: number;
  uiDir?: string | null;
  token?: string;
  devCorsOrigin?: string;
}

export interface RunningApp {
  core: AppCore;
  http: RunningServer;
  stop(): Promise<void>;
}

/** Starts the core and the local HTTP API. Used by the CLI, the Electron shell and integration tests. */
export async function startApp(opts: StartAppOptions = {}): Promise<RunningApp> {
  const core = await AppCore.start(opts);
  let http: RunningServer;
  try {
    http = await startServer({
      core,
      router: createApiRouter(),
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      uiDir: opts.uiDir ?? null,
      ...(opts.token ? { token: opts.token } : {}),
      ...(opts.devCorsOrigin ? { devCorsOrigin: opts.devCorsOrigin } : {}),
    });
  } catch (e) {
    await core.stop();
    throw e;
  }
  return {
    core,
    http,
    async stop() {
      await http.close();
      await core.stop();
    },
  };
}

export { startServer, Router };
