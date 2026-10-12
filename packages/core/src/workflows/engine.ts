import type { SystemRuntime, RuntimeService } from '../systems/runtime.ts';
import type { AgentService } from '../agents/service.ts';
import type { AgentRuntime, ContextBlock } from '../agents/runtime.ts';
import type { PermissionId, RunScope } from '../agents/permissions.ts';
import { TOOL_PERMISSIONS } from '../agents/package.ts';
import { appAI } from '../ai/app-ai.ts';
import { RunBudget, type RunTotals } from '../ai/budget.ts';
import { validator, formatErrors } from '../agents/schema.ts';
import { AppError, ERROR_CATALOG, toAppError, type AppErrorJson, type ErrorCode } from '../util/errors.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { abortableSleep } from '../net/http.ts';
import { assertDefinition, checkDefinition, DEFAULT_LIMITS, topoOrder, type ApprovalNode, type DefinitionCheck, type LoopNode, type WorkflowDefinition, type WorkflowLimits, type WorkflowNode } from './definition.ts';
import { evaluate, resolveMapping } from './expr.ts';
import { workflowFunction, workflowFunctions, type FunctionContext } from './functions.ts';

export type RunStatus = 'pending' | 'running' | 'paused' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'skipped';

export interface ApprovalDecision {
  decision: 'approve' | 'reject' | 'revise';
  comment?: string;
  answers?: { question: string; answer: string }[];
  choices?: { id: string; value: string }[];
}

export interface StartOptions {
  title?: string;
  scope: RunScope;
  limits?: Partial<WorkflowLimits>;
  actor?: string;
}

interface RunRow {
  id: string;
  workflow_id: string;
  workflow_version: number;
  definition: string;
  status: RunStatus;
  title: string;
  input: string;
  scope: string;
  limits: string;
  totals: string;
  error: string | null;
  status_reason: string | null;
  result: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface StepRow {
  id: string;
  run_id: string;
  node_id: string;
  iteration: number;
  status: StepStatus;
  agent_id: string | null;
  agent_version: string | null;
  model_config: string | null;
  input: string | null;
  output: string | null;
  error: string | null;
  attempts: number;
  transition_reason: string | null;
  approval: string | null;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

export interface StepView {
  id: string;
  nodeId: string;
  title: string;
  type: WorkflowNode['type'];
  iteration: number;
  status: StepStatus;
  agentId: string | null;
  agentVersion: string | null;
  route: unknown;
  attempts: number;
  reason: string | null;
  error: AppErrorJson | null;
  input: unknown;
  output: unknown;
  approval: unknown;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface RunView {
  id: string;
  workflowId: string;
  workflowVersion: number;
  workflowName: string;
  title: string;
  status: RunStatus;
  statusReason: string | null;
  input: unknown;
  scope: RunScope & { containsConfidential?: boolean };
  limits: WorkflowLimits;
  totals: Partial<RunTotals>;
  error: AppErrorJson | null;
  result: unknown;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  steps: StepView[];
  pendingApprovals: StepView[];
  nodes: { id: string; type: string; title: string; dependsOn: string[]; body?: string[]; agent?: string; position?: { x: number; y: number } }[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  description: string;
  version: number;
  builtin: boolean;
  category: string;
  nodes: number;
  agents: string[];
  updatedAt: string;
  lastRun: { id: string; status: RunStatus; createdAt: string } | null;
}

export interface PreflightReport {
  ok: boolean;
  workflowId: string;
  check: DefinitionCheck;
  agents: { nodeId: string; agentId: string; title: string; installed: boolean; enabled: boolean; missingGrants: PermissionId[]; route: { providerId: string; model: string; locality: string; reason: string } | null; routeError: AppErrorJson | null }[];
  approvals: number;
  estimate: { modelCallsMin: number; modelCallsMax: number; maxIterations: number };
  limits: WorkflowLimits;
  problems: string[];
  warnings: string[];
}

interface ActiveRun {
  controller: AbortController;
  abortReason: 'cancel' | 'stop' | 'fail' | null;
  running: Map<string, Promise<void>>;
  scheduling: boolean;
  again: boolean;
  budget: RunBudget;
}

const TERMINAL: StepStatus[] = ['completed', 'failed', 'cancelled', 'skipped'];
const OK_DONE: StepStatus[] = ['completed', 'skipped'];
/** Errors the user can fix (model, keys, agents, budget, network mode): the run pauses instead of failing. */
const USER_FIXABLE: ErrorCode[] = ['NO_MODEL_CONFIGURED', 'MODEL_UNAVAILABLE', 'PROVIDER_UNREACHABLE', 'PROVIDER_AUTH_FAILED', 'PROVIDER_RATE_LIMITED', 'AGENT_NOT_ENABLED', 'BUDGET_EXCEEDED', 'OFFLINE_MODE', 'NETWORK_POLICY_DENIED', 'POLICY_CONFIDENTIAL_SOURCE', 'SECRET_STORE_UNAVAILABLE'];
const RETRYABLE: ErrorCode[] = ['PROVIDER_ERROR', 'PROVIDER_UNREACHABLE', 'PROVIDER_RATE_LIMITED', 'TIMEOUT', 'STRUCTURED_OUTPUT_FAILED', 'MODEL_UNAVAILABLE'];

/**
 * Durable workflow engine of ONE system. Every state change is written to system.db before it is acted upon,
 * so a run survives restarts: interrupted steps return to "pending" and the run is paused until the user
 * continues it (nothing with side effects is silently repeated). Agents act only through AgentRuntime.
 */
export class WorkflowEngine implements RuntimeService {
  private readonly active = new Map<string, ActiveRun>();
  private stopped = false;
  /** Test hook: delay between retries. */
  retryDelayMs = 400;

  constructor(
    private readonly rt: SystemRuntime,
    private readonly agents: AgentService,
    private readonly agentRuntime: AgentRuntime,
  ) {}

  // ---------------------------------------------------------------- definitions

  private known(): { agents: Set<string>; functions: Set<string> } {
    const agents = new Set<string>(appAI(this.rt.app).catalog.builtinEntries().map((e) => e.id));
    for (const r of this.rt.db.all<{ id: string }>('SELECT id FROM agents UNION SELECT id FROM system_agent_packages')) agents.add(r.id);
    return { agents, functions: new Set(workflowFunctions().map((f) => f.name)) };
  }

  check(def: unknown): DefinitionCheck {
    return checkDefinition(def, this.known());
  }

  /** Built-in workflows are (re)installed on system open; a newer built-in version replaces the stored one. */
  installBuiltins(defs: WorkflowDefinition[]): void {
    const now = nowIso();
    for (const d of defs) {
      const cur = this.rt.db.get<{ version: number; builtin: number }>('SELECT version, builtin FROM workflows WHERE id = ?', d.id);
      if (cur && !cur.builtin) continue; // never overwrite a user workflow with the same id
      if (cur && cur.version >= d.version) continue;
      this.rt.db.run(
        `INSERT INTO workflows(id, name, description, version, definition, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, version = excluded.version, definition = excluded.definition, updated_at = excluded.updated_at`,
        d.id,
        d.name,
        d.description,
        d.version,
        JSON.stringify(d),
        now,
        now,
      );
    }
  }

  list(): WorkflowSummary[] {
    return this.rt.db.all<{ id: string; name: string; description: string; version: number; definition: string; builtin: number; updated_at: string }>('SELECT * FROM workflows ORDER BY builtin DESC, name').map((r) => {
      const def = parseJson<WorkflowDefinition>(r.definition, { nodes: [] } as unknown as WorkflowDefinition);
      const last = this.rt.db.get<{ id: string; status: RunStatus; created_at: string }>('SELECT id, status, created_at FROM workflow_runs WHERE workflow_id = ? ORDER BY created_at DESC LIMIT 1', r.id);
      return {
        id: r.id,
        name: r.name,
        description: r.description,
        version: r.version,
        builtin: !!r.builtin,
        category: def.category ?? 'custom',
        nodes: def.nodes.length,
        agents: [...new Set(def.nodes.filter((n) => n.type === 'agent').map((n) => (n as { agent: string }).agent))],
        updatedAt: r.updated_at,
        lastRun: last ? { id: last.id, status: last.status, createdAt: last.created_at } : null,
      };
    });
  }

  definition(id: string): { definition: WorkflowDefinition; builtin: boolean } {
    const r = this.rt.db.get<{ definition: string; builtin: number }>('SELECT definition, builtin FROM workflows WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Процесс не найден.');
    return { definition: JSON.parse(r.definition) as WorkflowDefinition, builtin: !!r.builtin };
  }

  /** Saves a user workflow (new version on every save; runs keep the snapshot they started with). */
  save(def: unknown, actor = 'user'): { definition: WorkflowDefinition; check: DefinitionCheck } {
    const d = assertDefinition(def, this.known());
    const cur = this.rt.db.get<{ version: number; builtin: number }>('SELECT version, builtin FROM workflows WHERE id = ?', d.id);
    if (cur?.builtin) throw new AppError('VALIDATION_FAILED', 'Встроенный процесс нельзя изменить — создайте копию.');
    const version = (cur?.version ?? 0) + 1;
    const stored = { ...d, version };
    const now = nowIso();
    this.rt.db.run(
      `INSERT INTO workflows(id, name, description, version, definition, builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, version = excluded.version, definition = excluded.definition, updated_at = excluded.updated_at`,
      d.id,
      d.name,
      d.description ?? '',
      version,
      JSON.stringify(stored),
      now,
      now,
    );
    this.rt.audit.record({ actor, action: 'workflow.save', target: d.id, details: { version } });
    return { definition: stored, check: this.check(stored) };
  }

  duplicate(id: string, newIdValue: string, name: string): WorkflowDefinition {
    const { definition } = this.definition(id);
    if (this.rt.db.get('SELECT id FROM workflows WHERE id = ?', newIdValue)) throw new AppError('VALIDATION_FAILED', `Процесс с идентификатором «${newIdValue}» уже есть.`);
    return this.save({ ...definition, id: newIdValue, name, version: 1 }).definition;
  }

  remove(id: string): void {
    const { builtin } = this.definition(id);
    if (builtin) throw new AppError('VALIDATION_FAILED', 'Встроенный процесс нельзя удалить.');
    const active = this.rt.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM workflow_runs WHERE workflow_id = ? AND status IN ('pending','running','waiting_for_approval','paused')", id)!.c;
    if (active) throw new AppError('SYSTEM_HAS_ACTIVE_RUNS', 'У процесса есть незавершённые запуски.');
    this.rt.db.run('DELETE FROM workflows WHERE id = ?', id);
    this.rt.audit.record({ actor: 'user', action: 'workflow.delete', target: id });
  }

  // ---------------------------------------------------------------- preflight (dry run)

  limitsFor(def: WorkflowDefinition, override?: Partial<WorkflowLimits>): WorkflowLimits {
    const base = { ...DEFAULT_LIMITS, ...(this.rt.settings.get<Partial<WorkflowLimits>>('workflow.defaultLimits') ?? {}), ...(def.limits ?? {}), ...(override ?? {}) };
    return {
      maxModelCalls: base.maxModelCalls ?? null,
      maxTokens: base.maxTokens ?? null,
      maxCostUsd: base.maxCostUsd ?? null,
      maxReviewIterations: Math.max(1, Math.min(base.maxReviewIterations ?? 2, 10)),
      stepTimeoutMs: Math.max(5_000, Math.min(base.stepTimeoutMs ?? 300_000, 3_600_000)),
      maxParallel: Math.max(1, Math.min(base.maxParallel ?? 2, 8)),
    };
  }

  private scopeConfidential(scope: RunScope): boolean {
    const ids = scope.sourceIds.length ? scope.sourceIds : this.rt.db.all<{ id: string }>('SELECT id FROM sources').map((r) => r.id);
    const docSources = scope.docIds.map((d) => this.rt.db.get<{ source_id: string }>('SELECT source_id FROM documents WHERE id = ?', d)?.source_id).filter((x): x is string => !!x);
    return [...ids, ...docSources].some((id) => !!this.rt.db.get<{ confidential: number }>('SELECT confidential FROM sources WHERE id = ?', id)?.confidential);
  }

  async preflight(workflowId: string, scope: RunScope, limitsOverride?: Partial<WorkflowLimits>): Promise<PreflightReport> {
    const { definition: def } = this.definition(workflowId);
    const check = this.check(def);
    const limits = this.limitsFor(def, limitsOverride);
    const confidential = this.scopeConfidential(scope);
    const problems: string[] = check.errors.map((e) => e.message);
    const warnings: string[] = check.warnings.map((e) => e.message);
    const loopOf = new Map<string, LoopNode>();
    for (const n of def.nodes) if (n.type === 'loop') for (const b of n.body) loopOf.set(b, n);
    const ctxForLimits = { limits, input: {} };
    const agents: PreflightReport['agents'] = [];
    let min = 0;
    let max = 0;
    let maxIterations = 1;
    for (const n of def.nodes) {
      if (n.type !== 'agent') continue;
      const loop = loopOf.get(n.id);
      const iters = loop ? Math.max(1, Number(resolveMapping(loop.maxIterations, ctxForLimits)) || 1) : 1;
      maxIterations = Math.max(maxIterations, iters);
      const row = this.rt.db.get<{ enabled: number }>('SELECT enabled FROM agents WHERE id = ?', n.agent);
      let missing: PermissionId[] = [];
      let route: PreflightReport['agents'][number]['route'] = null;
      let routeError: AppErrorJson | null = null;
      let rounds = 4;
      let repairs = 2;
      try {
        const info = await this.agents.get(n.agent);
        const granted = new Set(info.grants.map((g) => g.permission));
        const needed = new Set<PermissionId>();
        for (const t of info.tools) for (const p of TOOL_PERMISSIONS[t] ?? []) needed.add(p);
        missing = [...needed].filter((p) => !granted.has(p));
        const cfg = this.agents.config(n.agent);
        rounds = cfg.generation.maxToolRounds ?? 4;
        repairs = cfg.generation.repairAttempts ?? 2;
        const r = appAI(this.rt.app).ai.preview({ rt: this.rt, policy: cfg.modelPolicy, taskType: info.taskType as never, containsConfidential: confidential, needsStructured: true });
        route = { providerId: r.providerId, model: r.model, locality: r.locality, reason: r.reason };
        if (info.tools.some((t) => ['web_search', 'open_url', 'fetch_documentation', 'search_github', 'inspect_repository'].includes(t)) && !scope.allowWeb) {
          warnings.push(`«${n.title}»: веб-доступ не разрешён для запуска — веб-инструменты будут отклонены.`);
        }
      } catch (e) {
        const err = toAppError(e);
        if (err.code !== 'NOT_FOUND') routeError = err.toJSON();
      }
      if (!row) problems.push(`Агент «${n.agent}» (шаг «${n.title}») не установлен в системе.`);
      else if (!row.enabled) problems.push(`Агент «${n.agent}» (шаг «${n.title}») выключен.`);
      if (row && routeError) problems.push(`Шаг «${n.title}»: ${routeError.message}`);
      if (missing.length) warnings.push(`«${n.title}»: агенту не выданы разрешения ${missing.join(', ')} — соответствующие инструменты будут отклонены.`);
      const retries = (n.retries ?? 1) + 1;
      min += iters;
      max += iters * (1 + rounds + repairs) * retries;
      agents.push({ nodeId: n.id, agentId: n.agent, title: n.title, installed: !!row, enabled: !!row?.enabled, missingGrants: missing, route, routeError });
    }
    if (limits.maxModelCalls !== null && min > limits.maxModelCalls) problems.push(`Лимит вызовов модели (${limits.maxModelCalls}) меньше минимально необходимого (${min}).`);
    else if (limits.maxModelCalls !== null && max > limits.maxModelCalls) warnings.push(`В худшем случае потребуется до ${max} вызовов модели — больше лимита ${limits.maxModelCalls}; запуск приостановится при его достижении.`);
    if (confidential) warnings.push('В области запуска есть конфиденциальные источники: будут использоваться только локальные модели.');
    if (agents.some((a) => a.route?.locality === 'cloud')) warnings.push('Часть шагов будет выполнена облачной моделью: содержимое выбранных документов будет отправлено провайдеру.');
    return { ok: problems.length === 0, workflowId, check, agents, approvals: def.nodes.filter((n) => n.type === 'approval').length, estimate: { modelCallsMin: min, modelCallsMax: max, maxIterations }, limits, problems, warnings };
  }

  /** Installs (explicit user action) the built-in agents a workflow needs, granting what their packages request. */
  async setupAgents(workflowId: string, actor = 'user'): Promise<{ installed: string[]; enabled: string[] }> {
    const { definition } = this.definition(workflowId);
    const ids = [...new Set(definition.nodes.filter((n) => n.type === 'agent').map((n) => (n as { agent: string }).agent))];
    const catalog = appAI(this.rt.app).catalog;
    const installed: string[] = [];
    const enabled: string[] = [];
    for (const id of ids) {
      const row = this.rt.db.get<{ enabled: number }>('SELECT enabled FROM agents WHERE id = ?', id);
      if (!row) {
        const pkg = catalog.builtinPackage(id);
        if (!pkg) continue; // non-builtin agents are installed by the user from the catalog
        await this.agents.install({ id, scope: 'builtin', grants: pkg.manifest.permissions.map((p) => p.permission) });
        installed.push(id);
      }
      if (!row?.enabled) {
        await this.agents.setEnabled(id, true);
        enabled.push(id);
      }
    }
    this.rt.audit.record({ actor, action: 'workflow.setup_agents', target: workflowId, details: { installed, enabled } });
    return { installed, enabled };
  }

  // ---------------------------------------------------------------- runs

  async startRun(workflowId: string, input: unknown, opts: StartOptions): Promise<RunView> {
    if (this.stopped) throw new AppError('SYSTEM_UNAVAILABLE', 'Система закрывается.');
    const { definition: def } = this.definition(workflowId);
    assertDefinition(def, this.known());
    const check = validator(def.inputSchema);
    if (!check(input)) throw new AppError('VALIDATION_FAILED', `Входные данные процесса: ${formatErrors(check.errors).join('; ')}`);
    for (const sid of opts.scope.sourceIds) if (!this.rt.db.get('SELECT id FROM sources WHERE id = ?', sid)) throw new AppError('NOT_FOUND', `Источник ${sid} не найден.`);
    for (const did of opts.scope.docIds) if (!this.rt.db.get('SELECT id FROM documents WHERE id = ?', did)) throw new AppError('NOT_FOUND', `Документ ${did} не найден.`);
    const limits = this.limitsFor(def, opts.limits);
    const scope = { ...opts.scope, containsConfidential: this.scopeConfidential(opts.scope) };
    const id = newId('run');
    const now = nowIso();
    const title = (opts.title ?? '').trim() || `${def.name} — ${now.slice(0, 16).replace('T', ' ')}`;
    this.rt.db.run(
      "INSERT INTO workflow_runs(id, workflow_id, workflow_version, definition, status, title, input, scope, limits, totals, created_at, started_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, '{}', ?, ?, ?)",
      id,
      def.id,
      def.version,
      JSON.stringify(def),
      title.slice(0, 300),
      JSON.stringify(input ?? {}),
      JSON.stringify(scope),
      JSON.stringify(limits),
      now,
      now,
      now,
    );
    this.rt.audit.record({ actor: opts.actor ?? 'user', action: 'workflow.start', target: def.id, details: { runId: id, scope: { sources: scope.sourceIds.length, docs: scope.docIds.length, web: scope.allowWeb } }, runId: id });
    this.event(id, null, 'info', 'run.start', `Запуск «${title}»`);
    this.emitRun(id);
    this.activate(id);
    void this.schedule(id);
    return this.get(id);
  }

  private run(id: string): RunRow {
    const r = this.rt.db.get<RunRow>('SELECT * FROM workflow_runs WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Запуск не найден.');
    return r;
  }

  private steps(runId: string): StepRow[] {
    return this.rt.db.all<StepRow>('SELECT * FROM run_steps WHERE run_id = ? ORDER BY started_at IS NULL, started_at, iteration, node_id', runId);
  }

  private stepView(s: StepRow, def: WorkflowDefinition, full: boolean): StepView {
    const node = def.nodes.find((n) => n.id === s.node_id);
    const mc = parseJson<{ route?: unknown } | null>(s.model_config, null);
    return {
      id: s.id,
      nodeId: s.node_id,
      title: node?.title ?? s.node_id,
      type: node?.type ?? 'function',
      iteration: s.iteration,
      status: s.status,
      agentId: s.agent_id,
      agentVersion: s.agent_version,
      route: mc?.route ?? null,
      attempts: s.attempts,
      reason: s.transition_reason,
      error: parseJson<AppErrorJson | null>(s.error, null),
      input: full ? parseJson(s.input, null) : undefined,
      output: full ? parseJson(s.output, null) : undefined,
      approval: parseJson(s.approval, null),
      startedAt: s.started_at,
      finishedAt: s.finished_at,
    };
  }

  get(runId: string, opts: { full?: boolean } = {}): RunView {
    const r = this.run(runId);
    const def = JSON.parse(r.definition) as WorkflowDefinition;
    const steps = this.steps(runId).map((s) => this.stepView(s, def, opts.full ?? true));
    return {
      id: r.id,
      workflowId: r.workflow_id,
      workflowVersion: r.workflow_version,
      workflowName: def.name,
      title: r.title,
      status: r.status,
      statusReason: r.status_reason,
      input: parseJson(r.input, {}),
      scope: parseJson(r.scope, { sourceIds: [], docIds: [], extraSystems: [], allowWeb: false }),
      limits: parseJson(r.limits, DEFAULT_LIMITS),
      totals: parseJson(r.totals, {}),
      error: parseJson(r.error, null),
      result: parseJson(r.result, null),
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      updatedAt: r.updated_at,
      steps,
      pendingApprovals: steps.filter((s) => s.status === 'waiting_for_approval'),
      nodes: def.nodes.map((n) => ({ id: n.id, type: n.type, title: n.title, dependsOn: n.dependsOn ?? [], ...(n.type === 'loop' ? { body: n.body } : {}), ...(n.type === 'agent' ? { agent: n.agent } : {}), ...(n.position ? { position: n.position } : {}) })),
    };
  }

  listRuns(f: { workflowId?: string; status?: RunStatus[]; limit?: number; offset?: number } = {}): { items: Omit<RunView, 'steps' | 'pendingApprovals' | 'nodes'>[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.workflowId) {
      where.push('workflow_id = ?');
      params.push(f.workflowId);
    }
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => '?').join(',')})`);
      params.push(...f.status);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.rt.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM workflow_runs ${w}`, ...params)!.c;
    const rows = this.rt.db.all<RunRow>(`SELECT * FROM workflow_runs ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, Math.min(f.limit ?? 50, 500), f.offset ?? 0);
    return {
      total,
      items: rows.map((r) => {
        const def = parseJson<WorkflowDefinition>(r.definition, { name: r.workflow_id } as WorkflowDefinition);
        return { id: r.id, workflowId: r.workflow_id, workflowVersion: r.workflow_version, workflowName: def.name, title: r.title, status: r.status, statusReason: r.status_reason, input: parseJson(r.input, {}), scope: parseJson(r.scope, { sourceIds: [], docIds: [], extraSystems: [], allowWeb: false }), limits: parseJson(r.limits, DEFAULT_LIMITS), totals: parseJson(r.totals, {}), error: parseJson(r.error, null), result: parseJson(r.result, null), createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, updatedAt: r.updated_at };
      }),
    };
  }

  events(runId: string, afterId = 0, limit = 500): { id: number; stepId: string | null; ts: string; level: string; type: string; message: string; data: unknown }[] {
    return this.rt.db
      .all<{ id: number; step_id: string | null; ts: string; level: string; type: string; message: string; data: string | null }>('SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id LIMIT ?', runId, afterId, Math.min(limit, 2000))
      .map((e) => ({ id: e.id, stepId: e.step_id, ts: e.ts, level: e.level, type: e.type, message: e.message, data: parseJson(e.data, null) }));
  }

  private event(runId: string, stepId: string | null, level: 'debug' | 'info' | 'warn' | 'error', type: string, message: string, data?: unknown): void {
    try {
      this.rt.db.run('INSERT INTO run_events(run_id, step_id, ts, level, type, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)', runId, stepId, nowIso(), level, type, message.slice(0, 2000), data === undefined ? null : JSON.stringify(data));
    } catch {
      // the system may be closing
    }
    this.rt.emit('run.event', { runId, stepId, level, type, message });
  }

  private emitRun(runId: string): void {
    const r = this.rt.db.get<{ status: RunStatus }>('SELECT status FROM workflow_runs WHERE id = ?', runId);
    if (r) this.rt.emit('run.updated', { runId, status: r.status });
  }

  private setRunStatus(runId: string, status: RunStatus, extra: { reason?: string | null; error?: AppErrorJson | null; result?: unknown } = {}): void {
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled';
    this.rt.db.run(
      `UPDATE workflow_runs SET status = ?, status_reason = ?, error = COALESCE(?, error), result = COALESCE(?, result), finished_at = CASE WHEN ? THEN ? ELSE finished_at END, updated_at = ? WHERE id = ?`,
      status,
      extra.reason ?? null,
      extra.error ? JSON.stringify(extra.error) : null,
      extra.result !== undefined ? JSON.stringify(extra.result) : null,
      terminal ? 1 : 0,
      nowIso(),
      nowIso(),
      runId,
    );
    this.emitRun(runId);
  }

  private updateStep(id: string, patch: Partial<Record<keyof StepRow, string | number | null>>): void {
    const keys = Object.keys(patch);
    this.rt.db.run(`UPDATE run_steps SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => patch[k as keyof StepRow] ?? null), nowIso(), id);
  }

  private activate(runId: string): ActiveRun {
    let a = this.active.get(runId);
    if (a) return a;
    const r = this.run(runId);
    const limits = parseJson<WorkflowLimits>(r.limits, DEFAULT_LIMITS);
    const budget = new RunBudget({ maxModelCalls: limits.maxModelCalls, maxTokens: limits.maxTokens, maxCostUsd: limits.maxCostUsd }, parseJson<Partial<RunTotals>>(r.totals, {}), (t) => {
      this.rt.db.run('UPDATE workflow_runs SET totals = ?, updated_at = ? WHERE id = ?', JSON.stringify(t), nowIso(), runId);
    });
    a = { controller: new AbortController(), abortReason: null, running: new Map(), scheduling: false, again: false, budget };
    this.active.set(runId, a);
    return a;
  }

  private async schedule(runId: string): Promise<void> {
    const a = this.active.get(runId);
    if (!a) return;
    if (a.scheduling) {
      a.again = true;
      return;
    }
    a.scheduling = true;
    try {
      do {
        a.again = false;
        this.tick(runId, a);
      } while (a.again);
    } catch (e) {
      const err = toAppError(e);
      this.rt.log.error('workflow scheduling failed', { runId, code: err.code, message: err.message });
      this.event(runId, null, 'error', 'run.error', `Внутренняя ошибка движка: ${err.message}`);
      this.setRunStatus(runId, 'failed', { error: err.toJSON(), reason: 'Внутренняя ошибка движка процессов.' });
    } finally {
      a.scheduling = false;
    }
  }

  /** Context visible to mappings: input, limits, latest output of every node, current loop iteration. */
  private context(r: RunRow, def: WorkflowDefinition, steps: StepRow[], loop?: { iteration: number; max: number }): Record<string, unknown> {
    const nodes: Record<string, unknown> = {};
    for (const n of def.nodes) {
      // status/iteration: latest finished attempt; output: latest SUCCESSFUL one (a skipped repeat keeps earlier data)
      const own = steps.filter((s) => s.node_id === n.id && TERMINAL.includes(s.status)).sort((a, b) => b.iteration - a.iteration);
      const latest = own[0];
      const done = own.find((s) => s.status === 'completed');
      if (latest) nodes[n.id] = { status: latest.status, iteration: latest.iteration, output: done ? parseJson(done.output, undefined) : undefined };
    }
    return {
      input: parseJson(r.input, {}),
      limits: parseJson(r.limits, DEFAULT_LIMITS),
      run: { id: r.id, title: r.title },
      scope: parseJson(r.scope, {}),
      nodes,
      loop: loop ? { iteration: loop.iteration, max: loop.max, isLast: loop.iteration + 1 >= loop.max, number: loop.iteration + 1 } : { iteration: 0, max: 1, isLast: true, number: 1 },
    };
  }

  private tick(runId: string, a: ActiveRun): void {
    const r = this.run(runId);
    const def = JSON.parse(r.definition) as WorkflowDefinition;
    if (r.status === 'cancelled' || r.status === 'completed' || r.status === 'failed') {
      if (!a.running.size) this.active.delete(runId);
      return;
    }
    if (r.status === 'paused') {
      if (!a.running.size) this.active.delete(runId);
      return;
    }
    let steps = this.steps(runId);
    const limits = parseJson<WorkflowLimits>(r.limits, DEFAULT_LIMITS);
    const byNode = new Map(def.nodes.map((n) => [n.id, n]));
    const loopOf = new Map<string, LoopNode>();
    for (const n of def.nodes) if (n.type === 'loop') for (const b of n.body) loopOf.set(b, n);
    const find = (nodeId: string, iteration: number) => steps.find((s) => s.node_id === nodeId && s.iteration === iteration);
    const loopIter = (loop: LoopNode): number => {
      const its = steps.filter((s) => loop.body.includes(s.node_id)).map((s) => s.iteration);
      const marker = steps.find((s) => s.node_id === loop.id);
      const declared = parseJson<{ iteration?: number } | null>(marker?.output ?? null, null)?.iteration;
      return Math.max(its.length ? Math.max(...its) : 0, declared ?? 0);
    };
    const maxIter = (loop: LoopNode, ctx: Record<string, unknown>): number => Math.max(1, Math.min(Number(resolveMapping(loop.maxIterations, ctx)) || 1, 20));

    let changed = false;
    // 1. loop bookkeeping: finished iterations → next iteration or loop completion
    for (const loop of def.nodes.filter((n): n is LoopNode => n.type === 'loop')) {
      const marker = find(loop.id, 0);
      if (!marker || marker.status !== 'running') continue;
      const it = loopIter(loop);
      const body = loop.body.map((b) => find(b, it));
      if (body.some((s) => !s || !TERMINAL.includes(s.status))) continue;
      if (body.some((s, i) => s!.status === 'failed' && !byNode.get(loop.body[i]!)!.optional)) continue; // run failure handled below
      const baseCtx = this.context(r, def, steps);
      const max = maxIter(loop, baseCtx);
      const ctx = this.context(r, def, steps, { iteration: it, max });
      if (evaluate(loop.until, ctx)) {
        this.completeStep(marker.id, { iterations: it + 1, iteration: it, converged: true }, `условие завершения выполнено на итерации ${it + 1}`);
        this.event(runId, marker.id, 'info', 'loop.done', `«${loop.title}»: завершён после ${it + 1} итераций`);
      } else if (it + 1 < max || (loop.extendWhen && evaluate(loop.extendWhen, ctx) && it + 1 < max + 5)) {
        this.updateStep(marker.id, { output: JSON.stringify({ iteration: it + 1 }), transition_reason: `итерация ${it + 2}` });
        this.event(runId, marker.id, 'info', 'loop.iteration', `«${loop.title}»: итерация ${it + 2}`);
      } else {
        this.completeStep(marker.id, { iterations: it + 1, iteration: it, converged: false }, 'достигнут предел итераций');
        this.event(runId, marker.id, 'warn', 'loop.limit', `«${loop.title}»: достигнут предел итераций (${max}), результат принят с замечаниями`);
      }
      changed = true;
      steps = this.steps(runId);
    }

    // 2. start every ready node
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const node of topoOrder(def)) {
        const loop = loopOf.get(node.id);
        let iteration = 0;
        if (loop) {
          const marker = find(loop.id, 0);
          if (!marker || marker.status !== 'running') continue;
          iteration = loopIter(loop);
        }
        const existing = find(node.id, iteration);
        if (existing && existing.status !== 'pending') continue;
        let ready = true;
        for (const dep of node.dependsOn ?? []) {
          const depIter = loop && loopOf.get(dep) === loop ? iteration : 0;
          const ds = find(dep, depIter);
          if (!ds || !(OK_DONE.includes(ds.status) || (ds.status === 'failed' && byNode.get(dep)?.optional))) {
            ready = false;
            break;
          }
        }
        if (!ready) continue;
        const running = steps.filter((s) => s.status === 'running' && byNode.get(s.node_id)?.type !== 'loop').length;
        if (node.type !== 'loop' && node.type !== 'approval' && running >= limits.maxParallel) continue;
        const loopCtx = loop ? { iteration, max: maxIter(loop, this.context(r, def, steps)) } : undefined;
        const ctx = this.context(r, def, steps, loopCtx);
        const stepId = existing?.id ?? newId('step');
        if (!existing) this.rt.db.run("INSERT INTO run_steps(id, run_id, node_id, iteration, status, attempts, updated_at) VALUES (?, ?, ?, ?, 'pending', 0, ?)", stepId, runId, node.id, iteration, nowIso());
        if (node.when && !evaluate(node.when, ctx)) {
          this.updateStep(stepId, { status: 'skipped', transition_reason: 'условие запуска не выполнено', finished_at: nowIso() });
          this.event(runId, stepId, 'info', 'step.skipped', `«${node.title}» пропущен: условие не выполнено`);
        } else if (node.type === 'loop') {
          this.updateStep(stepId, { status: 'running', started_at: nowIso(), output: JSON.stringify({ iteration: 0 }) });
          this.event(runId, stepId, 'info', 'loop.start', `«${node.title}»: итерация 1`);
        } else if (node.type === 'approval') {
          this.requestApproval(r, node, stepId, ctx);
        } else {
          this.updateStep(stepId, { status: 'running', started_at: nowIso(), attempts: (existing?.attempts ?? 0) + 1 });
          const p = this.execute(r, node, stepId, ctx, (existing?.attempts ?? 0) + 1).finally(() => {
            a.running.delete(stepId);
            void this.schedule(runId);
          });
          a.running.set(stepId, p);
        }
        this.rt.emit('run.step', { runId, stepId, nodeId: node.id });
        steps = this.steps(runId);
        progressed = true;
        changed = true;
      }
    }

    // 3. run state — only judged on a pass that changed nothing (skips may have completed a loop iteration)
    if (changed) {
      a.again = true;
      return;
    }
    if (a.running.size) {
      if (r.status !== 'running') this.setRunStatus(runId, 'running');
      return;
    }
    const failed = steps.filter((s) => s.status === 'failed' && !byNode.get(s.node_id)?.optional);
    if (failed.length) {
      const err = parseJson<AppErrorJson | null>(failed[0]!.error, null);
      this.setRunStatus(runId, 'failed', { error: err, reason: `Шаг «${byNode.get(failed[0]!.node_id)?.title ?? failed[0]!.node_id}» завершился ошибкой.` });
      this.event(runId, null, 'error', 'run.failed', `Процесс завершился ошибкой на шаге «${byNode.get(failed[0]!.node_id)?.title}»: ${err?.message ?? ''}`);
      this.active.delete(runId);
      return;
    }
    const waiting = steps.filter((s) => s.status === 'waiting_for_approval');
    const topLevel = def.nodes.filter((n) => !loopOf.has(n.id));
    const allDone = topLevel.every((n) => {
      const s = find(n.id, 0);
      return !!s && TERMINAL.includes(s.status);
    });
    if (allDone) {
      const ctx = this.context(r, def, steps);
      const result = def.output ? resolveMapping(def.output, ctx) : null;
      this.setRunStatus(runId, 'completed', { result, reason: null });
      this.event(runId, null, 'info', 'run.completed', 'Процесс завершён');
      this.active.delete(runId);
      return;
    }
    if (waiting.length) {
      if (r.status !== 'waiting_for_approval') {
        this.setRunStatus(runId, 'waiting_for_approval', { reason: `Ожидает решения: ${waiting.map((w) => byNode.get(w.node_id)?.title ?? w.node_id).join(', ')}` });
      }
      return;
    }
    // nothing running, nothing waiting, not done: a dependency can never be satisfied
    this.setRunStatus(runId, 'failed', { error: new AppError('WORKFLOW_INVALID', 'Процесс не может продолжиться: остались шаги с невыполнимыми зависимостями.').toJSON(), reason: 'Тупик в графе процесса.' });
    this.active.delete(runId);
  }

  private completeStep(stepId: string, output: unknown, reason: string | null = null): void {
    this.updateStep(stepId, { status: 'completed', output: JSON.stringify(output ?? null), transition_reason: reason, finished_at: nowIso(), error: null });
  }

  private requestApproval(r: RunRow, node: ApprovalNode, stepId: string, ctx: Record<string, unknown>): void {
    const prompt = resolveMapping(node.prompt, ctx);
    const questions = node.questions ? resolveMapping(node.questions, ctx) : [];
    const approval = { prompt, questions: Array.isArray(questions) ? questions : [], allowRevise: !!node.allowRevise, onReject: node.onReject ?? 'cancel', requestedAt: nowIso() };
    this.updateStep(stepId, { status: 'waiting_for_approval', approval: JSON.stringify(approval), started_at: nowIso() });
    this.event(r.id, stepId, 'info', 'approval.requested', `Требуется решение пользователя: «${node.title}»`);
  }

  private async execute(r: RunRow, node: WorkflowNode, stepId: string, ctx: Record<string, unknown>, attempt: number): Promise<void> {
    const a = this.active.get(r.id)!;
    const limits = parseJson<WorkflowLimits>(r.limits, DEFAULT_LIMITS);
    const scope = parseJson<RunScope & { containsConfidential?: boolean }>(r.scope, { sourceIds: [], docIds: [], extraSystems: [], allowWeb: false });
    const timeoutMs = (node as { timeoutMs?: number }).timeoutMs ?? limits.stepTimeoutMs;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const signal = AbortSignal.any([a.controller.signal, timeout.signal]);
    try {
      let output: unknown;
      if (node.type === 'agent') {
        const input = resolveMapping(node.input, ctx);
        this.updateStep(stepId, { input: JSON.stringify(input) });
        const { pkg, config, version } = await this.agents.forRun(node.agent);
        let route: unknown = null;
        try {
          route = appAI(this.rt.app).ai.preview({ rt: this.rt, policy: config.modelPolicy, taskType: pkg.manifest.model.taskType, containsConfidential: !!scope.containsConfidential, needsStructured: true });
        } catch {
          route = null;
        }
        this.updateStep(stepId, { agent_id: node.agent, agent_version: version, model_config: JSON.stringify({ policy: config.modelPolicy, generation: config.generation, route }) });
        this.event(r.id, stepId, 'info', 'step.start', `«${node.title}»: агент ${pkg.manifest.name}${attempt > 1 ? ` (попытка ${attempt})` : ''}`);
        const note = node.note ? resolveMapping(node.note, ctx) : undefined;
        const context = node.context ? (resolveMapping(node.context, ctx) as ContextBlock[] | undefined) : undefined;
        const res = await this.agentRuntime.run(node.agent, pkg, config, input, {
          runId: r.id,
          stepId,
          scope,
          budget: a.budget,
          signal,
          containsConfidential: !!scope.containsConfidential,
          ...(typeof note === 'string' && note.trim() ? { note } : Array.isArray(note) && note.length ? { note: (note as unknown[]).map(String).join('\n') } : {}),
          ...(Array.isArray(context) ? { context: context.filter((c) => c && typeof c.content === 'string') } : {}),
          onEvent: (e) => this.event(r.id, stepId, e.type.includes('denied') || e.type.includes('error') ? 'warn' : 'info', e.type, e.message, e.data),
        });
        for (const w of res.warnings) this.event(r.id, stepId, 'warn', 'agent.warning', w);
        output = res.output;
        this.updateStep(stepId, { model_config: JSON.stringify({ policy: config.modelPolicy, generation: config.generation, route: res.route, nativeStructured: res.nativeStructured, rounds: res.rounds, repairs: res.repairs, toolCalls: res.toolCalls.map((t) => ({ tool: t.tool, ok: t.ok, error: t.error?.code ?? null, ms: t.durationMs })) }) });
      } else if (node.type === 'function') {
        const fn = workflowFunction(node.fn);
        if (!fn) throw new AppError('WORKFLOW_INVALID', `Функция «${node.fn}» не найдена.`);
        const args = resolveMapping(node.input, ctx) as Record<string, unknown>;
        this.updateStep(stepId, { input: JSON.stringify(args) });
        this.event(r.id, stepId, 'info', 'step.start', `«${node.title}»: ${fn.label}`);
        const fctx: FunctionContext = {
          rt: this.rt,
          runId: r.id,
          stepId,
          nodeId: node.id,
          iteration: (ctx.loop as { iteration: number }).iteration,
          scope,
          runInput: parseJson(r.input, {}),
          signal,
          log: (message, data) => this.event(r.id, stepId, 'info', 'fn.log', message, data),
        };
        output = await fn.run(args ?? {}, fctx);
      }
      if (signal.aborted) throw timeout.signal.aborted ? new AppError('TIMEOUT') : new AppError('CANCELLED');
      this.completeStep(stepId, output);
      this.event(r.id, stepId, 'info', 'step.done', `«${node.title}»: готово`);
    } catch (e) {
      let err = toAppError(e);
      if (timeout.signal.aborted && !a.controller.signal.aborted) err = new AppError('TIMEOUT', `Шаг «${node.title}» превысил тайм-аут ${Math.round(timeoutMs / 1000)} с.`);
      if (a.controller.signal.aborted) {
        if (a.abortReason === 'stop') {
          // the app / system is closing: the step will run again after the user resumes
          this.updateStep(stepId, { status: 'pending', transition_reason: 'прервано закрытием системы', attempts: Math.max(0, attempt - 1) });
        } else {
          this.updateStep(stepId, { status: 'cancelled', transition_reason: a.abortReason === 'cancel' ? 'отменено пользователем' : 'процесс остановлен', finished_at: nowIso() });
        }
        return;
      }
      const retries = node.type === 'agent' ? (node.retries ?? 1) : 0;
      if (RETRYABLE.includes(err.code) && attempt <= retries) {
        this.event(r.id, stepId, 'warn', 'step.retry', `«${node.title}»: ${err.message} — повтор (${attempt}/${retries})`);
        // stays "running" while waiting, so no other scheduling pass can start it twice
        this.updateStep(stepId, { transition_reason: `повтор после ошибки ${err.code}`, error: JSON.stringify(err.toJSON()) });
        await abortableSleep(this.retryDelayMs * attempt, a.controller.signal).catch(() => undefined);
        if (a.controller.signal.aborted) {
          this.updateStep(stepId, a.abortReason === 'stop' ? { status: 'pending', attempts: Math.max(0, attempt - 1) } : { status: 'cancelled', finished_at: nowIso() });
          return;
        }
        this.updateStep(stepId, { status: 'pending' });
        return;
      }
      this.updateStep(stepId, { status: 'failed', error: JSON.stringify(err.toJSON()), transition_reason: err.code, finished_at: nowIso() });
      this.event(r.id, stepId, 'error', 'step.failed', `«${node.title}»: ${err.message}`, { code: err.code, hint: err.hint });
      this.rt.audit.recordError(err, `workflow ${r.id} / ${node.id}`);
      if (USER_FIXABLE.includes(err.code)) {
        this.setRunStatus(r.id, 'paused', { reason: `${ERROR_CATALOG[err.code].message} ${err.hint ?? ''} Исправьте и нажмите «Продолжить».`.trim(), error: err.toJSON() });
      } else if (!node.optional) {
        a.abortReason = 'fail';
        a.controller.abort();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------- user control

  async approve(runId: string, stepId: string, d: ApprovalDecision, actor = 'user'): Promise<RunView> {
    const r = this.run(runId);
    if (r.status === 'cancelled' || r.status === 'completed' || r.status === 'failed') throw new AppError('INVALID_STATE_TRANSITION', 'Запуск уже завершён.');
    const s = this.rt.db.get<StepRow>('SELECT * FROM run_steps WHERE id = ? AND run_id = ?', stepId, runId);
    if (!s) throw new AppError('NOT_FOUND', 'Шаг не найден.');
    if (s.status !== 'waiting_for_approval') throw new AppError('INVALID_STATE_TRANSITION', 'Шаг не ожидает решения.');
    const approval = parseJson<{ questions: { question?: string; text?: string; blocking?: boolean }[]; allowRevise: boolean; onReject: 'cancel' | 'continue' }>(s.approval, { questions: [], allowRevise: false, onReject: 'cancel' });
    if (!['approve', 'reject', 'revise'].includes(d.decision)) throw new AppError('VALIDATION_FAILED', 'Решение: approve, reject или revise.');
    if (d.decision === 'revise' && !approval.allowRevise) throw new AppError('VALIDATION_FAILED', 'Для этого шага доработка не предусмотрена.');
    if (d.decision === 'revise' && !d.comment?.trim()) throw new AppError('VALIDATION_FAILED', 'Опишите, что нужно доработать.');
    const answers = (d.answers ?? []).filter((x) => x && typeof x.question === 'string' && typeof x.answer === 'string').map((x) => ({ question: x.question.slice(0, 1000), answer: x.answer.slice(0, 5000) }));
    if (d.decision === 'approve') {
      const unanswered = approval.questions.filter((q) => q.blocking !== false).map((q) => q.question ?? q.text ?? '').filter((q) => q && !answers.some((a) => a.question === q && a.answer.trim()));
      if (unanswered.length) throw new AppError('VALIDATION_FAILED', `Ответьте на обязательные вопросы: ${unanswered.slice(0, 3).join('; ')}`, { details: { unanswered } });
    }
    const output = { decision: d.decision, comment: d.comment?.slice(0, 10000) ?? '', answers, choices: (d.choices ?? []).map((c) => ({ id: String(c.id), value: String(c.value).slice(0, 2000) })), decidedAt: nowIso(), decidedBy: actor };
    this.completeStep(stepId, output, `решение: ${d.decision}`);
    this.rt.audit.record({ actor, action: 'workflow.approval', target: s.node_id, details: { decision: d.decision, comment: d.comment ?? null }, runId });
    this.event(runId, stepId, 'info', 'approval.decided', `Решение пользователя: ${d.decision === 'approve' ? 'утверждено' : d.decision === 'revise' ? 'на доработку' : 'отклонено'}${d.comment ? ` — ${d.comment.slice(0, 200)}` : ''}`);
    if (d.decision === 'reject' && approval.onReject === 'cancel') {
      await this.cancel(runId, actor, 'Отклонено пользователем. Промежуточные результаты сохранены в запуске.');
      return this.get(runId);
    }
    if (r.status === 'waiting_for_approval') this.setRunStatus(runId, 'running');
    if (r.status !== 'paused') {
      this.activate(runId);
      await this.schedule(runId);
    }
    return this.get(runId);
  }

  async pause(runId: string, actor = 'user'): Promise<RunView> {
    const r = this.run(runId);
    if (!['running', 'waiting_for_approval', 'pending'].includes(r.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Приостановить можно только выполняющийся процесс.');
    this.setRunStatus(runId, 'paused', { reason: 'Приостановлено пользователем. Выполняющиеся шаги завершатся, новые не начнутся.' });
    this.rt.audit.record({ actor, action: 'workflow.pause', target: runId, runId });
    this.event(runId, null, 'info', 'run.paused', 'Процесс приостановлен');
    return this.get(runId);
  }

  async resume(runId: string, actor = 'user'): Promise<RunView> {
    const r = this.run(runId);
    if (r.status !== 'paused' && r.status !== 'failed') throw new AppError('INVALID_STATE_TRANSITION', 'Продолжить можно приостановленный или завершившийся ошибкой процесс.');
    // failed steps (e.g. model was unavailable) are retried; completed results are kept
    this.rt.db.run("UPDATE run_steps SET status = 'pending', error = NULL, transition_reason = 'повтор после продолжения', finished_at = NULL WHERE run_id = ? AND status IN ('failed','cancelled')", runId);
    this.rt.db.run('UPDATE workflow_runs SET error = NULL, finished_at = NULL WHERE id = ?', runId);
    this.setRunStatus(runId, 'running', { reason: null });
    this.rt.audit.record({ actor, action: 'workflow.resume', target: runId, runId });
    this.event(runId, null, 'info', 'run.resumed', 'Процесс продолжен');
    const a = this.activate(runId);
    if (a.controller.signal.aborted) {
      this.active.delete(runId);
      this.activate(runId);
    }
    await this.schedule(runId);
    return this.get(runId);
  }

  async cancel(runId: string, actor = 'user', reason = 'Отменено пользователем. Промежуточные результаты сохранены.'): Promise<RunView> {
    const r = this.run(runId);
    if (r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'Запуск уже завершён.');
    this.setRunStatus(runId, 'cancelled', { reason });
    const a = this.active.get(runId);
    if (a) {
      a.abortReason = 'cancel';
      a.controller.abort();
      await Promise.allSettled([...a.running.values()]);
      this.active.delete(runId);
    }
    this.rt.db.run("UPDATE run_steps SET status = 'cancelled', transition_reason = 'процесс отменён', finished_at = ? WHERE run_id = ? AND status IN ('pending','running','waiting_for_approval')", nowIso(), runId);
    this.rt.audit.record({ actor, action: 'workflow.cancel', target: runId, runId });
    this.event(runId, null, 'warn', 'run.cancelled', reason);
    return this.get(runId);
  }

  /** Raises the limits of a run paused by its budget, so it can continue. */
  updateLimits(runId: string, patch: Partial<WorkflowLimits>, actor = 'user'): RunView {
    const r = this.run(runId);
    if (r.status === 'completed' || r.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'Запуск уже завершён.');
    const def = JSON.parse(r.definition) as WorkflowDefinition;
    const limits = this.limitsFor(def, { ...parseJson<WorkflowLimits>(r.limits, DEFAULT_LIMITS), ...patch });
    this.rt.db.run('UPDATE workflow_runs SET limits = ?, updated_at = ? WHERE id = ?', JSON.stringify(limits), nowIso(), runId);
    const a = this.active.get(runId);
    if (a) Object.assign(a.budget.limits, { maxModelCalls: limits.maxModelCalls, maxTokens: limits.maxTokens, maxCostUsd: limits.maxCostUsd });
    this.rt.audit.record({ actor, action: 'workflow.limits', target: runId, details: patch, runId });
    return this.get(runId);
  }

  hasActive(): number {
    return this.rt.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM workflow_runs WHERE status IN ('pending','running')")!.c;
  }

  async pauseAll(reason: string): Promise<void> {
    for (const r of this.rt.db.all<{ id: string }>("SELECT id FROM workflow_runs WHERE status IN ('pending','running','waiting_for_approval')")) {
      this.setRunStatus(r.id, 'paused', { reason });
    }
    await Promise.allSettled([...this.active.values()].flatMap((a) => [...a.running.values()]));
  }

  async cancelAll(reason: string): Promise<void> {
    for (const r of this.rt.db.all<{ id: string }>("SELECT id FROM workflow_runs WHERE status IN ('pending','running','waiting_for_approval','paused')")) await this.cancel(r.id, 'system', reason);
  }

  // ---------------------------------------------------------------- lifecycle

  /** Recovery: interrupted runs never continue silently — they are paused and wait for the user. */
  start(): void {
    const interrupted = this.rt.db.all<{ id: string; definition: string }>("SELECT id, definition FROM workflow_runs WHERE status IN ('pending','running')");
    for (const r of interrupted) {
      const loops = parseJson<WorkflowDefinition>(r.definition, { nodes: [] } as unknown as WorkflowDefinition).nodes.filter((n) => n.type === 'loop').map((n) => n.id);
      // agent/function steps return to pending; loop markers stay "running" (they only track the iteration)
      for (const s of this.rt.db.all<{ id: string; node_id: string; attempts: number }>("SELECT id, node_id, attempts FROM run_steps WHERE run_id = ? AND status = 'running'", r.id)) {
        if (!loops.includes(s.node_id)) this.updateStep(s.id, { status: 'pending', transition_reason: 'прервано перезапуском', attempts: Math.max(0, s.attempts - 1) });
      }
      this.setRunStatus(r.id, 'paused', { reason: 'Восстановлено после перезапуска приложения. Проверьте состояние и нажмите «Продолжить».' });
      this.event(r.id, null, 'warn', 'run.recovered', 'Запуск был прерван и восстановлен после перезапуска');
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const waits: Promise<unknown>[] = [];
    for (const [runId, a] of this.active) {
      a.abortReason = 'stop';
      a.controller.abort();
      waits.push(Promise.allSettled([...a.running.values()]));
      try {
        const r = this.run(runId);
        if (r.status === 'running' || r.status === 'pending') this.setRunStatus(runId, 'paused', { reason: 'Прервано закрытием системы. Нажмите «Продолжить», чтобы возобновить.' });
      } catch {
        // closing
      }
    }
    await Promise.race([Promise.all(waits), new Promise((res) => setTimeout(res, 5000))]);
    this.active.clear();
  }
}
