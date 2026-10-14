import type { AppServices } from '../systems/context.ts';
import { AppError } from '../util/errors.ts';
import { AgentCatalog } from '../agents/catalog.ts';
import { WebResearch } from '../research/web.ts';
import { AICore } from './core.ts';
import { ProviderRegistry } from './registry.ts';
import { SecretStore, type SafeStorageAdapter } from './secrets.ts';

/** Application-level AI services shared by all systems (providers and keys are app settings, usage is per system). */
export interface AppAI {
  secrets: SecretStore;
  providers: ProviderRegistry;
  ai: AICore;
  catalog: AgentCatalog;
  web: WebResearch;
  /** True only when AOS_ENABLE_TEST_PROVIDER=1 (automated tests): the deterministic test provider is available. */
  testEnabled: boolean;
}

export async function createAppAI(app: AppServices, env: NodeJS.ProcessEnv, adapters: Record<string, unknown>): Promise<AppAI> {
  const secrets = new SecretStore(env, app.paths.dataDir, adapters.safeStorage as SafeStorageAdapter | undefined);
  const testEnabled = env.AOS_ENABLE_TEST_PROVIDER === '1';
  const providers = new ProviderRegistry(app.registryDb, app.http, secrets, testEnabled);
  providers.ensureDefaults();
  if (testEnabled) await providers.models('test', { refresh: true });
  const ai = new AICore(app, providers, secrets);
  const catalog = new AgentCatalog(app.registryDb, app.paths.sharedAgentsDir);
  await catalog.load();
  const web = new WebResearch(app, secrets);
  return { secrets, providers, ai, catalog, web, testEnabled };
}

export function appAI(app: AppServices): AppAI {
  const v = app.ext.ai as AppAI | undefined;
  if (!v) throw new AppError('INTERNAL', 'The application AI services are not initialized.');
  return v;
}
