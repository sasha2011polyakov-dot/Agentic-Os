import type { AppServices } from '../systems/context.ts';
import type { SystemRuntime } from '../systems/runtime.ts';
import type { AiMode } from '../net/policy.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { nowIso } from '../util/time.ts';
import { BudgetGuard, RunBudget, Semaphore, type AppBudget } from './budget.ts';
import { ModelRouter, type ModelPolicy, type Route, type RouteEnvironment } from './router.ts';
import type { ProviderRegistry } from './registry.ts';
import type { SecretStore } from './secrets.ts';
import type { ChatMessage, ChatResponse, LocalModelProvider, PullProgress, TaskType } from './types.ts';
import { StructuredUnsupportedError } from './types.ts';
import { secretKindsIn } from '../security/egress.ts';

export interface CallContext {
  rt: SystemRuntime;
  purpose: string;
  agentId?: string;
  runId?: string;
  stepId?: string;
  policy: ModelPolicy;
  taskType: TaskType;
  needsStructured?: boolean;
  containsConfidential: boolean;
  budget?: RunBudget;
  signal?: AbortSignal;
}

export interface CoreChatInput {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

export interface CoreChatResult {
  response: ChatResponse;
  route: Route;
  /** false when the provider rejected native structured output and prompt mode was used instead. */
  nativeStructured: boolean;
}

/**
 * Single entry point for every model call (agents, embeddings, tests). Applies routing, network policy,
 * budgets and concurrency limits, and records usage with the originating system id.
 */
export class AICore {
  readonly router: ModelRouter;
  readonly budget: BudgetGuard;
  private readonly semaphores = new Map<string, Semaphore>();
  /** provider:model pairs that rejected native structured output — use prompt mode directly next time. */
  private readonly noStructured = new Set<string>();

  constructor(
    private readonly app: AppServices,
    readonly providers: ProviderRegistry,
    readonly secrets: SecretStore,
  ) {
    this.router = new ModelRouter(providers);
    this.budget = new BudgetGuard(app.registryDb, () => app.appSettings.get<AppBudget>('ai.budget'));
  }

  environment(rt: SystemRuntime): RouteEnvironment {
    return {
      offline: this.app.appSettings.get<boolean>('net.offline'),
      aiMode: rt.settings.get<AiMode>('ai.mode'),
      routing: rt.settings.get<RouteEnvironment['routing']>('ai.routing') ?? {},
      defaultModel: rt.settings.get<RouteEnvironment['defaultModel']>('ai.defaultModel'),
      embeddingModel: rt.settings.get<RouteEnvironment['embeddingModel']>('ai.embeddingModel'),
      cloudPolicy: rt.settings.get<RouteEnvironment['cloudPolicy']>('ai.cloudPolicy'),
    };
  }

  /** Dry-run route selection (used by "what will happen" previews before starting a workflow). */
  preview(ctx: Pick<CallContext, 'rt' | 'policy' | 'taskType' | 'containsConfidential' | 'needsStructured'>): Route {
    return this.router.select({ policy: ctx.policy, taskType: ctx.taskType, needs: { structured: !!ctx.needsStructured }, containsConfidential: ctx.containsConfidential }, this.environment(ctx.rt));
  }

  private semaphore(providerId: string): Semaphore {
    let s = this.semaphores.get(providerId);
    if (!s) {
      s = new Semaphore(() => this.app.appSettings.get<AppBudget>('ai.budget').maxConcurrentRequests ?? 2);
      this.semaphores.set(providerId, s);
    }
    return s;
  }

  private recordUsage(ctx: CallContext, route: Route, model: string, r: { inputTokens: number | null; outputTokens: number | null; latencyMs: number; cost: number | null; status: 'ok' | 'error' | 'denied'; errorCode?: string }): void {
    try {
      this.app.registryDb.run(
        `INSERT INTO ai_usage(ts, system_id, provider_id, model, locality, purpose, agent_id, run_id, step_id, input_tokens, output_tokens, latency_ms, cost_usd, status, error_code)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        nowIso(),
        ctx.rt.systemId,
        route.providerId,
        model,
        route.locality,
        ctx.purpose,
        ctx.agentId ?? null,
        ctx.runId ?? null,
        ctx.stepId ?? null,
        r.inputTokens,
        r.outputTokens,
        r.latencyMs,
        r.cost,
        r.status,
        r.errorCode ?? null,
      );
    } catch {
      // accounting must not break the call
    }
  }

  private cost(route: Route, input: number | null, output: number | null): number | null {
    if (route.locality === 'local') return 0;
    const price = this.providers.price(route.providerId, route.model);
    if (!price || price.input === null || price.output === null || input === null || output === null) return null;
    return (input * price.input + output * price.output) / 1_000_000;
  }

  async chat(ctx: CallContext, input: CoreChatInput): Promise<CoreChatResult> {
    const route = this.router.select({ policy: ctx.policy, taskType: ctx.taskType, needs: { structured: !!input.jsonSchema }, containsConfidential: ctx.containsConfidential }, this.environment(ctx.rt));
    ctx.budget?.check();
    try {
      this.budget.checkCloud(route.locality);
    } catch (e) {
      this.recordUsage(ctx, route, route.model, { inputTokens: null, outputTokens: null, latencyMs: 0, cost: null, status: 'denied', errorCode: 'BUDGET_EXCEEDED' });
      throw e;
    }
    if (route.locality === 'cloud') {
      // nothing secret-looking leaves the computer, whatever the documents contain
      const kinds = secretKindsIn([input.system ?? '', ...input.messages.map((m) => m.content)].join('\n'));
      if (kinds.length) {
        this.recordUsage(ctx, route, route.model, { inputTokens: null, outputTokens: null, latencyMs: 0, cost: null, status: 'denied', errorCode: 'SECRET_EGRESS_BLOCKED' });
        ctx.rt.security.record({ actor: ctx.agentId ? `agent:${ctx.agentId}` : ctx.purpose, action: 'secret.blocked', outcome: 'denied', taskId: ctx.runId ?? null, resources: [route.providerId], message: `Запрос к облачной модели заблокирован: в данных найдено ${kinds.join(', ')}. Данные не отправлены.` });
        throw new AppError('SECRET_EGRESS_BLOCKED', `Запрос к облачной модели не отправлен: в данных найдено ${kinds.join(', ')}.`);
      }
    }
    const provider = await this.providers.instance(route.providerId);
    const release = await this.semaphore(route.providerId).acquire(ctx.signal);
    const key = `${route.providerId}:${route.model}`;
    const started = Date.now();
    let nativeStructured = !!input.jsonSchema && !this.noStructured.has(key);
    try {
      const call = (structured: boolean) =>
        provider.chat({
          model: route.model,
          messages: input.messages,
          purpose: ctx.purpose,
          systemId: ctx.rt.systemId,
          ...(input.system ? { system: input.system } : {}),
          ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
          ...(input.maxOutputTokens !== undefined ? { maxOutputTokens: input.maxOutputTokens } : {}),
          ...(structured && input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      let response: ChatResponse;
      try {
        response = await call(nativeStructured);
      } catch (e) {
        if (e instanceof StructuredUnsupportedError) {
          this.noStructured.add(key);
          nativeStructured = false;
          response = await call(false);
        } else throw e;
      }
      const cost = this.cost(route, response.usage.inputTokens, response.usage.outputTokens);
      this.recordUsage(ctx, route, route.model, { inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, latencyMs: response.latencyMs, cost, status: 'ok' });
      ctx.budget?.add({ inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, costUsd: cost, cloud: route.locality === 'cloud' });
      return { response, route, nativeStructured };
    } catch (e) {
      const err = toAppError(e);
      this.recordUsage(ctx, route, route.model, { inputTokens: null, outputTokens: null, latencyMs: Date.now() - started, cost: null, status: 'error', errorCode: err.code });
      ctx.rt.log.warn('model call failed', { provider: route.providerId, model: route.model, code: err.code, purpose: ctx.purpose });
      throw err;
    } finally {
      release();
    }
  }

  async embed(ctx: Omit<CallContext, 'taskType'>, inputs: string[]): Promise<{ vectors: number[][]; route: Route }> {
    const route = this.router.select({ policy: ctx.policy, taskType: 'embedding', needs: { embeddings: true }, containsConfidential: ctx.containsConfidential }, this.environment(ctx.rt));
    this.budget.checkCloud(route.locality);
    const provider = await this.providers.instance(route.providerId);
    if (!provider.embed) throw new AppError('MODEL_UNAVAILABLE', 'Провайдер не поддерживает эмбеддинги.');
    const release = await this.semaphore(route.providerId).acquire(ctx.signal);
    const started = Date.now();
    try {
      const res = await provider.embed({ model: route.model, input: inputs, systemId: ctx.rt.systemId, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      this.recordUsage({ ...ctx, taskType: 'embedding' }, route, route.model, { inputTokens: res.usage.inputTokens, outputTokens: 0, latencyMs: Date.now() - started, cost: this.cost(route, res.usage.inputTokens, 0), status: 'ok' });
      return { vectors: res.vectors, route };
    } catch (e) {
      const err = toAppError(e);
      this.recordUsage({ ...ctx, taskType: 'embedding' }, route, route.model, { inputTokens: null, outputTokens: null, latencyMs: Date.now() - started, cost: null, status: 'error', errorCode: err.code });
      throw err;
    } finally {
      release();
    }
  }

  /** Model download through a local engine. Offline mode forbids it: the engine itself would go to the internet. */
  async pull(providerId: string, model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    if (this.app.appSettings.get<boolean>('net.offline')) throw new AppError('OFFLINE_MODE', 'Загрузка моделей недоступна в офлайн-режиме.');
    const p = (await this.providers.instance(providerId)) as LocalModelProvider;
    if (!p.pullModel) throw new AppError('VALIDATION_FAILED', 'Этот провайдер не умеет загружать модели. Загрузите модель в самом приложении (например, в LM Studio).');
    await p.pullModel(model, onProgress, signal);
    await this.providers.models(providerId, { refresh: true });
  }

  async deleteModel(providerId: string, model: string): Promise<void> {
    const p = (await this.providers.instance(providerId)) as LocalModelProvider;
    if (!p.deleteModel) throw new AppError('VALIDATION_FAILED', 'Этот провайдер не поддерживает удаление моделей из приложения.');
    await p.deleteModel(model);
    await this.providers.models(providerId, { refresh: true });
  }
}
