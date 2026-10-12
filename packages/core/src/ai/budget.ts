import type { Db } from '../db/db.ts';
import { AppError } from '../util/errors.ts';
import type { Locality } from './types.ts';

export interface RunLimits {
  maxModelCalls: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
}

export interface RunTotals {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  costUnknownCalls: number;
}

/** Mutable per-run budget shared by every agent step of one workflow run. */
export class RunBudget {
  readonly totals: RunTotals;

  constructor(
    readonly limits: RunLimits,
    totals?: Partial<RunTotals>,
    private readonly onChange?: (t: RunTotals) => void,
  ) {
    this.totals = { modelCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, costUnknownCalls: 0, ...totals };
  }

  check(): void {
    const t = this.totals;
    const l = this.limits;
    if (l.maxModelCalls !== null && t.modelCalls >= l.maxModelCalls) throw new AppError('BUDGET_EXCEEDED', `Достигнут лимит вызовов модели для запуска (${l.maxModelCalls}).`);
    if (l.maxTokens !== null && t.inputTokens + t.outputTokens >= l.maxTokens) throw new AppError('BUDGET_EXCEEDED', `Достигнут лимит токенов для запуска (${l.maxTokens}).`);
    if (l.maxCostUsd !== null && t.costUsd >= l.maxCostUsd) throw new AppError('BUDGET_EXCEEDED', `Достигнут лимит стоимости запуска ($${l.maxCostUsd}).`);
  }

  add(usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null; cloud: boolean }): void {
    this.totals.modelCalls++;
    this.totals.inputTokens += usage.inputTokens ?? 0;
    this.totals.outputTokens += usage.outputTokens ?? 0;
    if (usage.costUsd !== null) this.totals.costUsd += usage.costUsd;
    else if (usage.cloud) this.totals.costUnknownCalls++;
    this.onChange?.(this.totals);
  }
}

export interface AppBudget {
  monthlyCostUsd: number | null;
  maxCloudRequestsPerDay: number | null;
  maxConcurrentRequests: number;
}

/** Application-wide limits for cloud usage, computed from ai_usage (all systems). */
export class BudgetGuard {
  constructor(
    private readonly db: Db,
    private readonly getBudget: () => AppBudget,
  ) {}

  checkCloud(locality: Locality): void {
    if (locality !== 'cloud') return;
    const b = this.getBudget();
    if (b.maxCloudRequestsPerDay !== null) {
      const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      const n = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM ai_usage WHERE locality = 'cloud' AND ts >= ? AND status <> 'denied'", since)!.c;
      if (n >= b.maxCloudRequestsPerDay) throw new AppError('BUDGET_EXCEEDED', `Достигнут дневной лимит облачных запросов (${b.maxCloudRequestsPerDay}).`);
    }
    if (b.monthlyCostUsd !== null) {
      const monthStart = new Date();
      monthStart.setUTCDate(1);
      monthStart.setUTCHours(0, 0, 0, 0);
      const spent = this.db.get<{ s: number | null }>("SELECT SUM(cost_usd) AS s FROM ai_usage WHERE locality = 'cloud' AND ts >= ?", monthStart.toISOString())!.s ?? 0;
      if (spent >= b.monthlyCostUsd) throw new AppError('BUDGET_EXCEEDED', `Достигнут месячный лимит расходов ($${b.monthlyCostUsd}).`);
    }
  }

  summary(opts: { since?: string; systemId?: string } = {}): { byProvider: { providerId: string; model: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number | null; errors: number }[]; byAgent: { agentId: string | null; calls: number; tokens: number; costUsd: number | null }[]; total: { calls: number; costUsd: number | null; costUnknown: number } } {
    const since = opts.since ?? new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const where = opts.systemId ? 'ts >= ? AND system_id = ?' : 'ts >= ?';
    const params = opts.systemId ? [since, opts.systemId] : [since];
    const byProvider = this.db.all<{ provider_id: string; model: string; calls: number; it: number; ot: number; cost: number | null; errors: number }>(
      `SELECT provider_id, model, COUNT(*) AS calls, SUM(COALESCE(input_tokens,0)) AS it, SUM(COALESCE(output_tokens,0)) AS ot, SUM(cost_usd) AS cost, SUM(status = 'error') AS errors FROM ai_usage WHERE ${where} GROUP BY provider_id, model ORDER BY calls DESC`,
      ...params,
    );
    const byAgent = this.db.all<{ agent_id: string | null; calls: number; tokens: number; cost: number | null }>(
      `SELECT agent_id, COUNT(*) AS calls, SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0)) AS tokens, SUM(cost_usd) AS cost FROM ai_usage WHERE ${where} GROUP BY agent_id ORDER BY calls DESC`,
      ...params,
    );
    const total = this.db.get<{ calls: number; cost: number | null; unknown: number }>(
      `SELECT COUNT(*) AS calls, SUM(cost_usd) AS cost, SUM(locality = 'cloud' AND cost_usd IS NULL) AS unknown FROM ai_usage WHERE ${where}`,
      ...params,
    )!;
    return {
      byProvider: byProvider.map((r) => ({ providerId: r.provider_id, model: r.model, calls: r.calls, inputTokens: r.it, outputTokens: r.ot, costUsd: r.cost, errors: r.errors })),
      byAgent: byAgent.map((r) => ({ agentId: r.agent_id, calls: r.calls, tokens: r.tokens, costUsd: r.cost })),
      total: { calls: total.calls, costUsd: total.cost, costUnknown: total.unknown ?? 0 },
    };
  }
}

/** Simple async semaphore limiting parallel requests per provider. */
export class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly max: () => number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < Math.max(1, this.max())) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.queue.indexOf(resolve);
        if (i !== -1) this.queue.splice(i, 1);
        reject(new AppError('CANCELLED'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queue.push(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      });
    });
    this.active++;
    return () => this.release();
  }
  private release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}
