import { AppError } from '../util/errors.ts';
import type { AiMode } from '../net/policy.ts';
import type { ProviderRegistry } from './registry.ts';
import type { Locality, TaskType } from './types.ts';

/** Model selection policy of an agent — lives in its configuration, never in its instructions. */
export interface ModelPolicy {
  /** 'inherit' uses the system's AI mode. */
  mode?: 'inherit' | AiMode;
  providerId?: string | null;
  model?: string | null;
  allowFallback?: boolean;
  /** Even in hybrid mode, cloud is used only when this is true for the agent (or allowed by cloud policy). */
  allowCloud?: boolean;
}

export interface RouteRequest {
  policy: ModelPolicy;
  taskType: TaskType;
  needs: { structured?: boolean; minContext?: number; embeddings?: boolean };
  containsConfidential: boolean;
}

export interface RouteEnvironment {
  offline: boolean;
  aiMode: AiMode;
  routing: Partial<Record<TaskType, { providerId: string; model: string }>>;
  defaultModel: { providerId: string; model: string } | null;
  embeddingModel: { providerId: string; model: string } | null;
  cloudPolicy: { allowedTaskTypes: string[]; escalateToCloudOnFailure: boolean };
}

export interface Route {
  providerId: string;
  model: string;
  locality: Locality;
  reason: string;
}

/**
 * Chooses provider+model for one call. Order of rules (docs/architecture/ai-and-web-research.md §1.3):
 * offline → local only; mode local → local only (no automatic cloud fallback); confidential context → local only;
 * explicit agent policy; hybrid: cloud only for allowed task types; task routing; system default; first local model.
 */
export class ModelRouter {
  constructor(private readonly registry: ProviderRegistry) {}

  select(req: RouteRequest, env: RouteEnvironment): Route {
    const mode: AiMode = req.policy.mode && req.policy.mode !== 'inherit' ? req.policy.mode : env.aiMode;
    const reasons: string[] = [];
    const cloudAllowed = (taskType: TaskType): { ok: boolean; why: string } => {
      if (env.offline) return { ok: false, why: 'offline mode' };
      if (req.containsConfidential) return { ok: false, why: 'the context contains a confidential source' };
      if (mode === 'local') return { ok: false, why: '"Local AI" mode' };
      if (mode === 'cloud') return { ok: true, why: '"Cloud" mode' };
      // hybrid
      if (req.policy.allowCloud) return { ok: true, why: 'the agent policy allows the cloud' };
      if (env.cloudPolicy.allowedTaskTypes.includes(taskType)) return { ok: true, why: `the hybrid policy allows the cloud for "${taskType}"` };
      return { ok: false, why: 'the hybrid policy does not allow the cloud for this task type' };
    };
    const usable = (providerId: string): { ok: boolean; locality: Locality; why?: string } => {
      let cfg;
      try {
        cfg = this.registry.config(providerId);
      } catch {
        return { ok: false, locality: 'local', why: 'the provider was deleted' };
      }
      if (!cfg.enabled) return { ok: false, locality: cfg.locality, why: `the provider "${cfg.name}" is disabled` };
      if (cfg.locality === 'cloud') {
        const c = cloudAllowed(req.taskType);
        if (!c.ok) return { ok: false, locality: 'cloud', why: c.why };
      }
      return { ok: true, locality: cfg.locality };
    };

    const tryCandidate = (providerId: string, model: string, label: string): Route | null => {
      const u = usable(providerId);
      if (!u.ok) {
        reasons.push(`${label}: ${u.why}`);
        return null;
      }
      return { providerId, model, locality: u.locality, reason: `${label}` };
    };

    if (req.policy.providerId && req.policy.model) {
      const r = tryCandidate(req.policy.providerId, req.policy.model, 'the model from the agent settings');
      if (r) return r;
      if (!req.policy.allowFallback) {
        const cfgLocality = (() => {
          try {
            return this.registry.config(req.policy.providerId!).locality;
          } catch {
            return 'local';
          }
        })();
        if (cfgLocality === 'cloud' && (env.offline || mode === 'local' || req.containsConfidential)) {
          throw new AppError(req.containsConfidential ? 'POLICY_CONFIDENTIAL_SOURCE' : env.offline ? 'OFFLINE_MODE' : 'NETWORK_POLICY_DENIED', undefined, { details: { reasons } });
        }
        throw new AppError('MODEL_UNAVAILABLE', `The agent model is unavailable: ${reasons.join('; ')}.`, { details: { reasons } });
      }
    }
    if (req.needs.embeddings) {
      if (env.embeddingModel) {
        const r = tryCandidate(env.embeddingModel.providerId, env.embeddingModel.model, 'the embedding model from the settings');
        if (r) return r;
      }
    }
    const routed = env.routing[req.taskType];
    if (routed) {
      const r = tryCandidate(routed.providerId, routed.model, `routing for "${req.taskType}"`);
      if (r) return r;
    }
    if (env.defaultModel && !req.needs.embeddings) {
      const r = tryCandidate(env.defaultModel.providerId, env.defaultModel.model, 'the default model');
      if (r) return r;
    }
    // Last resort: first suitable cached model of an enabled LOCAL provider.
    for (const cfg of this.registry.configs()) {
      if (!cfg.enabled || cfg.locality !== 'local') continue;
      const m = this.registry.firstCachedModel(cfg.id, req.needs.embeddings ? 'embeddings' : 'chat');
      if (m) return { providerId: cfg.id, model: m.id, locality: 'local', reason: `the first available local model (${cfg.name})` };
    }
    if (reasons.some((r) => r.includes('offline'))) throw new AppError('OFFLINE_MODE', undefined, { details: { reasons } });
    throw new AppError('NO_MODEL_CONFIGURED', reasons.length ? `No model is available: ${reasons.join('; ')}.` : undefined, { details: { reasons } });
  }
}
