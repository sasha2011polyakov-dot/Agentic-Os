import type { SystemRuntime, RuntimeService } from '../systems/runtime.ts';
import type { SystemManager } from '../systems/manager.ts';
import type { AgentService } from '../agents/service.ts';
import type { AgentConfig, AgentRuntime, ContextBlock } from '../agents/runtime.ts';
import type { PermissionId, RunScope } from '../agents/permissions.ts';
import type { ChangeSetService, ChangeSetView } from '../changes/change-sets.ts';
import type { DocumentService } from '../vault/documents.ts';
import type { SourceService } from '../sources/sources.ts';
import type { ToolCallRecord } from '../tools/registry.ts';
import { KNOWN_TOOLS, TOOL_PERMISSIONS } from '../agents/package.ts';
import { appAI } from '../ai/app-ai.ts';
import { RunBudget, type RunTotals } from '../ai/budget.ts';
import { AppError, ERROR_CATALOG, toAppError, type AppErrorJson, type ErrorCode } from '../util/errors.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { sha256 } from '../util/hash.ts';
import { modeAtLeast, modeLabel, type AccessMode } from '../security/policy.ts';
import { inspectCheck, projectChecks, runCheck } from './checks.ts';
import { assertTransition, MISSION_STATUS_LABELS, PHASE_LABELS, statusForPhase, TERMINAL_STATUSES, WORKING_STATUSES, type MissionPhase, type MissionStatus } from './state.ts';
import { MISSION_AGENTS, ROLE_AGENTS, ROLE_DESCRIPTIONS, riskyPlanReasons, validatePlan } from './plan.ts';
import { buildSummary, finalStatus, guardCriteria, summaryMarkdown, type VerifierOutput } from './verify.ts';
import {
  compactOutput,
  crossSystemSearch,
  groundClaims,
  groundEvidence,
  type AdvisorOutput,
  type ArchitectOutput,
  type CrossSystemHit,
  type DocumenterOutput,
  type ExplorerOutput,
  type GroundedClaim,
  type GroundedEvidence,
  type ImplementerOutput,
  type PlannerOutput,
  type ResearcherOutput,
  type ReviewerOutput,
  type SecurityOutput,
  type WebOutput,
} from './context.ts';
import {
  DEFAULT_MISSION_LIMITS,
  DEFAULT_POLICY,
  type ApprovalKind,
  type Artifact,
  type CheckRecord,
  type Criterion,
  type CriterionVerification,
  type MissionAttachment,
  type MissionDecision,
  type MissionLimits,
  type MissionPolicy,
  type MissionScope,
  type MissionStepView,
  type MissionSummary,
  type MissionView,
  type NormalizedTask,
  type PendingApproval,
  type PlanRole,
  type PlanStep,
  type SolutionOption,
  type Strategy,
} from './types.ts';

// ------------------------------------------------------------------------------------------------ rows

interface MissionRow {
  id: string;
  key: string;
  title: string;
  original_request: string;
  attachments: string;
  normalized: string | null;
  revision: number;
  mode: 'plan' | 'execute';
  status: MissionStatus;
  phase: MissionPhase;
  priority: 'critical' | 'high' | 'medium' | 'low';
  scope: string;
  policy: string;
  limits: string;
  context: string | null;
  research: string | null;
  options: string | null;
  strategy: string | null;
  plan: string | null;
  plan_stale: number;
  criteria: string;
  extra_requirements: string;
  approved_checks: string;
  baseline: string | null;
  limitations: string;
  pending: string | null;
  fix_rounds: number;
  review: string | null;
  summary: string | null;
  report_doc_id: string | null;
  totals: string;
  error: string | null;
  status_reason: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface StepRow {
  id: string;
  mission_id: string;
  seq: number;
  phase: MissionPhase;
  plan_step: string | null;
  role: string;
  agent_id: string | null;
  title: string;
  status: MissionStepView['status'];
  depends_on: string;
  input: string | null;
  output: string | null;
  error: string | null;
  attempts: number;
  idempotency_key: string | null;
  side_effects: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

interface SideEffect {
  tool: string;
  target: string;
  ref?: string;
  title?: string;
}

interface MissionContextData {
  projects: { sourceId: string; name: string; accessMode: AccessMode }[];
  explorer: ExplorerOutput | null;
  local: { evidence: GroundedEvidence[]; gaps: string[] } | null;
  crossSystem: CrossSystemHit[];
  notes: string[];
}

interface MissionResearchData {
  web: Omit<WebOutput, 'claims'> | null;
  claims: GroundedClaim[];
  verified: number;
  domains: number;
}

interface ReviewData {
  security?: SecurityOutput & { files: number };
  independent?: ReviewerOutput;
  verifier?: Pick<VerifierOutput, 'problems' | 'regressions_suspected' | 'overall'>;
  fix?: { round: number; problems: string[] };
  apply?: { decision: 'applied' | 'skipped'; changeSetId: string; at: string; result?: string };
  checksNotRun?: { name: string; reason: string }[];
  lastVerification?: string;
}

interface ExtraRequirement {
  id: string;
  text: string;
  kind: 'requirement' | 'criterion' | 'constraint' | 'option';
  addedAt: string;
}

interface Active {
  controller: AbortController;
  abortReason: 'cancel' | 'stop' | null;
  budget: RunBudget;
  /** Live scope object: tool denials apply to steps that are already running. */
  scope: RunScope;
  driving: Promise<void> | null;
  again: boolean;
}

type AgentOutcome = { ok: true; output: Record<string, unknown>; stepId: string; toolCalls: ToolCallRecord[] } | { ok: false; stepId: string | null; error: AppError; fatal: boolean };

interface AgentCall {
  phase: MissionPhase;
  role: string;
  agentId: string;
  title: string;
  planStep?: string | null;
  input: unknown;
  note?: string;
  context?: ContextBlock[];
  variant?: string;
  rowId?: string;
  dependsOn?: string[];
}

export interface CreateMissionInput {
  request: string;
  title?: string;
  mode?: 'plan' | 'execute';
  priority?: 'critical' | 'high' | 'medium' | 'low';
  scope?: Partial<MissionScope>;
  attachments?: MissionAttachment[];
  policy?: Partial<MissionPolicy>;
  limits?: Partial<MissionLimits>;
  /** Default true: analysis starts immediately. */
  start?: boolean;
  actor?: string;
}

export interface MissionPreflight {
  ok: boolean;
  aiMode: string;
  offline: boolean;
  agents: { id: string; role: string; installed: boolean; enabled: boolean; missingGrants: PermissionId[]; route: { providerId: string; model: string; locality: string } | null; routeError: string | null }[];
  projects: { sourceId: string; name: string; accessMode: AccessMode; accessModeLabel: string; checks: string[] }[];
  problems: string[];
  warnings: string[];
}

// ------------------------------------------------------------------------------------------------ constants

/** Agents without which a mission cannot run at all. Other roles are optional: their absence is a stated limitation. */
const CORE_AGENTS = ['mission-analyst', 'mission-planner', 'verifier'];
/** Roles whose tools have side effects (proposals, documents, drafts): never re-run silently after an interruption. */
const SIDE_EFFECT_ROLES = new Set(['implementer']);
const SIDE_EFFECT_TOOLS = new Set(['propose_file_change', 'create_document', 'create_agent_definition', 'create_workflow_definition', 'run_check', 'save_research_note', 'create_source_links']);
const USER_FIXABLE: ErrorCode[] = ['NO_MODEL_CONFIGURED', 'MODEL_UNAVAILABLE', 'PROVIDER_UNREACHABLE', 'PROVIDER_AUTH_FAILED', 'PROVIDER_RATE_LIMITED', 'AGENT_NOT_ENABLED', 'BUDGET_EXCEEDED', 'OFFLINE_MODE', 'NETWORK_POLICY_DENIED', 'POLICY_CONFIDENTIAL_SOURCE', 'SECRET_STORE_UNAVAILABLE'];
/** Errors after which another local model is tried (28.15) — never a cloud model. */
const FALLBACK_CODES: ErrorCode[] = ['MODEL_UNAVAILABLE', 'STRUCTURED_OUTPUT_FAILED', 'PROVIDER_UNREACHABLE', 'PROVIDER_ERROR', 'CONTEXT_TOO_LARGE'];
/** Tool failures that mean "this capability is not available here" — reported as limitations, not hidden. */
const LIMITING_TOOL_ERRORS = new Set(['WEB_SEARCH_NOT_CONFIGURED', 'FETCH_FAILED', 'FETCH_BLOCKED', 'PERMISSION_DENIED', 'MODE_FORBIDS', 'CHECK_NOT_APPROVED', 'CHECK_NOT_DEFINED', 'COMMAND_BLOCKED', 'OFFLINE_MODE', 'NETWORK_POLICY_DENIED', 'CROSS_SYSTEM_DENIED', 'SECRET_EGRESS_BLOCKED', 'READ_ONLY_SOURCE']);
const LOCAL_TOOLS = ['search_documents', 'read_document', 'list_documents', 'project_inventory', 'list_project_files', 'read_project_file', 'graph_neighbors', 'propose_file_change', 'run_check', 'create_source_links', 'save_research_note'];
const WEB_TOOLS = ['web_search', 'open_url', 'fetch_documentation', 'search_github', 'inspect_repository', 'compare_sources'];
const REPORT_TASK_TYPES = ['research', 'design', 'analysis', 'spec', 'documentation'];
const DOC_FOLDERS = ['Reports', 'Specs', 'Research', 'Notes', 'Missions', 'Docs'];
const MISSION_FOLDER = 'Missions';
const MAX_QUESTION_ROUNDS = 3;
const MAX_ATTACHMENT_CHARS = 50_000;

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Task Execution Engine of ONE system (section 28): a natural-language assignment goes through the stages it needs
 * (analysis → context → research → strategy → planning → execution → verification → fix → review → summary).
 * Every state change is persisted before it is acted upon; agents act only through AgentRuntime and the controlled
 * tool executor; file changes become one change set per mission and reach a project only through the review gates of
 * section 29. The final status is computed from criteria and evidence, never from "the agent said it is done".
 */
export class MissionEngine implements RuntimeService {
  private readonly active = new Map<string, Active>();
  private stopped = false;

  constructor(
    private readonly rt: SystemRuntime,
    private readonly deps: { agents: AgentService; agentRuntime: AgentRuntime; changes: ChangeSetService; docs: DocumentService; sources: SourceService; systems: SystemManager },
  ) {}

  // ============================================================================================ queries

  private row(id: string): MissionRow {
    const r = this.rt.db.get<MissionRow>('SELECT * FROM missions WHERE id = ? OR key = ?', id, id);
    if (!r) throw new AppError('NOT_FOUND', 'Поручение не найдено.');
    return r;
  }

  private stepRows(missionId: string): StepRow[] {
    return this.rt.db.all<StepRow>('SELECT * FROM mission_steps WHERE mission_id = ? ORDER BY seq', missionId);
  }

  private stepRow(id: string): StepRow {
    const s = this.rt.db.get<StepRow>('SELECT * FROM mission_steps WHERE id = ?', id);
    if (!s) throw new AppError('NOT_FOUND', 'Этап поручения не найден.');
    return s;
  }

  private scopeOf(m: MissionRow): MissionScope {
    return parseJson<MissionScope>(m.scope, { kind: 'system', sourceIds: [], docIds: [], systemIds: [], allowWeb: false });
  }

  private policyOf(m: MissionRow): MissionPolicy {
    return { ...DEFAULT_POLICY, ...parseJson<Partial<MissionPolicy>>(m.policy, {}) };
  }

  private limitsOf(m: MissionRow): MissionLimits {
    return { ...DEFAULT_MISSION_LIMITS, ...parseJson<Partial<MissionLimits>>(m.limits, {}) };
  }

  private normalizedOf(m: MissionRow): NormalizedTask | null {
    return parseJson<NormalizedTask | null>(m.normalized, null);
  }

  private criteriaOf(m: MissionRow): Criterion[] {
    return parseJson<Criterion[]>(m.criteria, []);
  }

  private planOf(m: MissionRow): PlanStep[] {
    return parseJson<PlanStep[]>(m.plan, []);
  }

  private contextOf(m: MissionRow): MissionContextData {
    return { projects: [], explorer: null, local: null, crossSystem: [], notes: [], ...parseJson<Partial<MissionContextData>>(m.context, {}) };
  }

  private researchOf(m: MissionRow): MissionResearchData {
    return { web: null, claims: [], verified: 0, domains: 0, ...parseJson<Partial<MissionResearchData>>(m.research, {}) };
  }

  private reviewOf(m: MissionRow): ReviewData {
    return parseJson<ReviewData>(m.review, {});
  }

  private pendingOf(m: MissionRow): PendingApproval | null {
    return parseJson<PendingApproval | null>(m.pending, null);
  }

  private limitationsOf(m: MissionRow): string[] {
    return parseJson<string[]>(m.limitations, []);
  }

  private extrasOf(m: MissionRow): ExtraRequirement[] {
    return parseJson<ExtraRequirement[]>(m.extra_requirements, []);
  }

  private approvedChecksOf(m: MissionRow): { sourceId: string; name: string; contentHash?: string | null }[] {
    return parseJson(m.approved_checks, []);
  }

  /** Projects of the home system the mission may read (scope kind «system» = every connected project). */
  private projectsOf(m: MissionRow): { sourceId: string; name: string; accessMode: AccessMode }[] {
    const scope = this.scopeOf(m);
    if (scope.kind === 'public') return [];
    const all = this.deps.sources.list('project');
    const ids = scope.sourceIds.length ? new Set(scope.sourceIds) : null;
    return all.filter((s) => !ids || ids.has(s.id)).map((s) => ({ sourceId: s.id, name: s.name, accessMode: s.accessMode }));
  }

  private enabledAgents(): Set<string> {
    return new Set(this.rt.db.all<{ id: string }>('SELECT id FROM agents WHERE enabled = 1').map((r) => r.id));
  }

  private availableRoles(): Set<string> {
    const enabled = this.enabledAgents();
    return new Set((Object.keys(ROLE_AGENTS) as PlanRole[]).filter((r) => enabled.has(ROLE_AGENTS[r])));
  }

  // ============================================================================================ events & persistence

  events(id: string, afterId = 0, limit = 500): { id: number; stepId: string | null; ts: string; level: string; type: string; message: string; data: unknown }[] {
    const m = this.row(id);
    return this.rt.db
      .all<{ id: number; step_id: string | null; ts: string; level: string; type: string; message: string; data: string | null }>('SELECT * FROM mission_events WHERE mission_id = ? AND id > ? ORDER BY id LIMIT ?', m.id, afterId, Math.min(limit, 2000))
      .map((e) => ({ id: e.id, stepId: e.step_id, ts: e.ts, level: e.level, type: e.type, message: e.message, data: parseJson(e.data, null) }));
  }

  messages(id: string): { id: string; role: string; body: string; data: unknown; createdAt: string }[] {
    const m = this.row(id);
    return this.rt.db
      .all<{ id: string; role: string; body: string; data: string | null; created_at: string }>('SELECT * FROM mission_messages WHERE mission_id = ? ORDER BY created_at, rowid', m.id)
      .map((r) => ({ id: r.id, role: r.role, body: r.body, data: parseJson(r.data, null), createdAt: r.created_at }));
  }

  private event(missionId: string, stepId: string | null, level: 'debug' | 'info' | 'warn' | 'error', type: string, message: string, data?: unknown): void {
    try {
      this.rt.db.run('INSERT INTO mission_events(mission_id, step_id, ts, level, type, message, data) VALUES (?, ?, ?, ?, ?, ?, ?)', missionId, stepId, nowIso(), level, type, message.slice(0, 2000), data === undefined ? null : JSON.stringify(data));
    } catch {
      // the system may be closing
    }
    this.rt.emit('mission.event', { missionId, stepId, level, type, message });
  }

  private message(missionId: string, role: 'user' | 'advisor' | 'system', body: string, data?: unknown): string {
    const id = newId('msg');
    this.rt.db.run('INSERT INTO mission_messages(id, mission_id, role, body, data, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, missionId, role, body.slice(0, 20000), data === undefined ? null : JSON.stringify(data), nowIso());
    return id;
  }

  private patch(id: string, p: Partial<Record<keyof MissionRow, string | number | null>>): void {
    const keys = Object.keys(p);
    if (!keys.length) return;
    this.rt.db.run(`UPDATE missions SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => p[k as keyof MissionRow] ?? null), nowIso(), id);
  }

  private patchStep(id: string, p: Partial<Record<keyof StepRow, string | number | null>>): void {
    const keys = Object.keys(p);
    this.rt.db.run(`UPDATE mission_steps SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`, ...keys.map((k) => p[k as keyof StepRow] ?? null), nowIso(), id);
  }

  private emitMission(id: string): void {
    const r = this.rt.db.get<{ status: string; phase: string }>('SELECT status, phase FROM missions WHERE id = ?', id);
    if (r) this.rt.emit('mission.updated', { missionId: id, status: r.status, phase: r.phase });
  }

  private addLimitation(id: string, text: string): void {
    const m = this.row(id);
    const list = this.limitationsOf(m);
    if (list.includes(text)) return;
    list.push(text);
    this.patch(id, { limitations: JSON.stringify(list) });
    this.event(id, null, 'warn', 'mission.limitation', text);
  }

  /**
   * Explicit, validated status change (28.11). `phase` moves the cursor of the algorithm; `pending` sets or clears the
   * question the mission waits for.
   */
  private setStatus(id: string, to: MissionStatus, opts: { phase?: MissionPhase; reason?: string | null; error?: AppErrorJson | null; pending?: PendingApproval | null } = {}): void {
    const m = this.row(id);
    if (m.status !== to) assertTransition(m.status, to);
    const terminal = TERMINAL_STATUSES.includes(to);
    const p: Partial<Record<keyof MissionRow, string | number | null>> = { status: to };
    if (opts.phase) p.phase = opts.phase;
    if (opts.reason !== undefined) p.status_reason = opts.reason;
    if (opts.error !== undefined) p.error = opts.error ? JSON.stringify(opts.error) : null;
    if (opts.pending !== undefined) p.pending = opts.pending ? JSON.stringify(opts.pending) : null;
    if (terminal) p.finished_at = nowIso();
    else if (m.finished_at) p.finished_at = null;
    if (!m.started_at && WORKING_STATUSES.includes(to)) p.started_at = nowIso();
    this.patch(m.id, p);
    if (m.status !== to) this.event(m.id, null, terminal && to !== 'completed' ? 'warn' : 'info', 'mission.status', `Статус: ${MISSION_STATUS_LABELS[to]}${opts.reason ? ` — ${opts.reason}` : ''}`, { from: m.status, to });
    this.emitMission(m.id);
  }

  /**
   * Moves the driver to the next phase. If the user intervened meanwhile (pause, cancel), only the cursor moves:
   * the user's decision is never overwritten by a background step that happened to finish.
   */
  private moveTo(id: string, phase: MissionPhase, reason: string | null = null): boolean {
    const m = this.row(id);
    if (!WORKING_STATUSES.includes(m.status)) {
      this.patch(id, { phase });
      return false;
    }
    this.setStatus(id, phase === 'done' ? 'completed' : statusForPhase(phase), { phase, reason });
    this.event(id, null, 'info', 'mission.phase', `Этап: ${PHASE_LABELS[phase]}`, { phase });
    return true;
  }

  private ask(id: string, kind: ApprovalKind, title: string, message: string, data: Record<string, unknown>, resumePhase: MissionPhase, status: 'awaiting_approval' | 'needs_input' = 'awaiting_approval'): void {
    const p: PendingApproval = { id: newId('ask'), kind, title, message, data, resumePhase, createdAt: nowIso() };
    const m = this.row(id);
    if (!WORKING_STATUSES.includes(m.status) && m.status !== 'awaiting_approval' && m.status !== 'needs_input') {
      // paused/cancelled meanwhile: keep the question for when the user continues
      this.patch(id, { pending: JSON.stringify(p) });
      return;
    }
    this.setStatus(id, status, { pending: p, reason: title });
    this.message(id, 'system', `${title}. ${message}`, { kind: 'pending', pendingId: p.id, approval: kind });
    this.event(id, null, 'info', 'mission.pending', title, { kind, pendingId: p.id });
  }

  // ============================================================================================ create & list

  private nextKey(): string {
    const last = this.rt.db.get<{ n: number }>("SELECT MAX(CAST(SUBSTR(key, 3) AS INTEGER)) AS n FROM missions WHERE key LIKE 'M-%'")?.n ?? 0;
    return `M-${String(last + 1).padStart(3, '0')}`;
  }

  private normalizeScope(input: Partial<MissionScope> | undefined): MissionScope {
    const sourceIds = uniq((input?.sourceIds ?? []).map(String));
    const docIds = uniq((input?.docIds ?? []).map(String));
    const systemIds = uniq((input?.systemIds ?? []).map(String)).filter((s) => s !== this.rt.systemId);
    const allowWeb = input?.allowWeb === true;
    const kind = input?.kind ?? (systemIds.length ? 'systems' : sourceIds.length ? 'projects' : 'system');
    if (!['system', 'projects', 'systems', 'public'].includes(kind)) throw new AppError('VALIDATION_FAILED', 'Область поручения: system, projects, systems или public.');
    for (const id of sourceIds) if (!this.rt.db.get('SELECT id FROM sources WHERE id = ?', id)) throw new AppError('NOT_FOUND', `Источник ${id} не найден в этой системе.`);
    for (const id of docIds) if (!this.rt.db.get('SELECT id FROM documents WHERE id = ?', id)) throw new AppError('NOT_FOUND', `Документ ${id} не найден в этой системе.`);
    for (const id of systemIds) {
      try {
        this.deps.systems.get(id);
      } catch {
        throw new AppError('NOT_FOUND', `Система ${id} не зарегистрирована.`);
      }
    }
    if (kind === 'public' && !allowWeb) throw new AppError('VALIDATION_FAILED', 'Область «только общедоступные источники» требует разрешить веб-доступ.');
    if (kind === 'public' && (sourceIds.length || docIds.length || systemIds.length)) throw new AppError('VALIDATION_FAILED', 'Область «только общедоступные источники» не может включать локальные проекты, документы или системы.');
    if (kind === 'systems' && !systemIds.length) throw new AppError('VALIDATION_FAILED', 'Выберите хотя бы одну дополнительную систему.');
    return { kind, sourceIds, docIds, systemIds, allowWeb };
  }

  private normalizeAttachments(list: MissionAttachment[] | undefined): MissionAttachment[] {
    const out: MissionAttachment[] = [];
    for (const a of list ?? []) {
      if (!a || !['document', 'project', 'url', 'text', 'file'].includes(a.kind)) throw new AppError('VALIDATION_FAILED', 'Вложение: document, project, url, text или file.');
      const title = String(a.title ?? a.ref ?? '').slice(0, 300) || a.kind;
      if (a.kind === 'document' && !this.rt.db.get('SELECT id FROM documents WHERE id = ?', a.ref)) throw new AppError('NOT_FOUND', `Документ ${a.ref} не найден.`);
      if (a.kind === 'project' && !this.rt.db.get("SELECT id FROM sources WHERE id = ? AND kind = 'project'", a.ref)) throw new AppError('NOT_FOUND', `Проект ${a.ref} не найден.`);
      if (a.kind === 'url' && !/^https?:\/\//i.test(String(a.ref))) throw new AppError('VALIDATION_FAILED', 'Ссылка должна начинаться с http:// или https://.');
      if ((a.kind === 'text' || a.kind === 'file') && typeof a.text !== 'string') throw new AppError('VALIDATION_FAILED', 'Для текстового вложения нужен текст.');
      out.push({ kind: a.kind, ref: String(a.ref ?? '').slice(0, 2000), title, ...(a.text !== undefined ? { text: String(a.text).slice(0, MAX_ATTACHMENT_CHARS) } : {}) });
    }
    if (out.length > 20) throw new AppError('VALIDATION_FAILED', 'Не больше 20 вложений.');
    return out;
  }

  private normalizePolicy(p: Partial<MissionPolicy> | undefined): MissionPolicy {
    const out: MissionPolicy = { ...DEFAULT_POLICY, ...(p ?? {}) };
    if (!['always', 'risky', 'never'].includes(out.approvePlan)) throw new AppError('VALIDATION_FAILED', 'Подтверждение плана: always, risky или never.');
    if (!['auto', 'always', 'never'].includes(out.saveReport)) throw new AppError('VALIDATION_FAILED', 'Сохранение отчёта: auto, always или never.');
    if (!Number.isInteger(out.maxFixRounds) || out.maxFixRounds < 0 || out.maxFixRounds > 5) throw new AppError('VALIDATION_FAILED', 'Циклов исправления: от 0 до 5.');
    out.deniedTools = uniq((out.deniedTools ?? []).map(String));
    for (const t of out.deniedTools) if (!KNOWN_TOOLS.has(t)) throw new AppError('VALIDATION_FAILED', `Неизвестный инструмент: ${t}`);
    out.preapprovedChecks = (out.preapprovedChecks ?? []).map((c) => ({ sourceId: String(c.sourceId), name: String(c.name) }));
    for (const c of out.preapprovedChecks) {
      if (!projectChecks(this.rt, c.sourceId).some((d) => d.name === c.name)) throw new AppError('CHECK_NOT_DEFINED', `Проверка «${c.name}» не задана для проекта ${c.sourceId}.`);
    }
    return out;
  }

  private normalizeLimits(l: Partial<MissionLimits> | undefined, base: MissionLimits = DEFAULT_MISSION_LIMITS): MissionLimits {
    const out: MissionLimits = { ...base, ...(l ?? {}) };
    for (const k of ['maxModelCalls', 'maxTokens', 'maxCostUsd'] as const) {
      const v = out[k];
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw new AppError('VALIDATION_FAILED', `Лимит ${k}: неотрицательное число или null.`);
    }
    if (!Number.isInteger(out.maxParallel) || out.maxParallel < 1 || out.maxParallel > 6) throw new AppError('VALIDATION_FAILED', 'Параллельных этапов: от 1 до 6.');
    if (!Number.isInteger(out.stepTimeoutMs) || out.stepTimeoutMs < 5_000 || out.stepTimeoutMs > 3_600_000) throw new AppError('VALIDATION_FAILED', 'Тайм-аут этапа: от 5 секунд до 1 часа.');
    return out;
  }

  /** «Поставить задачу»: the request is stored verbatim, separately from the structured model built later (28.10). */
  async create(input: CreateMissionInput): Promise<MissionView> {
    if (this.stopped) throw new AppError('SYSTEM_UNAVAILABLE', 'Система закрывается.');
    const request = String(input.request ?? '').trim();
    if (request.length < 3) throw new AppError('VALIDATION_FAILED', 'Опишите задачу (хотя бы несколько слов).');
    if (request.length > 20_000) throw new AppError('VALIDATION_FAILED', 'Текст задачи длиннее 20 000 символов — приложите материалы вложениями.');
    const mode = input.mode ?? 'execute';
    if (mode !== 'plan' && mode !== 'execute') throw new AppError('VALIDATION_FAILED', 'Режим: plan («Исследовать и спланировать») или execute («Выполнить задачу»).');
    const priority = input.priority ?? 'medium';
    if (!['critical', 'high', 'medium', 'low'].includes(priority)) throw new AppError('VALIDATION_FAILED', 'Приоритет: critical, high, medium или low.');
    const attachments = this.normalizeAttachments(input.attachments);
    const scope = this.normalizeScope(input.scope);
    // a project attached by the user belongs to the scope of the mission
    for (const a of attachments) if (a.kind === 'project' && scope.kind !== 'public' && !scope.sourceIds.includes(a.ref) && scope.sourceIds.length) scope.sourceIds.push(a.ref);
    const policy = this.normalizePolicy(input.policy);
    const limits = this.normalizeLimits(input.limits);
    const id = newId('mis');
    const now = nowIso();
    const title = (input.title ?? '').trim().slice(0, 300) || clip(request.split('\n')[0]!.trim(), 120);
    let key = this.nextKey();
    for (let i = 0; ; i++) {
      try {
        this.rt.db.run(
          "INSERT INTO missions(id, key, title, original_request, attachments, mode, status, phase, priority, scope, policy, limits, approved_checks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', 'analysis', ?, ?, ?, ?, ?, ?, ?)",
          id,
          key,
          title,
          request,
          JSON.stringify(attachments),
          mode,
          priority,
          JSON.stringify(scope),
          JSON.stringify(policy),
          JSON.stringify(limits),
          JSON.stringify(policy.preapprovedChecks),
          now,
          now,
        );
        break;
      } catch (e) {
        if (i > 5) throw e;
        key = `M-${String(Number(key.slice(2)) + 1).padStart(3, '0')}`;
      }
    }
    const actor = input.actor ?? 'user';
    this.rt.audit.record({ actor, action: 'mission.create', target: key, details: { missionId: id, mode, scope: { kind: scope.kind, projects: scope.sourceIds.length, docs: scope.docIds.length, systems: scope.systemIds.length, web: scope.allowWeb } } });
    if ((input.title ?? '').trim()) this.rt.audit.record({ actor, action: 'mission.title', target: key });
    this.message(id, 'user', request, { kind: 'request' });
    this.event(id, null, 'info', 'mission.created', `Поручение ${key} поставлено (${mode === 'plan' ? 'исследовать и спланировать' : 'выполнить задачу'}; область: ${this.scopeLabel(scope)})`);
    if (input.start !== false) {
      this.setStatus(id, 'analyzing', { phase: 'analysis' });
      this.kick(id);
    }
    return this.get(id);
  }

  /** Starts a draft mission. */
  launch(id: string, actor = 'user'): MissionView {
    const m = this.row(id);
    if (m.status !== 'draft') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение уже запущено.');
    this.setStatus(m.id, 'analyzing', { phase: 'analysis' });
    this.rt.audit.record({ actor, action: 'mission.start', target: m.key });
    this.kick(m.id);
    return this.get(m.id);
  }

  private scopeLabel(s: MissionScope): string {
    switch (s.kind) {
      case 'public':
        return 'только общедоступные источники';
      case 'systems':
        return `текущая система и ещё ${s.systemIds.length}`;
      case 'projects':
        return `выбранные проекты (${s.sourceIds.length})`;
      default:
        return 'текущая система';
    }
  }

  list(f: { status?: MissionStatus[]; limit?: number; offset?: number; q?: string } = {}): { items: Pick<MissionView, 'id' | 'key' | 'title' | 'mode' | 'status' | 'statusLabel' | 'phase' | 'phaseLabel' | 'priority' | 'statusReason' | 'createdAt' | 'updatedAt' | 'completedAt'>[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => '?').join(',')})`);
      params.push(...f.status);
    }
    if (f.q) {
      where.push('(title LIKE ? OR original_request LIKE ? OR key = ?)');
      params.push(`%${f.q}%`, `%${f.q}%`, f.q);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.rt.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM missions ${w}`, ...params)!.c;
    const rows = this.rt.db.all<MissionRow>(`SELECT * FROM missions ${w} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, Math.min(f.limit ?? 50, 500), f.offset ?? 0);
    return {
      total,
      items: rows.map((m) => ({ id: m.id, key: m.key, title: m.title, mode: m.mode, status: m.status, statusLabel: MISSION_STATUS_LABELS[m.status], phase: m.phase, phaseLabel: PHASE_LABELS[m.phase], priority: m.priority, statusReason: m.status_reason, createdAt: m.created_at, updatedAt: m.updated_at, completedAt: m.finished_at })),
    };
  }

  // ============================================================================================ view

  private stepView(s: StepRow, full: boolean): MissionStepView {
    return {
      id: s.id,
      seq: s.seq,
      phase: s.phase,
      planStep: s.plan_step,
      role: s.role,
      agentId: s.agent_id,
      title: s.title,
      status: s.status,
      dependsOn: parseJson<string[]>(s.depends_on, []),
      ...(full ? { input: parseJson(s.input, null), output: parseJson(s.output, null) } : {}),
      error: parseJson(s.error, null),
      attempts: s.attempts,
      sideEffects: parseJson<SideEffect[]>(s.side_effects, []),
      startedAt: s.started_at,
      finishedAt: s.finished_at,
    };
  }

  private checkRecords(missionId: string): CheckRecord[] {
    return this.rt.db
      .all<{ id: string; round: number; kind: CheckRecord['kind']; name: string; source_id: string | null; status: string; exit_code: number | null; duration_ms: number | null; output: string | null; evidence: string | null; created_at: string; step_id: string | null }>('SELECT * FROM mission_checks WHERE mission_id = ? ORDER BY created_at, rowid', missionId)
      .map((c) => ({ id: c.id, round: c.round, kind: c.kind, name: c.name, sourceId: c.source_id, status: c.status, exitCode: c.exit_code, durationMs: c.duration_ms, output: c.output, evidence: { ...(parseJson<Record<string, unknown>>(c.evidence, {}) ?? {}), stepId: c.step_id }, createdAt: c.created_at }));
  }

  private missionSets(missionId: string): ChangeSetView[] {
    return this.deps.changes.list({ missionId, limit: 50 });
  }

  /** The open (not yet applied) change set of the mission — one cumulative set (changeGroup mission:<id>). */
  private openSet(missionId: string): ChangeSetView | null {
    const sets = this.missionSets(missionId).filter((s) => s.status === 'proposed' && s.summary.files > 0);
    return sets[0] ?? null;
  }

  private artifacts(m: MissionRow): Artifact[] {
    const out: Artifact[] = [];
    const seen = new Set<string>();
    for (const s of this.stepRows(m.id)) {
      for (const se of parseJson<SideEffect[]>(s.side_effects, [])) {
        const key = `${se.tool}|${se.ref ?? se.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if ((se.tool === 'create_document' || se.tool === 'documenter.save') && se.ref) {
          const d = this.rt.db.get<{ title: string; rel_path: string }>('SELECT title, rel_path FROM documents WHERE id = ?', se.ref);
          out.push({ type: 'document', ref: se.ref, title: d?.title ?? se.title ?? se.target, status: d ? 'created' : 'missing', systemId: this.rt.systemId, ...(d ? { path: d.rel_path } : {}) });
        } else if (se.tool === 'create_agent_definition') {
          out.push({ type: 'agent_draft', ref: se.ref ?? se.target, title: se.title ?? se.target, status: 'draft', systemId: this.rt.systemId });
        } else if (se.tool === 'create_workflow_definition') {
          out.push({ type: 'workflow_draft', ref: se.ref ?? se.target, title: se.title ?? se.target, status: 'draft', systemId: this.rt.systemId });
        }
      }
    }
    for (const cs of this.missionSets(m.id)) if (cs.summary.files > 0 || cs.status !== 'proposed') out.push({ type: 'change_set', ref: cs.id, title: cs.title, status: cs.status, systemId: this.rt.systemId });
    if (m.report_doc_id) {
      const d = this.rt.db.get<{ title: string; rel_path: string }>('SELECT title, rel_path FROM documents WHERE id = ?', m.report_doc_id);
      out.push({ type: 'report', ref: m.report_doc_id, title: d?.title ?? 'Отчёт', status: d ? 'created' : 'missing', systemId: this.rt.systemId, ...(d ? { path: d.rel_path } : {}) });
    }
    return out;
  }

  /** All evidence gathered by the mission (context phase and research steps), with verification flags. */
  private allEvidence(m: MissionRow): { evidence: GroundedEvidence[]; claims: GroundedClaim[] } {
    const ctx = this.contextOf(m);
    const res = this.researchOf(m);
    const evidence: GroundedEvidence[] = [...(ctx.local?.evidence ?? [])];
    const claims: GroundedClaim[] = [...res.claims];
    for (const s of this.stepRows(m.id)) {
      if (s.status !== 'completed' || s.phase === 'context' || s.phase === 'research') continue;
      const o = parseJson<Record<string, unknown>>(s.output, {});
      if (s.role === 'researcher') evidence.push(...((o.evidence as GroundedEvidence[] | undefined) ?? []).filter((e) => 'verified' in e));
      if (s.role === 'web-researcher') claims.push(...((o.claims as GroundedClaim[] | undefined) ?? []).filter((c) => 'quote_status' in c));
    }
    return { evidence, claims };
  }

  private sourceReferences(m: MissionRow): MissionView['sourceReferences'] {
    const ctx = this.contextOf(m);
    const { evidence, claims } = this.allEvidence(m);
    const out: MissionView['sourceReferences'] = [];
    const seen = new Set<string>();
    const add = (r: MissionView['sourceReferences'][number]) => {
      const k = `${r.systemId}|${r.kind}|${r.ref}`;
      if (seen.has(k)) {
        if (r.verified) {
          const prev = out.find((x) => `${x.systemId}|${x.kind}|${x.ref}` === k);
          if (prev) prev.verified = true;
        }
        return;
      }
      seen.add(k);
      out.push(r);
    };
    for (const e of evidence) add({ kind: e.source.type, ref: e.source.ref, title: e.source.title, systemId: e.systemId ?? this.rt.systemId, verified: e.verified });
    for (const h of ctx.crossSystem) add({ kind: 'document', ref: h.docId, title: `${h.title} (${h.systemName})`, systemId: h.systemId, verified: null });
    for (const f of ctx.explorer?.relevant_files ?? []) add({ kind: 'project_file', ref: `${f.source_id}:${f.path}`, title: f.path, systemId: this.rt.systemId, verified: null });
    for (const c of claims) add({ kind: 'web', ref: c.source_url, title: clip(c.statement, 160), systemId: this.rt.systemId, verified: c.quote_status === 'verified' });
    return out;
  }

  /** Phases this mission actually goes through (adaptive: not every task needs every stage). */
  private plannedPhases(m: MissionRow): MissionPhase[] {
    const n = this.normalizedOf(m);
    const out: MissionPhase[] = ['analysis'];
    if (!n) return [...out, 'planning', ...(m.mode === 'execute' ? (['execution', 'verification'] as MissionPhase[]) : []), 'summary'];
    if (this.needsContext(m, n)) out.push('context');
    if (this.needsWeb(m, n)) out.push('research');
    if (this.needsStrategy(n)) out.push('strategy');
    out.push('planning');
    if (m.mode === 'execute') {
      out.push('execution', 'verification');
      if (m.fix_rounds > 0) out.push('fix');
      if (this.needsReview(n)) out.push('review');
    }
    out.push('summary');
    return out;
  }

  get(id: string, opts: { full?: boolean } = {}): MissionView {
    const m = this.row(id);
    const steps = this.stepRows(m.id);
    const phases = this.plannedPhases(m);
    const curIdx = m.phase === 'done' || TERMINAL_STATUSES.includes(m.status) ? phases.length : phases.indexOf(m.phase);
    const n = this.normalizedOf(m);
    const execSteps = this.currentExecSteps(m.id);
    const pendingApproval = this.pendingOf(m);
    return {
      id: m.id,
      key: m.key,
      title: m.title,
      originalRequest: m.original_request,
      attachments: parseJson(m.attachments, []),
      normalized: n,
      revision: m.revision,
      systemId: this.rt.systemId,
      mode: m.mode,
      status: m.status,
      statusLabel: MISSION_STATUS_LABELS[m.status],
      statusReason: m.status_reason,
      phase: m.phase,
      phaseLabel: PHASE_LABELS[m.phase],
      priority: m.priority,
      scope: this.scopeOf(m),
      policy: this.policyOf(m),
      limits: this.limitsOf(m),
      assumptions: n?.assumptions ?? [],
      constraints: n?.constraints ?? [],
      extraRequirements: this.extrasOf(m),
      criteria: this.criteriaOf(m),
      context: parseJson(m.context, null),
      research: parseJson(m.research, null),
      options: parseJson<SolutionOption[]>(m.options, []),
      strategy: parseJson<Strategy | null>(m.strategy, null),
      plan: this.planOf(m),
      planStale: m.plan_stale > 0,
      steps: steps.map((s) => this.stepView(s, !!opts.full)),
      pending: pendingApproval,
      checks: this.checkRecords(m.id),
      approvedChecks: this.approvedChecksOf(m).map((c) => ({ sourceId: c.sourceId, name: c.name })),
      artifacts: this.artifacts(m),
      sourceReferences: this.sourceReferences(m),
      limitations: this.limitationsOf(m),
      fixRounds: m.fix_rounds,
      review: parseJson(m.review, null),
      summary: parseJson<MissionSummary | null>(m.summary, null),
      reportDocId: m.report_doc_id,
      totals: parseJson(m.totals, {}),
      error: parseJson(m.error, null),
      progress: {
        phases: phases.map((p, i) => ({ phase: p, label: PHASE_LABELS[p], state: i < curIdx ? 'done' : i === curIdx ? 'current' : 'pending' })),
        steps: { done: execSteps.filter((s) => s.status === 'completed' || s.status === 'skipped').length, total: execSteps.length },
      },
      createdAt: m.created_at,
      startedAt: m.started_at,
      updatedAt: m.updated_at,
      completedAt: m.finished_at,
    };
  }

  // ============================================================================================ driver

  private activate(id: string): Active {
    let a = this.active.get(id);
    if (a && !a.controller.signal.aborted) return a;
    const m = this.row(id);
    const limits = this.limitsOf(m);
    const budget = new RunBudget({ maxModelCalls: limits.maxModelCalls, maxTokens: limits.maxTokens, maxCostUsd: limits.maxCostUsd }, parseJson<Partial<RunTotals>>(m.totals, {}), (t) => {
      this.rt.db.run('UPDATE missions SET totals = ?, updated_at = ? WHERE id = ?', JSON.stringify(t), nowIso(), id);
    });
    a = { controller: new AbortController(), abortReason: null, budget, scope: this.runScope(m), driving: null, again: false };
    this.active.set(id, a);
    return a;
  }

  /** Run scope of the agents of this mission — chosen by the user (scope, policy), never by an agent (29.1). */
  private runScope(m: MissionRow): RunScope {
    const scope = this.scopeOf(m);
    const policy = this.policyOf(m);
    const denied = [...policy.deniedTools];
    if (scope.kind === 'public') denied.push(...LOCAL_TOOLS); // 28.14: public sources only, no local data
    if (!scope.allowWeb) denied.push(...WEB_TOOLS);
    return {
      sourceIds: scope.kind === 'system' ? [] : scope.kind === 'public' ? [] : scope.sourceIds,
      docIds: scope.docIds,
      extraSystems: scope.kind === 'systems' ? scope.systemIds : [],
      allowWeb: scope.allowWeb,
      outputFolder: MISSION_FOLDER,
      deniedTools: uniq(denied),
      missionId: m.id,
      approvedChecks: this.approvedChecksOf(m),
      changeGroup: `mission:${m.id}`,
    };
  }

  private kick(id: string): void {
    if (this.stopped) return;
    const a = this.activate(id);
    if (a.driving) {
      a.again = true;
      return;
    }
    a.again = false;
    a.driving = this.drive(id, a).finally(() => {
      a.driving = null;
      if (a.again && !this.stopped && !a.controller.signal.aborted) this.kick(id);
    });
  }

  private async drive(id: string, a: Active): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (a.controller.signal.aborted || this.stopped) return;
      let m: MissionRow;
      try {
        m = this.row(id);
      } catch {
        return;
      }
      if (!WORKING_STATUSES.includes(m.status)) return;
      let next: 'continue' | 'wait';
      try {
        next = await this.advance(m, a);
      } catch (e) {
        if (a.controller.signal.aborted) return;
        this.phaseFailed(id, e);
        return;
      }
      if (next === 'wait') return;
    }
    this.ask(id, 'error', 'Движок остановился', 'Слишком много переходов без результата — это похоже на внутреннюю ошибку. Состояние и результаты сохранены.', { phase: this.row(id).phase }, this.row(id).phase, 'needs_input');
  }

  private phaseFailed(id: string, e: unknown): void {
    const err = toAppError(e);
    this.rt.audit.recordError(err, `mission ${id}`);
    const m = this.row(id);
    this.event(id, null, 'error', 'mission.error', err.message, { code: err.code, hint: err.hint });
    this.patch(id, { error: JSON.stringify(err.toJSON()) });
    this.askForError(m, err, null);
  }

  /** User-fixable problems pause the mission with a precise question; nothing is reported as done. */
  private askForError(m: MissionRow, err: AppError, stepId: string | null): void {
    const base = { code: err.code, message: err.message, hint: err.hint ?? ERROR_CATALOG[err.code]?.hint ?? null, stepId, phase: m.phase };
    if (err.code === 'BUDGET_EXCEEDED') this.ask(m.id, 'budget', 'Достигнут лимит поручения', `${err.message} Увеличьте лимит и нажмите «Повторить», или завершите поручение с частичным результатом.`, { ...base, totals: parseJson(this.row(m.id).totals, {}), limits: this.limitsOf(m) }, m.phase, 'needs_input');
    else if (err.code === 'AGENT_NOT_ENABLED') this.ask(m.id, 'setup_agents', 'Нужны агенты поручений', `${err.message} Установите и включите агентов поручений (явное действие пользователя).`, { ...base, agents: this.missingAgents() }, m.phase, 'needs_input');
    else if (['NO_MODEL_CONFIGURED', 'MODEL_UNAVAILABLE', 'PROVIDER_UNREACHABLE', 'PROVIDER_AUTH_FAILED', 'PROVIDER_RATE_LIMITED', 'OFFLINE_MODE', 'NETWORK_POLICY_DENIED', 'POLICY_CONFIDENTIAL_SOURCE'].includes(err.code)) {
      this.ask(m.id, 'model', 'Модель недоступна', `${err.message} ${base.hint ?? ''} Локальная модель не требует внешнего ключа; облачный провайдер можно подключить по желанию. Автоматического переключения на облако нет.`.trim(), base, m.phase, 'needs_input');
    } else this.ask(m.id, 'error', 'Этап не выполнен', `${err.message}${base.hint ? ` ${base.hint}` : ''} Можно повторить этап или пропустить его (результат будет помечен как частичный).`, base, m.phase, 'needs_input');
  }

  private missingAgents(): { id: string; installed: boolean; enabled: boolean }[] {
    const rows = new Map(this.rt.db.all<{ id: string; enabled: number }>('SELECT id, enabled FROM agents').map((r) => [r.id, r]));
    return MISSION_AGENTS.map((id) => ({ id, installed: rows.has(id), enabled: !!rows.get(id)?.enabled })).filter((x) => !x.enabled);
  }

  private async advance(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    // a change of requirements / strategy / option during work: re-plan at a safe boundary (28.13)
    if (m.plan_stale && ['execution', 'verification', 'fix', 'review', 'summary'].includes(m.phase) && m.plan) {
      this.moveTo(m.id, m.plan_stale === 2 ? 'strategy' : 'planning', 'план пересчитывается после изменения требований');
      return 'continue';
    }
    if (m.phase !== 'analysis' && !m.normalized) {
      this.moveTo(m.id, 'analysis');
      return 'continue';
    }
    switch (m.phase) {
      case 'analysis':
        return this.phaseAnalysis(m, a);
      case 'context':
        return this.phaseContext(m, a);
      case 'research':
        return this.phaseResearch(m, a);
      case 'strategy':
        return this.phaseStrategy(m, a);
      case 'planning':
        return this.phasePlanning(m, a);
      case 'execution':
        return this.phaseExecution(m, a);
      case 'verification':
        return this.phaseVerification(m, a);
      case 'fix':
        return this.phaseFix(m, a);
      case 'review':
        return this.phaseReview(m, a);
      case 'summary':
        return this.phaseSummary(m);
      default:
        return 'wait';
    }
  }

  // ============================================================================================ adaptive routing

  private needsContext(m: MissionRow, n: NormalizedTask): boolean {
    const scope = this.scopeOf(m);
    if (scope.kind === 'public') return false;
    const attachedDocs = parseJson<MissionAttachment[]>(m.attachments, []).some((x) => x.kind === 'document');
    const projectWork = n.needs.project_exploration || ['implementation', 'bugfix', 'improvement'].includes(n.task_type);
    return (projectWork && this.projectsOf(m).length > 0) || n.needs.local_research || scope.docIds.length > 0 || attachedDocs || scope.kind === 'systems';
  }

  private needsWeb(m: MissionRow, n: NormalizedTask): boolean {
    const scope = this.scopeOf(m);
    return n.needs.web_research || scope.kind === 'public' || parseJson<MissionAttachment[]>(m.attachments, []).some((x) => x.kind === 'url');
  }

  private needsStrategy(n: NormalizedTask): boolean {
    return n.needs.alternatives || n.complexity === 'complex' || n.task_type === 'design';
  }

  private needsReview(n: NormalizedTask): boolean {
    return n.needs.independent_review || n.complexity === 'complex';
  }

  private nextPhase(m: MissionRow, after: MissionPhase): MissionPhase {
    const n = this.normalizedOf(m);
    const order: MissionPhase[] = ['analysis', 'context', 'research', 'strategy', 'planning', 'execution', 'verification', 'review', 'summary'];
    let i = order.indexOf(after) + 1;
    for (; i < order.length; i++) {
      const p = order[i]!;
      if (!n) return p;
      if (p === 'context' && !this.needsContext(m, n)) continue;
      if (p === 'research' && !this.needsWeb(m, n)) continue;
      if (p === 'strategy' && !this.needsStrategy(n)) continue;
      if ((p === 'execution' || p === 'verification' || p === 'review') && m.mode === 'plan') continue;
      if (p === 'review' && !this.needsReview(n)) continue;
      return p;
    }
    return 'summary';
  }

  private goNext(id: string, after: MissionPhase): 'continue' | 'wait' {
    const m = this.row(id);
    return this.moveTo(id, this.nextPhase(m, after)) ? 'continue' : 'wait';
  }

  // ============================================================================================ agent execution

  /** Other local models that can take over a step (28.15). Cloud models are never used as a fallback. */
  private async localAlternatives(current: { providerId: string; model: string } | null): Promise<{ providerId: string; model: string }[]> {
    const ai = appAI(this.rt.app).ai;
    const out: { providerId: string; model: string }[] = [];
    for (const cfg of ai.providers.configs()) {
      if (!cfg.enabled || cfg.locality !== 'local') continue;
      let models: { id: string; capabilities: { chat: boolean } }[] = [];
      try {
        models = (await ai.providers.models(cfg.id)).models;
      } catch {
        models = [];
      }
      for (const mm of models) {
        if (!mm.capabilities.chat) continue;
        if (current && current.providerId === cfg.id && current.model === mm.id) continue;
        out.push({ providerId: cfg.id, model: mm.id });
      }
    }
    return out.slice(0, 2);
  }

  private stepKey(m: MissionRow, c: AgentCall): string {
    return `${m.id}:${c.phase}:${c.role}:${c.planStep ?? '-'}:r${m.revision}:f${m.fix_rounds}:${c.variant ?? ''}`;
  }

  private newStep(m: MissionRow, c: { phase: MissionPhase; role: string; agentId: string | null; title: string; planStep?: string | null; dependsOn?: string[]; key: string | null; input?: unknown }): string {
    const id = newId('mst');
    const seq = (this.rt.db.get<{ n: number | null }>('SELECT MAX(seq) AS n FROM mission_steps WHERE mission_id = ?', m.id)?.n ?? 0) + 1;
    this.rt.db.run(
      "INSERT INTO mission_steps(id, mission_id, seq, phase, plan_step, role, agent_id, title, status, depends_on, input, idempotency_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)",
      id,
      m.id,
      seq,
      c.phase,
      c.planStep ?? null,
      c.role,
      c.agentId,
      c.title.slice(0, 300),
      JSON.stringify(c.dependsOn ?? []),
      c.input === undefined ? null : JSON.stringify(c.input),
      c.key,
      nowIso(),
    );
    return id;
  }

  /**
   * Runs one agent as a recorded step. A step that already completed under the same idempotency key is reused (recovery
   * and re-entry never repeat finished work). Model problems fall back to another LOCAL model; user-fixable errors move
   * the mission to «Требуется вмешательство» with a concrete question.
   */
  private async runAgent(m: MissionRow, a: Active, c: AgentCall): Promise<AgentOutcome> {
    let stepId: string;
    if (c.rowId) stepId = c.rowId;
    else {
      const key = this.stepKey(m, c);
      const existing = this.rt.db.get<StepRow>('SELECT * FROM mission_steps WHERE idempotency_key = ?', key);
      if (existing?.status === 'completed') {
        this.event(m.id, existing.id, 'debug', 'step.reused', `«${existing.title}»: используется сохранённый результат`);
        return { ok: true, output: parseJson(existing.output, {}), stepId: existing.id, toolCalls: [] };
      }
      stepId = existing?.id ?? this.newStep(m, { phase: c.phase, role: c.role, agentId: c.agentId, title: c.title, planStep: c.planStep ?? null, dependsOn: c.dependsOn ?? [], key });
    }
    const prev = this.stepRow(stepId);
    this.patchStep(stepId, { status: 'running', attempts: prev.attempts + 1, started_at: nowIso(), finished_at: null, error: null, input: JSON.stringify(c.input ?? null), agent_id: c.agentId });
    this.event(m.id, stepId, 'info', 'step.start', `«${c.title}»: агент ${c.agentId}${prev.attempts ? ` (попытка ${prev.attempts + 1})` : ''}`);
    const limits = this.limitsOf(m);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), limits.stepTimeoutMs);
    const signal = AbortSignal.any([a.controller.signal, timeout.signal]);
    const confidential = this.scopeConfidential(m);
    const recordSideEffect = (se: SideEffect) => {
      const cur = parseJson<SideEffect[]>(this.stepRow(stepId).side_effects, []);
      cur.push(se);
      this.patchStep(stepId, { side_effects: JSON.stringify(cur.slice(-200)) });
    };
    try {
      let resolved: { pkg: Awaited<ReturnType<AgentService['forRun']>>['pkg']; config: AgentConfig };
      try {
        const r = await this.deps.agents.forRun(c.agentId);
        resolved = { pkg: r.pkg, config: r.config };
      } catch (e) {
        const err = toAppError(e);
        throw err.code === 'NOT_FOUND' ? new AppError('AGENT_NOT_ENABLED', `Агент «${c.agentId}» не установлен в этой системе.`, { details: { agentId: c.agentId } }) : err;
      }
      const ai = appAI(this.rt.app).ai;
      const preview = (): { providerId: string; model: string } | null => {
        try {
          const r = ai.preview({ rt: this.rt, policy: resolved.config.modelPolicy, taskType: resolved.pkg.manifest.model.taskType, containsConfidential: confidential, needsStructured: true });
          return { providerId: r.providerId, model: r.model };
        } catch {
          return null;
        }
      };
      let config = resolved.config;
      let alternatives: { providerId: string; model: string }[] | null = null;
      for (;;) {
        try {
          const res = await this.deps.agentRuntime.run(c.agentId, resolved.pkg, config, c.input, {
            runId: m.id,
            stepId,
            scope: a.scope,
            budget: a.budget,
            signal,
            containsConfidential: confidential,
            ...(c.note ? { note: c.note } : {}),
            ...(c.context?.length ? { context: c.context } : {}),
            onEvent: (e) => {
              this.event(m.id, stepId, e.type.includes('denied') || e.type.includes('error') || e.type.includes('injection') ? 'warn' : 'info', e.type, e.message, e.data);
              const d = (e.data ?? {}) as { tool?: string; input?: Record<string, unknown>; output?: Record<string, unknown> };
              if (e.type === 'tool.ok' && d.tool && SIDE_EFFECT_TOOLS.has(d.tool)) {
                const i = d.input ?? {};
                const o = d.output ?? {};
                recordSideEffect({
                  tool: d.tool,
                  target: String(i.path ?? i.title ?? i.id ?? i.name ?? d.tool),
                  ...(o.docId ? { ref: String(o.docId) } : o.changeSetId ? { ref: String(o.changeSetId) } : o.id ? { ref: `${String(o.id)}${o.version ? `@${String(o.version)}` : ''}` } : {}),
                  ...(i.title || i.name ? { title: String(i.title ?? i.name) } : {}),
                });
              }
            },
          });
          for (const w of res.warnings) this.event(m.id, stepId, 'warn', 'agent.warning', w);
          if (signal.aborted) throw timeout.signal.aborted && !a.controller.signal.aborted ? new AppError('TIMEOUT') : new AppError('CANCELLED');
          this.patchStep(stepId, { status: 'completed', output: JSON.stringify(res.output), finished_at: nowIso() });
          this.event(m.id, stepId, 'info', 'step.done', `«${c.title}»: готово (${res.route ? `${res.route.locality === 'local' ? 'локальная' : 'облачная'} модель ${res.route.model}` : 'модель'})`, { route: res.route, rounds: res.rounds, repairs: res.repairs, tools: res.toolCalls.map((t) => ({ tool: t.tool, ok: t.ok, error: t.error?.code ?? null })) });
          this.noteToolLimitations(m.id, res.toolCalls);
          return { ok: true, output: res.output, stepId, toolCalls: res.toolCalls };
        } catch (e) {
          const err = toAppError(e);
          if (signal.aborted || !FALLBACK_CODES.includes(err.code)) throw err;
          alternatives ??= await this.localAlternatives(preview());
          const alt = alternatives.shift();
          if (!alt) throw err;
          this.event(m.id, stepId, 'warn', 'model.fallback', `«${c.title}»: ${err.message} — пробую другую локальную модель ${alt.model}`, { code: err.code, to: alt });
          config = { ...config, modelPolicy: { mode: 'local', providerId: alt.providerId, model: alt.model, allowFallback: false } };
        }
      }
    } catch (e) {
      let err = toAppError(e);
      if (timeout.signal.aborted && !a.controller.signal.aborted) err = new AppError('TIMEOUT', `Этап «${c.title}» превысил тайм-аут ${Math.round(limits.stepTimeoutMs / 1000)} с.`);
      if (a.controller.signal.aborted) {
        if (a.abortReason === 'cancel') this.patchStep(stepId, { status: 'cancelled', finished_at: nowIso(), error: JSON.stringify(new AppError('CANCELLED', 'Поручение отменено.').toJSON()) });
        else this.interruptStep(this.stepRow(stepId), 'Прервано закрытием системы.');
        return { ok: false, stepId, error: err, fatal: true };
      }
      this.patchStep(stepId, { status: 'failed', error: JSON.stringify(err.toJSON()), finished_at: nowIso() });
      this.event(m.id, stepId, 'error', 'step.failed', `«${c.title}»: ${err.message}`, { code: err.code, hint: err.hint });
      if (USER_FIXABLE.includes(err.code)) {
        this.askForError(this.row(m.id), err, stepId);
        return { ok: false, stepId, error: err, fatal: true };
      }
      return { ok: false, stepId, error: err, fatal: false };
    } finally {
      clearTimeout(timer);
    }
  }

  /** An interrupted step: read-only work returns to «pending»; work with side effects is never repeated silently. */
  private interruptStep(s: StepRow, reason: string): void {
    const sideEffects = parseJson<SideEffect[]>(s.side_effects, []);
    if (SIDE_EFFECT_ROLES.has(s.role) || sideEffects.length) {
      this.patchStep(s.id, { status: 'failed', finished_at: nowIso(), error: JSON.stringify(new AppError('CANCELLED', `${reason} Этап мог частично выполнить действия (${sideEffects.length ? sideEffects.map((x) => `${x.tool}: ${x.target}`).join(', ') : 'изменения файлов, документы'}); автоматически он не повторяется — проверьте результаты и повторите вручную.`).toJSON()) });
    } else {
      this.patchStep(s.id, { status: 'pending', attempts: Math.max(0, s.attempts - 1), error: null });
    }
  }

  private noteToolLimitations(missionId: string, calls: ToolCallRecord[]): void {
    for (const t of calls) {
      if (t.ok || !t.error || !LIMITING_TOOL_ERRORS.has(t.error.code)) continue;
      this.addLimitation(missionId, `Инструмент ${t.tool} недоступен: ${t.error.message}`);
    }
  }

  private scopeConfidential(m: MissionRow): boolean {
    const scope = this.scopeOf(m);
    if (scope.kind === 'public') return false;
    const ids = scope.sourceIds.length ? [...scope.sourceIds, this.rt.primaryVaultId()] : this.rt.db.all<{ id: string }>('SELECT id FROM sources').map((r) => r.id);
    const docSources = scope.docIds.map((d) => this.rt.db.get<{ source_id: string }>('SELECT source_id FROM documents WHERE id = ?', d)?.source_id).filter((x): x is string => !!x);
    return [...ids, ...docSources].some((id) => !!this.rt.db.get<{ confidential: number }>('SELECT confidential FROM sources WHERE id = ?', id)?.confidential);
  }

  private requireAgents(m: MissionRow, ids: string[]): boolean {
    const enabled = this.enabledAgents();
    const missing = ids.filter((id) => !enabled.has(id));
    if (!missing.length) return true;
    this.ask(m.id, 'setup_agents', 'Нужны агенты поручений', `Для поручения нужны агенты: ${missing.join(', ')}. Установите и включите их (одно действие «Подготовить агентов»); без вашего решения агенты не устанавливаются.`, { agents: this.missingAgents(), required: missing }, m.phase, 'needs_input');
    return false;
  }

  // ============================================================================================ phases

  private answers(missionId: string): { question: string; answer: string }[] {
    return this.messages(missionId)
      .filter((x) => x.role === 'user' && (x.data as { kind?: string } | null)?.kind === 'answer')
      .map((x) => {
        const d = x.data as { question: string };
        return { question: d.question, answer: x.body };
      });
  }

  private feedback(missionId: string, target: string): string[] {
    return this.messages(missionId)
      .filter((x) => x.role === 'user' && (x.data as { kind?: string; target?: string } | null)?.kind === 'feedback' && (x.data as { target?: string }).target === target)
      .map((x) => x.body);
  }

  private attachmentsForAgent(m: MissionRow): { kind: string; ref: string; title: string; excerpt: string }[] {
    return parseJson<MissionAttachment[]>(m.attachments, []).map((a) => ({ kind: a.kind, ref: a.ref, title: a.title, excerpt: clip(a.text ?? '', 2000) }));
  }

  /** Stage 1: free text → internal structured task. Blocking unknowns become one concrete question (28.5). */
  private async phaseAnalysis(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    if (!this.requireAgents(m, CORE_AGENTS)) return 'wait';
    const scope = this.scopeOf(m);
    const answers = this.answers(m.id);
    const clarifications = this.feedback(m.id, 'analysis');
    const input = {
      request: m.original_request,
      attachments: this.attachmentsForAgent(m),
      scope: {
        kind: scope.kind,
        allowWeb: scope.allowWeb,
        systems: scope.systemIds.map((id) => {
          try {
            return { id, name: this.deps.systems.get(id).name };
          } catch {
            return { id, name: id };
          }
        }),
        projects: this.projectsOf(m).map((p) => ({ sourceId: p.sourceId, name: p.name, accessMode: modeLabel(p.accessMode) })),
      },
      answers: [...answers, ...clarifications.map((c) => ({ question: 'Уточнение пользователя', answer: c }))],
      mode: m.mode,
    };
    const res = await this.runAgent(m, a, { phase: 'analysis', role: 'mission-analyst', agentId: 'mission-analyst', title: 'Разбор запроса', input, variant: `q${answers.length}c${clarifications.length}` });
    if (!res.ok) {
      if (!res.fatal) this.askForError(this.row(m.id), res.error, res.stepId);
      return 'wait';
    }
    const out = res.output as unknown as NormalizedTask;
    const cur = this.row(m.id);
    const extras = this.extrasOf(cur);
    const normalized: NormalizedTask = {
      ...out,
      requirements: [...out.requirements.map((r) => ({ ...r, source: r.source ?? 'request' })), ...extras.filter((x) => x.kind === 'requirement').map((x) => ({ id: x.id, text: x.text, source: 'user' as const }))],
      constraints: [...out.constraints, ...extras.filter((x) => x.kind === 'constraint').map((x) => x.text)],
      assumptions: [...out.assumptions, ...out.questions.filter((q) => !q.blocking && q.default_assumption).map((q) => `${q.text} → принято: ${q.default_assumption}`)],
    };
    // criteria: analyst's + user's; a user decision on a criterion is kept
    const prev = this.criteriaOf(cur);
    const criteria: Criterion[] = out.acceptance_criteria.map((c) => {
      const p = prev.find((x) => x.id === c.id && x.text === c.text);
      return p ?? { id: c.id, text: c.text, verification: c.verification, status: 'pending', evidence: '', notes: '', decidedBy: null, source: 'analyst' };
    });
    for (const p of prev) if (p.source === 'user' && !criteria.some((c) => c.id === p.id)) criteria.push(p);
    const answered = (q: string) => answers.some((x) => x.question.trim().toLowerCase() === q.trim().toLowerCase() && x.answer.trim());
    const blocking = out.questions.filter((q) => q.blocking && !q.default_assumption && !answered(q.text));
    const rounds = this.rt.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM mission_steps WHERE mission_id = ? AND phase = 'analysis' AND status = 'completed'", m.id)!.c;
    const userTitle = this.rt.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM audit_log WHERE action IN ('mission.rename','mission.title') AND target = ?", cur.key)!.c > 0;
    this.patch(m.id, { normalized: JSON.stringify(normalized), criteria: JSON.stringify(criteria), ...(userTitle || !out.title ? {} : { title: clip(out.title, 300) }) });
    this.event(m.id, res.stepId, 'info', 'analysis.done', `Тип задачи: ${normalized.task_type}, сложность: ${normalized.complexity}. ${normalized.summary_for_user}`);
    if (blocking.length && rounds <= MAX_QUESTION_ROUNDS) {
      this.ask(m.id, 'questions', 'Нужно уточнение', blocking.length === 1 ? blocking[0]!.text : `Без ответа на эти вопросы продолжить нельзя (${blocking.length}).`, { questions: blocking.map((q) => ({ text: q.text, blocking: true })), summary: normalized.summary_for_user }, 'analysis', 'needs_input');
      return 'wait';
    }
    if (blocking.length) {
      for (const q of blocking) this.addLimitation(m.id, `Вопрос остался без ответа: «${q.text}» — работа продолжена с допущениями.`);
    }
    if (m.mode === 'execute' && normalized.needs.implementation && this.projectsOf(cur).length && this.projectsOf(cur).every((p) => !modeAtLeast(p.accessMode, 'prepare'))) {
      this.addLimitation(m.id, `Проекты поручения в режиме «${modeLabel('read_only')}»: изменения файлов не будут подготовлены. Режим меняет только пользователь в настройках проекта.`);
    }
    return this.goNext(m.id, 'analysis');
  }

  /** Stage 2: relevant sources only — projects, documents, other selected systems (with provenance). */
  private async phaseContext(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    const n = this.normalizedOf(m)!;
    const scope = this.scopeOf(m);
    const roles = this.availableRoles();
    const projects = this.projectsOf(m);
    const prev = this.contextOf(m);
    const ctx: MissionContextData = { projects, explorer: prev.explorer, local: prev.local, crossSystem: prev.crossSystem, notes: [] };
    const objective = n.desired_outcome || m.title;
    if (scope.kind === 'systems') {
      const cs = await crossSystemSearch(this.deps.systems, scope.systemIds, `${m.title} ${n.requirements.map((r) => r.text).join(' ')}`.slice(0, 500));
      ctx.crossSystem = cs.hits;
      for (const p of cs.problems) this.addLimitation(m.id, p);
      this.event(m.id, null, 'info', 'context.cross_system', `Поиск в других системах: найдено ${cs.hits.length} документов (с указанием системы-источника)`);
    }
    const jobs: Promise<void>[] = [];
    const wantExplorer = projects.length > 0 && (n.needs.project_exploration || ['implementation', 'bugfix', 'improvement'].includes(n.task_type));
    if (wantExplorer && !roles.has('project-explorer')) this.addLimitation(m.id, 'Проекты не изучены: агент «Исследователь проекта» не установлен или выключен.');
    let fatal = false;
    if (wantExplorer && roles.has('project-explorer')) {
      jobs.push(
        this.runAgent(m, a, { phase: 'context', role: 'project-explorer', agentId: 'project-explorer', title: 'Изучение проектов', input: { objective, requirements: n.requirements, projects: projects.map((p) => ({ sourceId: p.sourceId, name: p.name })), focus: n.problem || n.title } }).then((r) => {
          if (r.ok) ctx.explorer = r.output as unknown as ExplorerOutput;
          else if (r.fatal) fatal = true;
          else this.addLimitation(m.id, `Изучение проектов не выполнено: ${r.error.message}`);
        }),
      );
    }
    const docs = [...scope.docIds, ...parseJson<MissionAttachment[]>(m.attachments, []).filter((x) => x.kind === 'document').map((x) => x.ref)];
    const wantLocal = n.needs.local_research || docs.length > 0 || scope.kind === 'systems';
    if (wantLocal && !roles.has('researcher')) this.addLimitation(m.id, 'Документы не изучены: агент «Исследователь» не установлен или выключен.');
    if (wantLocal && roles.has('researcher')) {
      const context: ContextBlock[] = ctx.crossSystem.length
        ? [{ source: 'other-systems', priority: 2, content: `Найдено в других выбранных системах (читайте через read_document с systemId):\n${ctx.crossSystem.map((h) => `- systemId=${h.systemId} (${h.systemName}) docId=${h.docId} «${h.title}» ${h.path}: ${h.snippet}`).join('\n')}` }]
        : [];
      jobs.push(
        this.runAgent(m, a, {
          phase: 'context',
          role: 'researcher',
          agentId: 'researcher',
          title: 'Изучение документов и базы знаний',
          input: { goal: objective, constraints: n.constraints, documents: uniq(docs).map((d) => ({ docId: d, title: this.rt.db.get<{ title: string }>('SELECT title FROM documents WHERE id = ?', d)?.title ?? d })), answers: this.answers(m.id) },
          context,
        }).then(async (r) => {
          if (r.ok) {
            const o = r.output as unknown as ResearcherOutput;
            const grounded = await groundEvidence(this.rt, this.deps.systems, scope.kind === 'systems' ? scope.systemIds : [], scope.sourceIds.length ? new Set([...scope.sourceIds, this.rt.primaryVaultId()]) : null, o.evidence);
            ctx.local = { evidence: grounded, gaps: o.gaps };
            const unverified = grounded.filter((e) => !e.verified && e.kind === 'fact').length;
            this.event(m.id, r.stepId, 'info', 'context.grounded', `Свидетельства: подтверждено цитатами ${grounded.filter((e) => e.verified).length} из ${grounded.length}${unverified ? `, ${unverified} без подтверждения` : ''}`);
          } else if (r.fatal) fatal = true;
          else this.addLimitation(m.id, `Изучение документов не выполнено: ${r.error.message}`);
        }),
      );
    }
    // independent research jobs run in parallel (bounded by the mission's limit)
    if (this.limitsOf(m).maxParallel >= 2) await Promise.all(jobs);
    else for (const j of jobs) await j;
    this.patch(m.id, { context: JSON.stringify(ctx) });
    if (fatal) return 'wait';
    return this.goNext(m.id, 'context');
  }

  /** Web research with programmatic quote verification; disabled web is an explicit limitation, not a silent gap. */
  private async phaseResearch(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    const n = this.normalizedOf(m)!;
    const scope = this.scopeOf(m);
    if (!scope.allowWeb) {
      this.addLimitation(m.id, 'Внешние источники не изучались: веб-доступ для поручения не разрешён.');
      return this.goNext(m.id, 'research');
    }
    if (!this.availableRoles().has('web-researcher')) {
      this.addLimitation(m.id, 'Внешние источники не изучались: агент «Веб-исследователь» не установлен или выключен.');
      return this.goNext(m.id, 'research');
    }
    const ctx = this.contextOf(m);
    const urls = parseJson<MissionAttachment[]>(m.attachments, []).filter((x) => x.kind === 'url').map((x) => x.ref);
    const queries = uniq([m.title, n.desired_outcome, ...n.requirements.slice(0, 2).map((r) => r.text)].map((q) => clip(q.trim(), 200)).filter((q) => q.length > 3)).slice(0, 4);
    const res = await this.runAgent(m, a, {
      phase: 'research',
      role: 'web-researcher',
      agentId: 'web-researcher',
      title: 'Поиск во внешних источниках',
      input: {
        question: n.desired_outcome || m.title,
        subquestions: [...n.requirements.slice(0, 5).map((r) => r.text), ...urls.map((u) => `Изучить источник: ${u}`)],
        queries: queries.length ? queries : [m.title],
        local_findings: [...(ctx.explorer?.findings ?? []).slice(0, 10), ...(ctx.local?.evidence ?? []).filter((e) => e.verified).slice(0, 10).map((e) => ({ id: e.id, fact: e.fact }))],
      },
      variant: `o${this.extrasOf(m).filter((x) => x.kind === 'option').length}`,
    });
    if (!res.ok) {
      if (res.fatal) return 'wait';
      this.addLimitation(m.id, `Веб-исследование не выполнено: ${res.error.message}`);
      return this.goNext(m.id, 'research');
    }
    const o = res.output as unknown as WebOutput;
    const g = groundClaims(this.rt, o.claims);
    const { claims: _c, ...rest } = o;
    this.patch(m.id, { research: JSON.stringify({ web: rest, claims: g.claims, verified: g.verified, domains: g.domains } satisfies MissionResearchData) });
    this.event(m.id, res.stepId, 'info', 'research.grounded', `Веб-утверждения: подтверждено цитатами ${g.verified} из ${o.claims.length}, независимых доменов: ${g.domains}`);
    if (o.claims.length && !g.verified) this.addLimitation(m.id, 'Ни одна цитата из внешних источников не подтверждена в загруженном тексте: выводы веб-исследования считаются неподтверждёнными.');
    return this.goNext(m.id, 'research');
  }

  /** Stages 3–4: alternatives (reuse → configure → library → extend → new) and a justified choice. */
  private async phaseStrategy(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    const n = this.normalizedOf(m)!;
    if (!this.availableRoles().has('solution-architect')) {
      this.addLimitation(m.id, 'Варианты решения не сравнивались: агент «Архитектор решений» не установлен или выключен.');
      this.patch(m.id, { plan_stale: m.plan_stale === 2 ? 1 : m.plan_stale });
      return this.goNext(m.id, 'strategy');
    }
    const ctx = this.contextOf(m);
    const research = this.researchOf(m);
    const extraOptions = this.extrasOf(m).filter((x) => x.kind === 'option').map((x) => `Дополнительно исследовать вариант: ${x.text}`);
    const feedback = this.feedback(m.id, 'strategy');
    const res = await this.runAgent(m, a, {
      phase: 'strategy',
      role: 'solution-architect',
      agentId: 'solution-architect',
      title: 'Сравнение вариантов решения',
      input: {
        objective: n.desired_outcome || m.title,
        requirements: n.requirements,
        constraints: [...n.constraints, ...extraOptions, ...feedback.map((f) => `Замечание пользователя: ${f}`)],
        findings: [
          ...(ctx.explorer?.existing_solutions ?? []).map((s) => ({ kind: 'existing_solution', ...s })),
          ...(ctx.explorer?.findings ?? []).slice(0, 15).map((f) => ({ kind: 'project_finding', id: f.id, text: f.text })),
          ...(ctx.local?.evidence ?? []).filter((e) => e.verified).slice(0, 15).map((e) => ({ kind: 'evidence', id: e.id, text: e.fact, verified: true })),
        ],
        research: { claims: research.claims.filter((c) => c.quote_status === 'verified').map((c) => ({ id: c.id, statement: c.statement, source_url: c.source_url })), unverified: research.claims.filter((c) => c.quote_status !== 'verified').length },
      },
      variant: `o${extraOptions.length}f${feedback.length}`,
    });
    if (!res.ok) {
      if (res.fatal) return 'wait';
      this.addLimitation(m.id, `Сравнение вариантов не выполнено: ${res.error.message}`);
      return this.goNext(m.id, 'strategy');
    }
    const o = res.output as unknown as ArchitectOutput;
    const cur = this.row(m.id);
    const prevStrategy = parseJson<Strategy | null>(cur.strategy, null);
    const keepUser = prevStrategy?.selectedBy === 'user' && o.options.some((x) => x.id === prevStrategy.selected);
    const selected = keepUser ? prevStrategy!.selected : o.selected;
    const strategy: Strategy = keepUser ? { ...prevStrategy!, option: o.options.find((x) => x.id === selected) ?? null } : { selected, option: o.options.find((x) => x.id === selected) ?? null, rationale: o.rationale, tradeoffs: o.tradeoffs, selectedBy: 'architect' };
    this.patch(m.id, { options: JSON.stringify(o.options), strategy: JSON.stringify(strategy), plan_stale: cur.plan ? 1 : 0 });
    this.event(m.id, res.stepId, 'info', 'strategy.selected', `Выбран вариант ${strategy.selected}${strategy.option ? ` «${strategy.option.name}»` : ''}: ${clip(strategy.rationale, 300)}`);
    if (o.needs_user_approval && this.policyOf(cur).approvePlan !== 'never' && !keepUser) {
      this.ask(m.id, 'strategy', 'Подтвердите выбор решения', o.approval_reason ?? 'Решение существенно влияет на архитектуру.', { options: o.options, selected: strategy.selected, rationale: strategy.rationale, tradeoffs: strategy.tradeoffs }, 'planning');
      return 'wait';
    }
    return this.goNext(m.id, 'strategy');
  }

  private availableTools(m: MissionRow): string[] {
    const enabled = this.enabledAgents();
    const scope = this.runScope(m);
    const tools = new Set<string>();
    for (const role of this.availableRoles()) {
      const agentId = ROLE_AGENTS[role as PlanRole];
      if (!enabled.has(agentId)) continue;
      try {
        const pkgTools = appAI(this.rt.app).catalog.builtinPackage(agentId)?.tools ?? [];
        for (const t of pkgTools) tools.add(t);
      } catch {
        // custom packages: tools are known at run time
      }
    }
    return [...tools].filter((t) => !(scope.deniedTools ?? []).includes(t)).sort();
  }

  /** Steps of the current plan (latest row per plan step, superseded rows excluded). */
  private currentExecSteps(missionId: string): StepRow[] {
    const rows = this.rt.db.all<StepRow>("SELECT * FROM mission_steps WHERE mission_id = ? AND phase = 'execution' ORDER BY seq", missionId);
    const byPlan = new Map<string, StepRow>();
    for (const r of rows) if (r.plan_step) byPlan.set(r.plan_step, r);
    const plan = this.planOf(this.row(missionId)).map((p) => p.id);
    return plan.map((id) => byPlan.get(id)).filter((x): x is StepRow => !!x);
  }

  /**
   * Installs a plan: completed steps the new plan keeps stay as they are (no needless re-execution, 28.13); steps not
   * started yet are superseded; new and changed steps get fresh rows.
   */
  private installPlan(m: MissionRow, steps: PlanStep[]): void {
    const current = this.currentExecSteps(m.id);
    const byPlan = new Map(current.map((s) => [s.plan_step!, s]));
    this.rt.db.transaction(() => {
      for (const s of current) {
        const next = steps.find((x) => x.id === s.plan_step);
        if (s.status === 'running' || s.status === 'completed') continue; // running finishes; completed results stay in history
        if (next && s.status === 'pending' && !next.keep_existing && JSON.stringify(parseJson(s.depends_on, [])) === JSON.stringify(next.depends_on) && s.title === next.title) continue;
        this.patchStep(s.id, { status: 'skipped', finished_at: nowIso(), error: JSON.stringify({ code: 'CANCELLED', message: 'План пересчитан: этап заменён.', hint: '' }) });
      }
      for (const p of steps) {
        const cur = byPlan.get(p.id);
        if (cur && (cur.status === 'running' || (cur.status === 'completed' && p.keep_existing))) {
          this.patchStep(cur.id, { depends_on: JSON.stringify(p.depends_on), title: p.title });
          continue;
        }
        if (cur && cur.status === 'pending' && JSON.stringify(parseJson(cur.depends_on, [])) === JSON.stringify(p.depends_on) && cur.title === p.title) continue;
        this.newStep(m, { phase: 'execution', role: p.role, agentId: ROLE_AGENTS[p.role], title: p.title, planStep: p.id, dependsOn: p.depends_on, key: null });
      }
      this.patch(m.id, { plan: JSON.stringify(steps), plan_stale: 0 });
    });
  }

  /** Project checks that would run in verification but are not approved yet (approved together with the plan). */
  private checksToApprove(m: MissionRow): { sourceId: string; sourceName: string; name: string; command: string; required: boolean }[] {
    const approved = this.approvedChecksOf(m);
    const out: { sourceId: string; sourceName: string; name: string; command: string; required: boolean }[] = [];
    for (const p of this.projectsOf(m)) {
      if (!modeAtLeast(p.accessMode, 'workcopy')) continue;
      for (const c of projectChecks(this.rt, p.sourceId)) {
        if (approved.some((x) => x.sourceId === p.sourceId && x.name === c.name)) continue;
        out.push({ sourceId: p.sourceId, sourceName: p.name, name: c.name, command: [c.program, ...c.args].join(' '), required: c.required !== false });
      }
    }
    return out;
  }

  /** Stage 5: a concrete plan with ids, roles, dependencies, checks and risks; validated by code, not trusted blindly. */
  private async phasePlanning(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    const n = this.normalizedOf(m)!;
    const roles = this.availableRoles();
    const completed = this.currentExecSteps(m.id).filter((s) => s.status === 'completed');
    const strategy = parseJson<Strategy | null>(m.strategy, null);
    const extras = this.extrasOf(m);
    const feedbackBase = [
      ...this.feedback(m.id, 'plan').map((f) => `Замечание пользователя к плану: ${f}`),
      ...extras.filter((x) => x.kind !== 'option' && x.kind !== 'criterion').map((x) => `Требование пользователя ${x.id}: ${x.text}`),
      ...this.messages(m.id)
        .filter((x) => (x.data as { kind?: string } | null)?.kind === 'conflict_resolution')
        .map((x) => x.body),
    ];
    let feedback = [...feedbackBase];
    let attempt = 0;
    let check: ReturnType<typeof validatePlan> | null = null;
    let notes: string[] = [];
    for (; attempt < 2; attempt++) {
      const res = await this.runAgent(m, a, {
        phase: 'planning',
        role: 'mission-planner',
        agentId: 'mission-planner',
        title: attempt ? 'Планирование (исправление плана)' : 'Планирование',
        input: {
          objective: n.desired_outcome || m.title,
          requirements: n.requirements,
          acceptance_criteria: this.criteriaOf(m).map((c) => ({ id: c.id, text: c.text, verification: c.verification })),
          ...(strategy ? { strategy: { selected: strategy.selected, name: strategy.option?.name ?? null, description: strategy.option?.description ?? null, rationale: strategy.rationale, tradeoffs: strategy.tradeoffs } } : {}),
          completed_steps: completed.map((s) => ({ id: s.plan_step, title: s.title, role: s.role, result: compactOutput(s.role, parseJson(s.output, null), 1500) })),
          available_roles: [...roles].map((r) => ({ role: r, description: ROLE_DESCRIPTIONS[r as PlanRole] })),
          available_tools: this.availableTools(m),
          constraints: n.constraints,
          mode: m.mode,
          ...(feedback.length ? { feedback } : {}),
        },
        variant: `a${attempt}:${sha256(feedback.join('|')).slice(0, 10)}`,
      });
      if (!res.ok) {
        if (!res.fatal) this.askForError(this.row(m.id), res.error, res.stepId);
        return 'wait';
      }
      // the user changed requirements while the planner was working: plan again for the current revision
      if (this.row(m.id).revision !== m.revision) {
        this.event(m.id, res.stepId, 'info', 'plan.outdated', 'Требования изменились во время планирования — план составляется заново');
        return 'continue';
      }
      const out = res.output as unknown as PlannerOutput;
      notes = out.notes ?? [];
      check = validatePlan(out.steps, { mode: m.mode, availableRoles: roles, completed: new Set(completed.map((s) => s.plan_step!)) });
      for (const w of check.warnings) this.event(m.id, res.stepId, 'warn', 'plan.warning', w);
      if (!check.errors.length) break;
      this.event(m.id, res.stepId, 'warn', 'plan.invalid', `План не прошёл проверку: ${check.errors.join('; ')}`);
      feedback = [...feedbackBase, ...check.errors.map((e) => `Исправь план: ${e}`)];
    }
    if (!check || check.errors.length) {
      this.ask(m.id, 'error', 'Не удалось составить корректный план', `Планировщик дважды вернул план с ошибками: ${check?.errors.join('; ') ?? 'нет плана'}. Уточните задачу или повторите.`, { problems: check?.errors ?? [] }, 'planning', 'needs_input');
      return 'wait';
    }
    // 28.13: a new requirement that contradicts an earlier one is explained, not silently resolved
    const conflicts = notes.filter((x) => /^\s*конфликт(?!\p{L})/iu.test(x));
    const resolved = this.messages(m.id).filter((x) => (x.data as { kind?: string } | null)?.kind === 'conflict_resolution').length;
    if (conflicts.length && !resolved) {
      const last = [...extras].reverse().find((x) => x.kind === 'requirement' || x.kind === 'constraint');
      this.ask(m.id, 'conflict', 'Новое требование противоречит прежним', conflicts.join(' '), { conflicts, requirementId: last?.id ?? null, requirement: last?.text ?? null, proposedPlan: check.steps }, 'planning', 'needs_input');
      return 'wait';
    }
    this.installPlan(this.row(m.id), check.steps);
    this.event(m.id, null, 'info', 'plan.ready', `План: ${check.steps.length} шагов (${uniq(check.steps.map((s) => s.role)).join(', ')})`);
    if (m.mode === 'plan') return this.moveTo(m.id, 'summary') ? 'continue' : 'wait';
    const cur = this.row(m.id);
    const policy = this.policyOf(cur);
    const reasons: string[] = [];
    const checks = this.checksToApprove(cur);
    if (policy.approvePlan === 'always') reasons.push('политика поручения: план всегда подтверждается');
    else if (policy.approvePlan === 'risky') {
      reasons.push(...riskyPlanReasons(check.steps));
      for (const r of n.risks.filter((x) => x.level === 'high')) reasons.push(`высокий риск: ${r.text}`);
      if (check.steps.some((s) => s.role === 'implementer') && checks.length) reasons.push(`нужно разрешить запуск проверок проекта в рабочей копии: ${checks.map((c) => `${c.sourceName}/${c.name}`).join(', ')}`);
    }
    if (reasons.length) {
      this.ask(cur.id, 'plan', 'Подтвердите план', reasons.join('; '), { plan: check.steps, reasons, checks, warnings: check.warnings }, 'execution');
      return 'wait';
    }
    return this.moveTo(cur.id, 'execution') ? 'continue' : 'wait';
  }

  private baseline(m: MissionRow): Record<string, string> {
    const out: Record<string, string> = {};
    for (const p of this.projectsOf(m)) {
      const rows = this.rt.db.all<{ rel_path: string; hash: string | null }>('SELECT rel_path, hash FROM files WHERE source_id = ? ORDER BY rel_path', p.sourceId);
      out[p.sourceId] = sha256(rows.map((r) => `${r.rel_path}:${r.hash ?? ''}`).join('\n'));
    }
    return out;
  }

  private stepInput(m: MissionRow, step: PlanStep): unknown {
    const n = this.normalizedOf(m)!;
    const ctx = this.contextOf(m);
    const strategy = parseJson<Strategy | null>(m.strategy, null);
    const deps = this.currentExecSteps(m.id).filter((s) => step.depends_on.includes(s.plan_step ?? '') && s.status === 'completed');
    const previous = deps.map((s) => ({ step_id: s.plan_step, title: s.title, role: s.role, result: compactOutput(s.role, parseJson(s.output, null)) }));
    const projects = this.projectsOf(m);
    const docs = this.scopeOf(m).docIds;
    switch (step.role) {
      case 'project-explorer':
        return { objective: step.goal, requirements: n.requirements, projects: projects.map((p) => ({ sourceId: p.sourceId, name: p.name })), focus: step.title };
      case 'researcher':
        return { goal: step.goal, constraints: n.constraints, documents: docs.map((d) => ({ docId: d, title: this.rt.db.get<{ title: string }>('SELECT title FROM documents WHERE id = ?', d)?.title ?? d })), answers: this.answers(m.id) };
      case 'web-researcher':
        return { question: step.goal, subquestions: step.inputs.slice(0, 5), queries: uniq([step.title, step.goal].map((q) => clip(q, 200))), local_findings: previous };
      case 'solution-architect':
        return { objective: step.goal, requirements: n.requirements, constraints: n.constraints, findings: previous };
      case 'documenter':
        return { objective: step.goal, results: previous.length ? previous : this.currentExecSteps(m.id).filter((s) => s.status === 'completed').map((s) => ({ step_id: s.plan_step, title: s.title, result: compactOutput(s.role, parseJson(s.output, null)) })), artifacts: this.artifacts(m).map((x) => ({ type: x.type, title: x.title, ref: x.ref })) };
      case 'security-reviewer':
        return { objective: step.goal, files: this.changedFilesForReview(m) };
      case 'implementer':
      default:
        return {
          step: { id: step.id, title: step.title, goal: step.goal, expected_output: step.expected_output, done_criteria: step.done_criteria, verification: step.verification },
          objective: n.desired_outcome || m.title,
          requirements: n.requirements,
          ...(strategy ? { strategy: { selected: strategy.selected, name: strategy.option?.name ?? null, rationale: strategy.rationale } } : {}),
          context_files: (ctx.explorer?.relevant_files ?? []).slice(0, 25).map((f) => ({ source_id: f.source_id, path: f.path })),
          previous_results: previous,
          output_folder: MISSION_FOLDER,
          projects: projects.map((p) => ({ sourceId: p.sourceId, name: p.name, accessMode: p.accessMode, accessModeLabel: modeLabel(p.accessMode), canPrepareChanges: modeAtLeast(p.accessMode, 'prepare'), checks: projectChecks(this.rt, p.sourceId).map((c) => c.name) })),
        };
    }
  }

  private changedFilesForReview(m: MissionRow): { path: string; operation: string; excerpt: string }[] {
    const set = this.openSet(m.id);
    if (!set) return [];
    return this.deps.changes
      .contents(set.id)
      .slice(0, 40)
      .map((f) => ({ path: `${this.rt.db.get<{ name: string }>('SELECT name FROM sources WHERE id = ?', f.sourceId)?.name ?? f.sourceId}:${f.path}`, operation: f.op, excerpt: clip(f.content ?? '', 3000) }));
  }

  /** Executes one plan step; research outputs are grounded, documenter output is saved as ONE document. */
  private async execStep(m: MissionRow, a: Active, row: StepRow, step: PlanStep): Promise<void> {
    const res = await this.runAgent(m, a, { phase: 'execution', role: step.role, agentId: ROLE_AGENTS[step.role], title: `${step.id}. ${step.title}`, planStep: step.id, input: this.stepInput(m, step), rowId: row.id, note: `Шаг ${step.id} плана поручения ${m.key}. Критерии готовности шага: ${step.done_criteria.join('; ') || '—'}.` });
    if (!res.ok) return;
    const scope = this.scopeOf(m);
    if (step.role === 'researcher') {
      const o = res.output as unknown as ResearcherOutput;
      const grounded = await groundEvidence(this.rt, this.deps.systems, scope.kind === 'systems' ? scope.systemIds : [], scope.sourceIds.length ? new Set([...scope.sourceIds, this.rt.primaryVaultId()]) : null, o.evidence);
      this.patchStep(res.stepId, { output: JSON.stringify({ ...o, evidence: grounded }) });
    } else if (step.role === 'web-researcher') {
      const o = res.output as unknown as WebOutput;
      const g = groundClaims(this.rt, o.claims);
      this.patchStep(res.stepId, { output: JSON.stringify({ ...o, claims: g.claims, verified: g.verified, domains: g.domains }) });
    } else if (step.role === 'documenter') {
      await this.saveDocumenterOutput(m, res.stepId, res.output as unknown as DocumenterOutput);
    } else if (step.role === 'implementer') {
      const o = res.output as unknown as ImplementerOutput;
      // an action the agent claims but no tool call confirms is not counted (no imitation, 28.5 stage 6)
      const okTools = new Set(res.toolCalls.filter((t) => t.ok).map((t) => t.tool));
      const claimed = o.actions.filter((x) => (x.type === 'proposed_change' && !okTools.has('propose_file_change')) || (x.type === 'created_document' && !okTools.has('create_document')) || (x.type === 'ran_check' && !okTools.has('run_check')));
      if (claimed.length) this.addLimitation(m.id, `${step.id}: агент сообщил о действиях, которые не подтверждены вызовами инструментов (${uniq(claimed.map((x) => x.type)).join(', ')}) — они не засчитаны.`);
    }
  }

  private async saveDocumenterOutput(m: MissionRow, stepId: string, o: DocumenterOutput): Promise<void> {
    const existing = this.rt.db.get<{ doc_id: string }>("SELECT doc_id FROM doc_properties WHERE key = 'mission_step' AND value_text = ?", stepId);
    if (existing) return;
    const vault = this.rt.db.get<{ writable: number }>('SELECT writable FROM sources WHERE id = ?', this.rt.primaryVaultId());
    if (!vault?.writable) {
      this.addLimitation(m.id, 'Документ не сохранён: хранилище системы открыто только для чтения.');
      return;
    }
    const folder = DOC_FOLDERS.find((f) => o.target_folder && (o.target_folder === f || o.target_folder.startsWith(`${f}/`))) ? o.target_folder.replace(/\.\.+/g, '').replace(/^\/+/, '') : MISSION_FOLDER;
    const d = await this.deps.docs.create({ title: clip(o.title || m.title, 200), folder, content: o.markdown, properties: { mission: m.key, mission_step: stepId }, actor: 'agent:documenter' });
    const cur = parseJson<SideEffect[]>(this.stepRow(stepId).side_effects, []);
    cur.push({ tool: 'documenter.save', target: d.relPath, ref: d.id, title: d.title });
    this.patchStep(stepId, { side_effects: JSON.stringify(cur) });
    this.event(m.id, stepId, 'info', 'document.saved', `Документ сохранён: ${d.relPath}`, { docId: d.id });
  }

  /**
   * Stage 6: runs plan steps by dependencies. Independent read-only steps run in parallel (bounded); steps that
   * change files run one at a time so they do not conflict (28.5 stage 5). Verifier steps are covered by stage 7.
   */
  private async phaseExecution(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    if (m.mode === 'plan') return this.moveTo(m.id, 'summary') ? 'continue' : 'wait';
    if (!m.baseline) this.patch(m.id, { baseline: JSON.stringify(this.baseline(m)) });
    const plan = this.planOf(m);
    if (plan.some((s) => s.role === 'implementer') && this.projectsOf(m).length && this.projectsOf(m).every((p) => !modeAtLeast(p.accessMode, 'prepare'))) {
      this.addLimitation(m.id, `Подготовка изменений невозможна: все проекты поручения в режиме «${modeLabel('read_only')}». Режим меняет только пользователь.`);
    }
    const limits = this.limitsOf(m);
    const running = new Map<string, Promise<void>>();
    for (;;) {
      const cur = this.row(m.id);
      const halt = !WORKING_STATUSES.includes(cur.status) || cur.plan_stale > 0 || a.controller.signal.aborted;
      if (!halt) {
        const steps = this.currentExecSteps(m.id);
        const done = new Set(steps.filter((s) => s.status === 'completed' || s.status === 'skipped').map((s) => s.plan_step));
        const implRunning = [...running.keys()].some((id) => this.stepRow(id).role === 'implementer');
        for (const s of steps) {
          if (s.status !== 'pending' || running.has(s.id)) continue;
          const deps = parseJson<string[]>(s.depends_on, []);
          if (!deps.every((d) => done.has(d))) continue;
          const def = this.planOf(cur).find((p) => p.id === s.plan_step);
          if (!def) continue;
          if (def.role === 'verifier') {
            this.patchStep(s.id, { status: 'skipped', finished_at: nowIso(), output: JSON.stringify({ note: 'Проверка выполняется на этапе «Проверка результата».' }) });
            this.event(m.id, s.id, 'info', 'step.skipped', `«${s.title}»: выполняется на этапе проверки результата`);
            continue;
          }
          if (running.size >= limits.maxParallel) break;
          if (def.role === 'implementer' && (implRunning || [...running.keys()].some((id) => this.stepRow(id).role === 'implementer'))) continue;
          if (def.role === 'web-researcher' && !this.scopeOf(cur).allowWeb) {
            this.patchStep(s.id, { status: 'skipped', finished_at: nowIso(), error: JSON.stringify(new AppError('NETWORK_POLICY_DENIED', 'Веб-доступ для поручения не разрешён.').toJSON()) });
            this.addLimitation(m.id, `${def.id} «${def.title}» не выполнен: веб-доступ для поручения не разрешён.`);
            continue;
          }
          // mark running synchronously so no other pass starts it twice
          this.patchStep(s.id, { status: 'running' });
          running.set(
            s.id,
            this.execStep(cur, a, this.stepRow(s.id), def)
              .catch((e) => {
                const err = toAppError(e);
                this.patchStep(s.id, { status: 'failed', error: JSON.stringify(err.toJSON()), finished_at: nowIso() });
                this.event(m.id, s.id, 'error', 'step.failed', `«${s.title}»: ${err.message}`, { code: err.code });
              })
              .finally(() => running.delete(s.id)),
          );
        }
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }
    const cur = this.row(m.id);
    if (!WORKING_STATUSES.includes(cur.status) || a.controller.signal.aborted) return 'wait';
    if (cur.plan_stale) return 'continue';
    const steps = this.currentExecSteps(m.id);
    const failed = steps.filter((s) => s.status === 'failed' || s.status === 'cancelled');
    if (failed.length) {
      const first = parseJson<AppErrorJson | null>(failed[0]!.error, null);
      this.ask(m.id, 'error', failed.length === 1 ? `Этап «${failed[0]!.title}» не выполнен` : `Не выполнены этапы: ${failed.length}`, `${first?.message ?? 'ошибка'}${first?.hint ? ` ${first.hint}` : ''} Повторите этап или пропустите его — результат будет помечен как частичный.`, { stepIds: failed.map((s) => s.id), steps: failed.map((s) => ({ id: s.id, title: s.title, error: parseJson(s.error, null) })) }, 'execution', 'needs_input');
      return 'wait';
    }
    // pending steps whose dependencies were skipped by the user's decision stay unreachable: mark them explicitly
    for (const s of steps.filter((x) => x.status === 'pending')) {
      this.patchStep(s.id, { status: 'skipped', finished_at: nowIso(), error: JSON.stringify(new AppError('VALIDATION_FAILED', 'Зависимости этапа не выполнены.').toJSON()) });
      this.addLimitation(m.id, `${s.plan_step} «${s.title}» не выполнен: его зависимости пропущены.`);
    }
    return this.moveTo(m.id, 'verification') ? 'continue' : 'wait';
  }

  private recordCheck(m: MissionRow, c: { stepId: string | null; kind: 'command' | 'criterion' | 'validator'; name: string; sourceId: string | null; status: string; exitCode?: number | null; durationMs?: number | null; output?: string | null; evidence?: unknown }): void {
    this.rt.db.run(
      'INSERT INTO mission_checks(id, mission_id, step_id, round, kind, name, source_id, status, exit_code, duration_ms, output, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      newId('chk'),
      m.id,
      c.stepId,
      m.fix_rounds,
      c.kind,
      c.name,
      c.sourceId,
      c.status,
      c.exitCode ?? null,
      c.durationMs ?? null,
      c.output ?? null,
      c.evidence === undefined ? null : JSON.stringify(c.evidence),
      nowIso(),
    );
  }

  /** Command checks of this verification round, run in the mission's work copies with the current content. */
  private async runMissionChecks(m: MissionRow, a: Active, set: ChangeSetView | null, marker: string): Promise<{ notRun: { name: string; reason: string }[] }> {
    const notRun: { name: string; reason: string }[] = [];
    const approved = this.approvedChecksOf(m);
    const sources = set ? uniq(set.files.filter((f) => f.status !== 'skipped').map((f) => f.sourceId)) : [];
    for (const sid of sources) {
      const src = this.rt.db.get<{ kind: string; name: string; access_mode: AccessMode }>('SELECT kind, name, access_mode FROM sources WHERE id = ?', sid);
      if (!src || src.kind !== 'project') continue;
      const defs = projectChecks(this.rt, sid);
      if (!defs.length) {
        notRun.push({ name: `${src.name}: проверки`, reason: 'для проекта не настроены команды проверки — корректность изменений автоматически не подтверждена' });
        continue;
      }
      if (!modeAtLeast(src.access_mode, 'workcopy')) {
        for (const d of defs) notRun.push({ name: `${src.name}/${d.name}`, reason: `режим проекта «${modeLabel(src.access_mode)}» не позволяет рабочую копию — проверки не запускались` });
        continue;
      }
      let wc: { id: string; rootPath: string };
      try {
        wc = await this.deps.changes.applyToWorkCopy(set!.id, sid, `mission:${m.key}`);
      } catch (e) {
        const err = toAppError(e);
        for (const d of defs) notRun.push({ name: `${src.name}/${d.name}`, reason: `рабочая копия не создана: ${err.message}` });
        continue;
      }
      for (const d of defs) {
        const ok = approved.find((x) => x.sourceId === sid && x.name === d.name);
        if (!ok) {
          notRun.push({ name: `${src.name}/${d.name}`, reason: 'запуск не подтверждён пользователем' });
          this.recordCheck(m, { stepId: marker, kind: 'command', name: d.name, sourceId: sid, status: 'not_approved' });
          continue;
        }
        try {
          const r = await runCheck(this.rt, sid, d.name, { workCopy: wc, actor: `mission:${m.key}`, runId: m.id, signal: a.controller.signal, approvedContentHash: ok.contentHash ?? null });
          const status = r.ok ? 'passed' : r.timedOut ? 'timeout' : 'failed';
          this.recordCheck(m, { stepId: marker, kind: 'command', name: d.name, sourceId: sid, status, exitCode: r.exitCode, durationMs: r.durationMs, output: r.output, evidence: { isolation: r.isolation.level, workCopyId: wc.id, command: r.command, contentHash: set!.review.contentHash } });
          this.event(m.id, null, r.ok ? 'info' : 'warn', 'check.done', `Проверка ${src.name}/${d.name}: ${r.ok ? 'пройдена' : r.timedOut ? 'превышен тайм-аут' : `не пройдена (код ${r.exitCode})`}; изоляция: ${r.isolation.level === 'isolated' ? 'песочница' : 'ограниченный режим'}`);
        } catch (e) {
          const err = toAppError(e);
          notRun.push({ name: `${src.name}/${d.name}`, reason: err.message });
          this.recordCheck(m, { stepId: marker, kind: 'command', name: d.name, sourceId: sid, status: 'blocked', output: err.message });
        }
      }
    }
    return { notRun };
  }

  /** Stage 7: deterministic checks + verifier agent + guard. An agent's «done» is not accepted without evidence. */
  private async phaseVerification(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    const n = this.normalizedOf(m)!;
    const set = this.openSet(m.id);
    const review = this.reviewOf(m);
    const scope = this.scopeOf(m);
    // one marker per verification run: results of an earlier run never mix with the current content's results
    const marker = `verification:${m.fix_rounds}:${newId('v')}`;
    this.patch(m.id, { review: JSON.stringify({ ...review, lastVerification: marker }) });
    // validators: only scoped sources changed; the originals were not changed behind the mission's back
    if (set) {
      const allowedSources = scope.kind === 'system' ? null : new Set([...scope.sourceIds, this.rt.primaryVaultId()]);
      const outside = set.files.filter((f) => f.status !== 'skipped' && allowedSources && !allowedSources.has(f.sourceId));
      this.recordCheck(m, { stepId: marker, kind: 'validator', name: 'Изменения только в области поручения', sourceId: null, status: outside.length ? 'failed' : 'passed', output: outside.length ? outside.map((f) => `${f.sourceName}:${f.path}`).join(', ') : null });
    }
    const base = parseJson<Record<string, string>>(m.baseline, {});
    const now = this.baseline(m);
    const changedOriginals = Object.keys(base).filter((k) => now[k] !== undefined && now[k] !== base[k]);
    if (Object.keys(base).length) {
      const appliedByMission = this.missionSets(m.id).some((s) => s.status === 'applied' || s.status === 'partially_applied');
      this.recordCheck(m, { stepId: marker, kind: 'validator', name: 'Исходные проекты не изменены во время выполнения', sourceId: null, status: changedOriginals.length && !appliedByMission ? 'warning' : 'passed', output: changedOriginals.length ? `изменились файлы проектов: ${changedOriginals.join(', ')} (не через поручение — возможно, правки пользователя)` : null });
    }
    const { notRun } = await this.runMissionChecks(m, a, set, marker);
    if (a.controller.signal.aborted) return 'wait';
    const roundChecks = this.checkRecords(m.id).filter((c) => c.round === m.fix_rounds && (c.evidence as { stepId?: string } | null)?.stepId === marker);
    const commandChecks = roundChecks.filter((c) => c.kind === 'command' && ['passed', 'failed', 'timeout'].includes(c.status));
    // security review of proposed project changes
    let security: ReviewData['security'] = review.security;
    if (set && set.files.some((f) => f.status !== 'skipped')) {
      if (this.availableRoles().has('security-reviewer')) {
        const r = await this.runAgent(m, a, { phase: 'verification', role: 'security-reviewer', agentId: 'security-reviewer', title: 'Проверка безопасности изменений', input: { objective: n.desired_outcome || m.title, change_summary: `${set.summary.files} файлов: +${set.summary.added} −${set.summary.removed}`, files: this.changedFilesForReview(m), findings: set.risks.map((x) => ({ title: x.title, severity: x.severity, files: x.files })) }, variant: set.review.contentHash ?? '' });
        if (!r.ok && r.fatal) return 'wait';
        if (r.ok) security = { ...(r.output as unknown as SecurityOutput), files: set.summary.files };
        else this.addLimitation(m.id, `Проверка безопасности изменений не выполнена: ${r.error.message}`);
      } else this.addLimitation(m.id, 'Изменения не проверены на риски безопасности: агент «Ревьюер безопасности» не установлен или выключен.');
    }
    const artifacts = this.artifacts(this.row(m.id));
    const { evidence, claims } = this.allEvidence(m);
    const stepResults = this.currentExecSteps(m.id).map((s) => ({ step_id: s.plan_step, title: s.title, role: s.role, status: s.status, result: compactOutput(s.role, parseJson(s.output, null), 2500) }));
    const v = await this.runAgent(m, a, {
      phase: 'verification',
      role: 'verifier',
      agentId: 'verifier',
      title: m.fix_rounds ? `Проверка результата (после исправления ${m.fix_rounds})` : 'Проверка результата',
      input: {
        objective: n.desired_outcome || m.title,
        acceptance_criteria: this.criteriaOf(m).map((c) => ({ id: c.id, text: c.text, verification: c.verification })),
        artifacts: artifacts.map((x) => ({ type: x.type, ref: x.ref, title: x.title, status: x.status, path: x.path ?? null })),
        check_results: roundChecks.map((c) => ({ kind: c.kind, name: c.name, status: c.status, exit_code: c.exitCode, output: clip(c.output ?? '', 1500) })),
        step_results: stepResults,
        evidence: [...evidence.filter((e) => e.verified).slice(0, 20).map((e) => ({ id: e.id, fact: e.fact, source: e.source, verified: true })), ...claims.filter((c) => c.quote_status === 'verified').slice(0, 20).map((c) => ({ id: c.id, statement: c.statement, source_url: c.source_url, verified: true }))],
      },
      variant: `${set?.review.contentHash ?? 'none'}:${this.criteriaOf(m).length}`,
    });
    if (!v.ok && v.fatal) return 'wait';
    if (!v.ok) this.addLimitation(m.id, `Проверяющий агент не выполнил оценку: ${v.error.message}. Критерии оценены только детерминированно.`);
    const vo = v.ok ? (v.output as unknown as VerifierOutput) : null;
    const cur = this.row(m.id);
    const anyApplied = this.missionSets(m.id).some((s) => s.status === 'applied' || s.status === 'partially_applied');
    const inWorkCopy = !!set && set.files.some((f) => {
      const mode = this.rt.db.get<{ access_mode: AccessMode; kind: string }>('SELECT access_mode, kind FROM sources WHERE id = ?', f.sourceId);
      return mode?.kind === 'project' && modeAtLeast(mode.access_mode, 'workcopy');
    });
    const criteria = guardCriteria(this.criteriaOf(cur), vo, {
      mode: m.mode,
      checks: commandChecks,
      checksNotRun: notRun,
      artifacts,
      verifiedClaims: claims.filter((c) => c.quote_status === 'verified').length,
      verifiedDomains: new Set(claims.filter((c) => c.quote_status === 'verified').map((c) => {
        try {
          return new URL(c.source_url).hostname.replace(/^www\./, '');
        } catch {
          return c.source_url;
        }
      })).size,
      verifiedEvidence: evidence.filter((e) => e.verified).length,
      changesOnlyProposed: !!set && !anyApplied && !inWorkCopy,
    });
    for (const c of criteria) this.recordCheck(cur, { stepId: marker, kind: 'criterion', name: `${c.id}. ${clip(c.text, 200)}`, sourceId: null, status: c.status, output: c.notes || null, evidence: { evidence: c.evidence, decidedBy: c.decidedBy } });
    const failedCommands = commandChecks.filter((c) => c.status !== 'passed');
    const problems = [
      ...(vo?.problems ?? []).filter((p) => p.severity !== 'minor').map((p) => `${p.description}${p.fix_hint ? ` (как исправить: ${p.fix_hint})` : ''}`),
      ...failedCommands.map((c) => `Проверка «${c.name}» не пройдена${c.exitCode !== null ? ` (код ${c.exitCode})` : ''}: ${clip(c.output ?? '', 1500)}`),
      ...(security?.verdict === 'block' ? security.risks.filter((r) => r.severity === 'critical' || r.severity === 'high').map((r) => `Безопасность: ${r.description} (${r.location}) — ${r.recommendation}`) : []),
    ];
    const nextReview: ReviewData = { ...this.reviewOf(cur), lastVerification: marker, ...(security ? { security } : {}), ...(vo ? { verifier: { problems: vo.problems, regressions_suspected: vo.regressions_suspected, overall: vo.overall } } : {}), checksNotRun: notRun };
    this.patch(m.id, { criteria: JSON.stringify(criteria), review: JSON.stringify(nextReview) });
    const unmet = criteria.filter((c) => c.status === 'not_met' || c.status === 'partially_met');
    const policy = this.policyOf(cur);
    // a fix round only for problems a change can fix: failed checks, unmet criteria, concrete defects — not for limits
    // like «checks could not run» or «changes are only proposed», which no amount of re-implementation changes
    const fixable = problems.length > 0 || criteria.some((c) => c.status === 'not_met');
    const canFix = m.mode === 'execute' && this.planOf(cur).some((s) => s.role === 'implementer') && this.availableRoles().has('implementer') && cur.fix_rounds < policy.maxFixRounds && fixable;
    this.event(m.id, v.ok ? v.stepId : null, unmet.length || problems.length ? 'warn' : 'info', 'verification.done', `Критерии: выполнено ${criteria.filter((c) => c.status === 'met').length} из ${criteria.filter((c) => c.status !== 'not_applicable').length}; проблем: ${problems.length}${notRun.length ? `; не запущено проверок: ${notRun.length}` : ''}`);
    if (canFix) {
      this.patch(m.id, { review: JSON.stringify({ ...nextReview, fix: { round: cur.fix_rounds + 1, problems: [...problems, ...unmet.map((c) => `Критерий ${c.id} «${c.text}»: ${c.notes || c.status}`)] } }) });
      this.setStatus(m.id, 'needs_fix', { phase: 'fix', reason: `проверка выявила проблемы (${problems.length + unmet.length}); попытка исправления ${cur.fix_rounds + 1} из ${policy.maxFixRounds}` });
      return 'continue';
    }
    if (fixable && cur.fix_rounds >= policy.maxFixRounds && policy.maxFixRounds > 0) {
      this.addLimitation(m.id, `После ${cur.fix_rounds} циклов исправления остались проблемы: ${clip([...problems, ...unmet.map((c) => `${c.id}: ${c.status}`)].join('; '), 600)}`);
    }
    return this.goNext(m.id, 'verification');
  }

  /** Stage 8: a bounded fix round; checks are re-run afterwards. */
  private async phaseFix(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    const review = this.reviewOf(m);
    const round = review.fix?.round ?? m.fix_rounds + 1;
    if (m.fix_rounds < round) this.patch(m.id, { fix_rounds: round });
    if (m.status === 'needs_fix') this.setStatus(m.id, 'executing', { phase: 'fix' });
    const cur = this.row(m.id);
    const n = this.normalizedOf(cur)!;
    const ctx = this.contextOf(cur);
    const strategy = parseJson<Strategy | null>(cur.strategy, null);
    const prevImpl = this.stepRows(m.id).filter((s) => s.role === 'implementer' && s.status === 'completed').slice(-3);
    const res = await this.runAgent(cur, a, {
      phase: 'fix',
      role: 'implementer',
      agentId: 'implementer',
      title: `Исправление (цикл ${round})`,
      planStep: `FIX${round}`,
      input: {
        step: { id: `FIX${round}`, title: 'Исправить проблемы, выявленные проверкой', goal: 'Устранить причины непройденных проверок и невыполненных критериев, не ломая остальное', done_criteria: ['проблемы проверки устранены'] },
        objective: n.desired_outcome || cur.title,
        requirements: n.requirements,
        ...(strategy ? { strategy: { selected: strategy.selected, name: strategy.option?.name ?? null, rationale: strategy.rationale } } : {}),
        context_files: (ctx.explorer?.relevant_files ?? []).slice(0, 25).map((f) => ({ source_id: f.source_id, path: f.path })),
        previous_results: prevImpl.map((s) => ({ step_id: s.plan_step, title: s.title, result: compactOutput('implementer', parseJson(s.output, null)) })),
        feedback: (review.fix?.problems ?? []).slice(0, 20),
        output_folder: MISSION_FOLDER,
        projects: this.projectsOf(cur).map((p) => ({ sourceId: p.sourceId, name: p.name, accessMode: p.accessMode, checks: projectChecks(this.rt, p.sourceId).map((c) => c.name) })),
      },
    });
    if (!res.ok) {
      if (res.fatal) return 'wait';
      this.addLimitation(m.id, `Исправление (цикл ${round}) не выполнено: ${res.error.message}`);
      return this.goNext(m.id, 'verification');
    }
    return this.moveTo(m.id, 'verification', `повторная проверка после исправления ${round}`) ? 'continue' : 'wait';
  }

  /** Independent review against the ORIGINAL request (detects distortions of meaning, 28.10). */
  private async phaseReview(m: MissionRow, a: Active): Promise<'continue' | 'wait'> {
    if (!this.enabledAgents().has('independent-reviewer')) {
      this.addLimitation(m.id, 'Независимое ревью не выполнено: агент «Независимый ревьюер поручения» не установлен или выключен.');
      return this.goNext(m.id, 'review');
    }
    const review = this.reviewOf(m);
    const res = await this.runAgent(m, a, {
      phase: 'review',
      role: 'independent-reviewer',
      agentId: 'independent-reviewer',
      title: 'Независимое ревью',
      input: {
        original_request: m.original_request,
        normalized: this.normalizedOf(m),
        assessment: { criteria: this.criteriaOf(m), verifier: review.verifier ?? null, security: review.security ?? null, limitations: this.limitationsOf(m), checksNotRun: review.checksNotRun ?? [] },
        artifacts: this.artifacts(m).map((x) => ({ type: x.type, title: x.title, status: x.status })),
        sources: this.sourceReferences(m).slice(0, 40),
      },
      variant: `${m.fix_rounds}`,
    });
    if (!res.ok) {
      if (res.fatal) return 'wait';
      this.addLimitation(m.id, `Независимое ревью не выполнено: ${res.error.message}`);
      return this.goNext(m.id, 'review');
    }
    this.patch(m.id, { review: JSON.stringify({ ...this.reviewOf(this.row(m.id)), independent: res.output as unknown as ReviewerOutput }) });
    return this.goNext(m.id, 'review');
  }

  private reviewBlocking(m: MissionRow): string[] {
    const r = this.reviewOf(m);
    const out: string[] = [];
    if (r.independent?.verdict === 'needs_changes') {
      out.push(...r.independent.distortions.map((d) => `искажение задачи: ${d}`));
      out.push(...r.independent.defects.filter((d) => d.severity !== 'minor').map((d) => d.description));
      if (!out.length) out.push('ревьюер потребовал доработки');
    }
    if (r.security?.verdict === 'block') out.push(...r.security.risks.filter((x) => x.severity === 'critical' || x.severity === 'high').map((x) => `безопасность: ${x.description}`));
    return out;
  }

  /** Stage 9: honest summary, one useful report, and the explicit decision to apply changes (if allowed at all). */
  private async phaseSummary(m: MissionRow): Promise<'continue' | 'wait'> {
    const n = this.normalizedOf(m);
    let criteria = this.criteriaOf(m);
    const review = this.reviewOf(m);
    if (m.mode === 'plan' || criteria.some((c) => c.status === 'pending')) {
      const ctx = { mode: m.mode, checks: [], checksNotRun: review.checksNotRun ?? [], artifacts: this.artifacts(m), verifiedClaims: 0, verifiedDomains: 0, verifiedEvidence: 0, changesOnlyProposed: false };
      criteria = criteria.map((c) => (c.status === 'pending' || m.mode === 'plan' ? guardCriteria([c], null, ctx)[0]! : c));
      if (m.mode === 'execute' && criteria.some((c) => c.decidedBy === 'guard' && c.notes.includes('не оценил'))) this.addLimitation(m.id, 'Часть критериев не проверялась: этап проверки не выполнен.');
      this.patch(m.id, { criteria: JSON.stringify(criteria) });
    }
    const cur = this.row(m.id);
    const execSteps = this.currentExecSteps(m.id);
    const failedSteps = execSteps.filter((s) => s.status === 'failed' || s.status === 'cancelled').map((s) => `${s.plan_step} «${s.title}»`);
    const skippedByUser = execSteps.filter((s) => s.status === 'skipped' && (s.error ?? '').includes('пропущен пользователем')).map((s) => `${s.plan_step} «${s.title}»`);
    const limitations = [...this.limitationsOf(cur), ...skippedByUser.map((s) => `этап ${s} пропущен по решению пользователя`)];
    const status = finalStatus(criteria, { mode: m.mode, failedSteps: [...failedSteps, ...skippedByUser], skippedSteps: [], limitations, reviewBlocking: this.reviewBlocking(cur), planProduced: this.planOf(cur).length > 0 });
    const set = this.openSet(m.id);
    const allSets = this.missionSets(m.id);
    const files: MissionSummary['files'] = allSets.flatMap((s) => s.files.map((f) => ({ path: f.path, source: f.sourceName, op: f.op, status: s.status === 'proposed' ? (f.status === 'skipped' ? 'отклонено' : 'предложено (не применено)') : f.status === 'applied' ? 'применено к проекту' : f.status })));
    const artifacts = this.artifacts(cur);
    const documents = artifacts.filter((x) => x.type === 'document' && x.path).map((x) => ({ title: x.title, path: x.path!, docId: x.ref }));
    const ctx = this.contextOf(cur);
    const research = this.researchOf(cur);
    const studied = [
      ...ctx.projects.map((p) => `проект «${p.name}» (${modeLabel(p.accessMode)})`),
      ...(ctx.local ? [`документы: ${ctx.local.evidence.length} свидетельств, подтверждено цитатами ${ctx.local.evidence.filter((e) => e.verified).length}`] : []),
      ...(ctx.crossSystem.length ? [`другие системы: ${uniq(ctx.crossSystem.map((h) => h.systemName)).join(', ')} (${ctx.crossSystem.length} документов)`] : []),
      ...(research.web ? [`внешние источники: ${research.web.sources.length}, подтверждено утверждений ${research.verified} из ${research.claims.length}`] : []),
    ];
    const checks = review.lastVerification ? this.checkRecords(m.id).filter((c) => (c.evidence as { stepId?: string } | null)?.stepId === review.lastVerification && c.kind === 'command' && ['passed', 'failed', 'timeout'].includes(c.status)) : [];
    const nextSteps: string[] = [];
    const policy = this.policyOf(cur);
    const applicable = set ? set.gates.filter((g) => g.modeAllows) : [];
    if (set && !applicable.length) nextSteps.push(`Изменения подготовлены в наборе «${set.title}» (${set.summary.files} файлов) и не применены. Чтобы перенести их в проект, откройте «Проверить изменения»; применение возможно только в режиме «Применить к исходному проекту», который включает пользователь.`);
    for (const c of criteria.filter((x) => x.status === 'unverifiable' && x.verification === 'manual')) nextSteps.push(`Подтвердите вручную критерий ${c.id}: «${c.text}».`);
    for (const f of failedSteps) nextSteps.push(`Повторите этап ${f} (кнопка «Повторить»).`);
    for (const x of review.checksNotRun ?? []) if (x.reason.includes('не подтверждён')) nextSteps.push(`Разрешите запуск проверки ${x.name} и повторите проверку.`);
    const stepsDone = execSteps.filter((s) => s.status === 'completed').map((s) => {
      const o = parseJson<Record<string, unknown>>(s.output, {});
      return { title: `${s.plan_step} ${s.title}`, summary: String(o.summary ?? o.note ?? (Array.isArray(o.findings) ? `${o.findings.length} находок` : Array.isArray(o.evidence) ? `${o.evidence.length} свидетельств` : 'выполнено')) };
    });
    const resultsLocation = [...documents.map((d) => `документ ${d.path}`), ...allSets.filter((s) => s.summary.files > 0).map((s) => `набор изменений «${s.title}» (${s.status === 'proposed' ? 'не применён' : s.status})`)];
    let summary = buildSummary({ originalRequest: cur.original_request, normalized: n, strategy: parseJson<Strategy | null>(cur.strategy, null), plan: this.planOf(cur), stepsDone, studied, files, documents, checks, checksNotRun: review.checksNotRun ?? [], limitations, criteria, status, resultsLocation, nextSteps });
    // changes reach a project only by an explicit decision, and only where the user enabled «Применить» (29.2)
    if (set && applicable.length && !review.apply && m.mode === 'execute') {
      this.patch(m.id, { summary: JSON.stringify(summary) });
      this.ask(m.id, 'apply_changes', 'Применить изменения к исходному проекту?', `Подготовлено ${set.summary.files} файлов (+${set.summary.added} −${set.summary.removed}). Итог проверки: ${MISSION_STATUS_LABELS[status.status]}. Перед записью будут проверены режим, актуальность просмотра и проверок, риски; будет создана проверенная резервная копия.`, { changeSetId: set.id, contentHash: set.review.contentHash, files: set.files.map((f) => ({ id: f.id, source: f.sourceName, path: f.path, op: f.op, added: f.added, removed: f.removed, categories: f.categories })), risks: set.risks, gates: set.gates, outcome: status }, 'summary');
      return 'wait';
    }
    // one useful report, not a pile of them (28.5 stage 9)
    const documenterDoc = this.stepRows(m.id).some((s) => s.role === 'documenter' && parseJson<SideEffect[]>(s.side_effects, []).some((x) => x.tool === 'documenter.save'));
    const wantReport = policy.saveReport === 'always' || (policy.saveReport === 'auto' && !documenterDoc && (m.mode === 'plan' || (n && REPORT_TASK_TYPES.includes(n.task_type)) || n?.complexity === 'complex'));
    if (wantReport) {
      const docId = await this.saveReport(this.row(m.id), summary);
      if (docId) summary = { ...summary, resultsLocation: [`отчёт ${this.rt.db.get<{ rel_path: string }>('SELECT rel_path FROM documents WHERE id = ?', docId)?.rel_path ?? docId}`, ...summary.resultsLocation] };
    }
    this.patch(m.id, { summary: JSON.stringify(summary) });
    this.event(m.id, null, status.status === 'completed' ? 'info' : 'warn', 'mission.summary', `${MISSION_STATUS_LABELS[status.status]}: ${status.reason}`);
    this.setStatus(m.id, status.status, { phase: 'done', reason: status.reason, pending: null });
    this.rt.audit.record({ actor: 'system', action: 'mission.finish', target: cur.key, outcome: status.status === 'failed' ? 'error' : 'ok', details: { status: status.status, reason: status.reason } });
    return 'wait';
  }

  /** One report per mission: created once, then updated in place when the summary is recomputed. */
  private async saveReport(m: MissionRow, s: MissionSummary): Promise<string | null> {
    const vault = this.rt.db.get<{ writable: number }>('SELECT writable FROM sources WHERE id = ?', this.rt.primaryVaultId());
    if (!vault?.writable) {
      this.addLimitation(m.id, 'Отчёт не сохранён: хранилище системы открыто только для чтения.');
      return null;
    }
    try {
      const md = summaryMarkdown({ key: m.key, title: m.title, originalRequest: m.original_request, mode: m.mode, plan: this.planOf(m), options: parseJson<SolutionOption[]>(m.options, []), strategy: parseJson<Strategy | null>(m.strategy, null), runId: m.id }, s);
      const existing = this.rt.db.get<{ doc_id: string }>("SELECT doc_id FROM doc_properties WHERE key = 'mission_report' AND value_text = ?", m.id);
      if (existing) {
        const doc = await this.deps.docs.get(existing.doc_id);
        const content = md.replace(/^---\n/, `---\nmission_report: ${m.id}\n`);
        if (doc.content !== content) await this.deps.docs.save(existing.doc_id, content, doc.hash, `mission:${m.key}`);
        this.patch(m.id, { report_doc_id: existing.doc_id });
        this.event(m.id, null, 'info', 'report.updated', `Отчёт обновлён: ${doc.relPath}`, { docId: doc.id });
        return existing.doc_id;
      }
      const d = await this.deps.docs.create({ title: `${m.key}. ${clip(m.title, 150)}`, folder: MISSION_FOLDER, content: md, properties: { mission_report: m.id }, actor: `mission:${m.key}` });
      this.patch(m.id, { report_doc_id: d.id });
      this.event(m.id, null, 'info', 'report.saved', `Отчёт сохранён: ${d.relPath}`, { docId: d.id });
      return d.id;
    } catch (e) {
      this.addLimitation(m.id, `Отчёт не сохранён: ${toAppError(e).message}`);
      return null;
    }
  }

  // ============================================================================================ user decisions

  private requirePending(m: MissionRow, pendingId?: string): PendingApproval {
    const p = this.pendingOf(m);
    if (!p) throw new AppError('INVALID_STATE_TRANSITION', 'Поручение не ожидает решения.');
    if (pendingId && pendingId !== p.id) throw new AppError('INVALID_STATE_TRANSITION', 'Решение относится к устаревшему вопросу — обновите экран.');
    if (m.status === 'paused') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение приостановлено — сначала продолжите его.');
    return p;
  }

  /** Clears the question and continues from `phase` (working status for that phase). */
  private continueAt(id: string, phase: MissionPhase, reason: string | null = null): void {
    this.setStatus(id, statusForPhase(phase), { phase, pending: null, reason, error: null });
    this.kick(id);
  }

  async decide(id: string, d: MissionDecision & { pendingId?: string; confirmRisks?: string[]; contentHash?: string; approvedScripts?: Record<string, string> }, actor = 'user'): Promise<MissionView> {
    const m = this.row(id);
    const p = this.requirePending(m, d.pendingId);
    const allowed: Record<ApprovalKind, MissionDecision['decision'][]> = {
      setup_agents: ['approve', 'reject'],
      model: ['retry', 'reject'],
      budget: ['retry', 'reject'],
      questions: ['approve', 'revise', 'reject'],
      strategy: ['approve', 'revise', 'reject'],
      plan: ['approve', 'revise', 'reject'],
      conflict: ['approve', 'reject', 'revise'],
      error: ['retry', 'skip', 'reject'],
      apply_changes: ['apply', 'skip'],
    };
    if (!allowed[p.kind].includes(d.decision)) throw new AppError('VALIDATION_FAILED', `Для вопроса «${p.title}» допустимо: ${allowed[p.kind].join(', ')}.`);
    const comment = (d.comment ?? '').trim().slice(0, 10_000);
    if (d.decision === 'revise' && !comment) throw new AppError('VALIDATION_FAILED', 'Опишите, что нужно изменить.');
    this.message(m.id, 'user', comment || d.decision, { kind: 'decision', pendingId: p.id, approval: p.kind, decision: d.decision });
    this.rt.audit.record({ actor, action: 'mission.decision', target: m.key, details: { kind: p.kind, decision: d.decision, comment: comment || null } });
    this.event(m.id, null, 'info', 'mission.decision', `Решение пользователя (${p.title}): ${d.decision}${comment ? ` — ${clip(comment, 200)}` : ''}`);
    if (d.decision === 'reject' && p.kind !== 'conflict') {
      await this.cancel(m.id, actor, `Отклонено пользователем на шаге «${p.title}». Промежуточные результаты сохранены.`);
      return this.get(m.id);
    }
    switch (p.kind) {
      case 'setup_agents':
        await this.setupAgents(actor);
        this.continueAt(m.id, p.resumePhase);
        break;
      case 'model':
      case 'budget':
        this.retryFailedSteps(m.id, p);
        this.continueAt(m.id, p.resumePhase);
        break;
      case 'questions': {
        const questions = ((p.data.questions as { text: string }[] | undefined) ?? []).map((q) => q.text);
        if (d.decision === 'approve') {
          const answers = (d.answers ?? []).filter((x) => x && typeof x.question === 'string' && typeof x.answer === 'string' && x.answer.trim());
          const missing = questions.filter((q) => !answers.some((x) => x.question.trim() === q.trim()));
          if (missing.length) throw new AppError('VALIDATION_FAILED', `Ответьте на вопросы: ${missing.slice(0, 3).join('; ')}`, { details: { missing } });
          for (const x of answers) this.message(m.id, 'user', x.answer.slice(0, 5000), { kind: 'answer', question: x.question.slice(0, 1000) });
        } else this.message(m.id, 'user', comment, { kind: 'feedback', target: 'analysis' });
        this.continueAt(m.id, 'analysis');
        break;
      }
      case 'strategy':
        if (d.decision === 'revise') {
          this.message(m.id, 'user', comment, { kind: 'feedback', target: 'strategy' });
          this.continueAt(m.id, 'strategy');
        } else {
          if (d.optionId) this.chooseOption(m.id, d.optionId, actor);
          this.continueAt(m.id, 'planning');
        }
        break;
      case 'plan':
        if (d.decision === 'revise') {
          this.message(m.id, 'user', comment, { kind: 'feedback', target: 'plan' });
          this.continueAt(m.id, 'planning');
        } else {
          this.approveChecks(m.id, d.approvedChecks ?? [], (p.data.checks as { sourceId: string; name: string }[] | undefined) ?? [], actor);
          this.continueAt(m.id, 'execution');
        }
        break;
      case 'conflict': {
        const reqId = p.data.requirementId as string | null;
        if (d.decision === 'reject' && reqId) {
          const cur = this.row(m.id);
          this.patch(m.id, { extra_requirements: JSON.stringify(this.extrasOf(cur).filter((x) => x.id !== reqId)), revision: cur.revision + 1 });
          const n = this.normalizedOf(cur);
          if (n) this.patch(m.id, { normalized: JSON.stringify({ ...n, requirements: n.requirements.filter((r) => r.id !== reqId), constraints: n.constraints.filter((c) => c !== p.data.requirement) }) });
          this.message(m.id, 'user', `Новое требование ${reqId} отменено пользователем; прежние требования сохраняются.`, { kind: 'conflict_resolution' });
        } else {
          this.message(m.id, 'user', d.decision === 'revise' ? `Разрешение конфликта от пользователя: ${comment}` : `Пользователь подтвердил: новое требование ${reqId ?? ''} имеет приоритет над противоречащими прежними.`, { kind: 'conflict_resolution' });
        }
        this.continueAt(m.id, 'planning');
        break;
      }
      case 'error':
        if (d.decision === 'retry') this.retryFailedSteps(m.id, p);
        else this.skipFailedSteps(m.id, p);
        this.continueAt(m.id, p.resumePhase);
        break;
      case 'apply_changes':
        if (d.decision === 'apply') await this.applyChanges(m.id, p, { actor, confirmRisks: d.confirmRisks ?? [], contentHash: d.contentHash, approvedScripts: d.approvedScripts });
        else {
          const cur = this.row(m.id);
          this.patch(m.id, { review: JSON.stringify({ ...this.reviewOf(cur), apply: { decision: 'skipped', changeSetId: String(p.data.changeSetId), at: nowIso() } }) });
          this.addLimitation(m.id, 'Изменения не применены к исходному проекту по решению пользователя; набор изменений сохранён для просмотра.');
        }
        this.setStatus(m.id, 'verifying', { phase: 'summary', pending: null });
        this.kick(m.id);
        break;
    }
    return this.get(m.id);
  }

  private retryFailedSteps(id: string, p: PendingApproval): void {
    const ids = (p.data.stepIds as string[] | undefined) ?? (p.data.stepId ? [String(p.data.stepId)] : []);
    for (const sid of ids) {
      const s = this.rt.db.get<StepRow>('SELECT * FROM mission_steps WHERE id = ? AND mission_id = ?', sid, id);
      if (s && (s.status === 'failed' || s.status === 'cancelled')) this.patchStep(s.id, { status: 'pending', error: null, finished_at: null });
    }
    this.patch(id, { error: null });
  }

  private skipFailedSteps(id: string, p: PendingApproval): void {
    const ids = (p.data.stepIds as string[] | undefined) ?? (p.data.stepId ? [String(p.data.stepId)] : []);
    for (const sid of ids) {
      const s = this.rt.db.get<StepRow>('SELECT * FROM mission_steps WHERE id = ? AND mission_id = ?', sid, id);
      if (s && (s.status === 'failed' || s.status === 'cancelled')) {
        this.patchStep(s.id, { status: 'skipped', finished_at: nowIso(), error: JSON.stringify({ code: 'CANCELLED', message: 'Этап пропущен пользователем.', hint: '' }) });
        this.addLimitation(id, `Этап «${s.title}» пропущен по решению пользователя.`);
      }
    }
    // a non-step phase error: the phase is skipped explicitly (e.g. planning cannot be skipped — it is retried)
    if (!ids.length && p.resumePhase !== 'planning' && p.resumePhase !== 'analysis') {
      this.addLimitation(id, `Этап «${PHASE_LABELS[p.resumePhase]}» пропущен по решению пользователя.`);
      const m = this.row(id);
      this.patch(id, { phase: this.nextPhase(m, p.resumePhase) });
      p.resumePhase = this.nextPhase(m, p.resumePhase);
    }
  }

  /** Checks approved by the user for this mission; risky scripts are bound to the content the user inspected. */
  private approveChecks(id: string, list: { sourceId: string; name: string; contentHash?: string | null }[], offered: { sourceId: string; name: string }[], actor: string): void {
    const m = this.row(id);
    const current = this.approvedChecksOf(m);
    for (const c of list) {
      if (!projectChecks(this.rt, c.sourceId).some((d) => d.name === c.name)) throw new AppError('CHECK_NOT_DEFINED', `Проверка «${c.name}» не задана для проекта.`);
      if (!offered.some((o) => o.sourceId === c.sourceId && o.name === c.name) && !current.some((o) => o.sourceId === c.sourceId && o.name === c.name)) {
        // approving a check that was not offered is allowed (user knows the project), still logged
      }
      const i = current.findIndex((x) => x.sourceId === c.sourceId && x.name === c.name);
      const entry = { sourceId: c.sourceId, name: c.name, ...(c.contentHash ? { contentHash: c.contentHash } : {}) };
      if (i >= 0) current[i] = entry;
      else current.push(entry);
    }
    this.patch(id, { approved_checks: JSON.stringify(current) });
    const a = this.active.get(id);
    if (a) a.scope.approvedChecks = current;
    if (list.length) this.rt.security.record({ actor, action: 'checks.approve', outcome: 'ok', taskId: id, resources: list.map((c) => `${c.sourceId}:${c.name}`), message: `Разрешён запуск проверок в рабочей копии для поручения ${m.key}: ${list.map((c) => c.name).join(', ')}` });
  }

  /** «Применить»: review of exactly this content → checks in a work copy → all gates of ChangeSetService.apply. */
  private async applyChanges(id: string, p: PendingApproval, o: { actor: string; confirmRisks: string[]; contentHash?: string | undefined; approvedScripts?: Record<string, string> | undefined }): Promise<void> {
    const m = this.row(id);
    const setId = String(p.data.changeSetId);
    const set = this.deps.changes.get(setId, { withDiff: false });
    const seenHash = o.contentHash ?? (p.data.contentHash as string | null);
    if (seenHash && set.review.contentHash !== seenHash) {
      this.patch(id, { pending: JSON.stringify({ ...p, data: { ...p.data, contentHash: set.review.contentHash, files: set.files.map((f) => ({ id: f.id, source: f.sourceName, path: f.path, op: f.op })) } }) });
      throw new AppError('REVIEW_STALE', 'Набор изменений изменился после того, как вы его просмотрели. Просмотрите изменения снова.');
    }
    if (!set.review.reviewed) this.deps.changes.review(setId, o.actor);
    const needsChecks = set.gates.some((g) => g.kind === 'project' && g.checksConfigured.length && !g.checksPassed);
    if (needsChecks) {
      const scripts: Record<string, string> = { ...(o.approvedScripts ?? {}) };
      for (const c of this.approvedChecksOf(m)) if (c.contentHash && !scripts[`${c.sourceId}:${c.name}`]) scripts[`${c.sourceId}:${c.name}`] = c.contentHash;
      await this.deps.changes.verifyInWorkCopy(setId, { actor: o.actor, approvedScripts: scripts });
    }
    const res = await this.deps.changes.apply(setId, { actor: o.actor, confirmRisks: o.confirmRisks });
    const cur = this.row(id);
    this.patch(id, { review: JSON.stringify({ ...this.reviewOf(cur), apply: { decision: 'applied', changeSetId: setId, at: nowIso(), result: res.status } }) });
    this.event(id, null, res.status === 'applied' ? 'info' : 'warn', 'changes.applied', res.status === 'applied' ? `Изменения применены к исходному проекту (${res.files.filter((f) => f.status === 'applied').length} файлов); создана резервная копия` : `Изменения применены частично (${res.status}) — подробности в наборе изменений`, { changeSetId: setId, status: res.status, backupId: res.backupId });
    if (res.status !== 'applied') this.addLimitation(id, `Применение изменений: ${res.status === 'partially_applied' ? 'частично' : res.status}. Неприменённые файлы перечислены в наборе изменений.`);
  }

  // ============================================================================================ intervention (28.13)

  async pause(id: string, actor = 'user'): Promise<MissionView> {
    const m = this.row(id);
    if (!WORKING_STATUSES.includes(m.status) && m.status !== 'awaiting_approval' && m.status !== 'needs_input') throw new AppError('INVALID_STATE_TRANSITION', 'Приостановить можно только выполняющееся поручение.');
    this.setStatus(m.id, 'paused', { reason: 'Приостановлено пользователем. Выполняющиеся этапы завершатся, новые не начнутся.' });
    this.rt.audit.record({ actor, action: 'mission.pause', target: m.key });
    return this.get(m.id);
  }

  async resume(id: string, actor = 'user'): Promise<MissionView> {
    const m = this.row(id);
    if (m.status !== 'paused' && m.status !== 'needs_input') throw new AppError('INVALID_STATE_TRANSITION', 'Продолжить можно приостановленное поручение.');
    const p = this.pendingOf(m);
    if (m.status === 'needs_input' && p) throw new AppError('INVALID_STATE_TRANSITION', `Поручение ждёт решения: «${p.title}».`);
    // steps of a live driver keep running; steps orphaned by a crash: read-only ones continue, the others wait for «Повторить»
    const live = this.active.get(m.id);
    if (!live?.driving || live.controller.signal.aborted) for (const s of this.stepRows(m.id).filter((x) => x.status === 'running')) this.interruptStep(s, 'Прервано.');
    const interrupted = this.stepRows(m.id).filter((s) => s.status === 'failed' && (s.error ?? '').includes('автоматически он не повторяется'));
    this.rt.audit.record({ actor, action: 'mission.resume', target: m.key });
    if (p) {
      this.setStatus(m.id, p.kind === 'plan' || p.kind === 'strategy' || p.kind === 'apply_changes' ? 'awaiting_approval' : 'needs_input', { reason: p.title });
      return this.get(m.id);
    }
    if (interrupted.length) {
      this.setStatus(m.id, statusForPhase(m.phase), { reason: null });
      this.ask(m.id, 'error', 'Этап был прерван', `Этапы ${interrupted.map((s) => `«${s.title}»`).join(', ')} могли частично выполнить действия. Проверьте результаты и повторите или пропустите их.`, { stepIds: interrupted.map((s) => s.id) }, m.phase, 'needs_input');
      return this.get(m.id);
    }
    const a = this.active.get(m.id);
    if (a?.controller.signal.aborted) this.active.delete(m.id);
    this.setStatus(m.id, statusForPhase(m.phase === 'done' ? 'summary' : m.phase), { reason: null });
    this.kick(m.id);
    return this.get(m.id);
  }

  async cancel(id: string, actor = 'user', reason = 'Отменено пользователем. Промежуточные результаты сохранены.'): Promise<MissionView> {
    const m = this.row(id);
    if (TERMINAL_STATUSES.includes(m.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Поручение уже завершено.');
    this.setStatus(m.id, 'cancelled', { reason, pending: null });
    const a = this.active.get(m.id);
    if (a) {
      a.abortReason = 'cancel';
      a.controller.abort();
      if (a.driving) await Promise.race([a.driving, new Promise((r) => setTimeout(r, 5000))]);
      this.active.delete(m.id);
    }
    this.rt.db.run("UPDATE mission_steps SET status = 'cancelled', finished_at = ?, updated_at = ? WHERE mission_id = ? AND status IN ('pending','running','waiting_for_approval')", nowIso(), nowIso(), m.id);
    this.rt.audit.record({ actor, action: 'mission.cancel', target: m.key, details: { reason } });
    return this.get(m.id);
  }

  /** «Добавить требование» / «Уточнить критерии» / constraint: affected parts of the plan are recalculated (28.13). */
  addRequirement(id: string, input: { text: string; kind?: 'requirement' | 'criterion' | 'constraint'; verification?: CriterionVerification }, actor = 'user'): MissionView {
    const m = this.row(id);
    if (m.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение отменено.');
    const text = String(input.text ?? '').trim();
    if (text.length < 3 || text.length > 2000) throw new AppError('VALIDATION_FAILED', 'Требование: от 3 до 2000 символов.');
    const kind = input.kind ?? 'requirement';
    if (!['requirement', 'criterion', 'constraint'].includes(kind)) throw new AppError('VALIDATION_FAILED', 'Вид: requirement, criterion или constraint.');
    const extras = this.extrasOf(m);
    const rid = kind === 'criterion' ? `UC${extras.filter((x) => x.kind === 'criterion').length + 1}` : `U${extras.filter((x) => x.kind !== 'criterion' && x.kind !== 'option').length + 1}`;
    extras.push({ id: rid, text, kind, addedAt: nowIso() });
    const n = this.normalizedOf(m);
    const p: Partial<Record<keyof MissionRow, string | number | null>> = { extra_requirements: JSON.stringify(extras), revision: m.revision + 1 };
    if (kind === 'criterion') {
      const verification = input.verification ?? 'review';
      if (!['artifact_exists', 'check_command', 'review', 'source_verification', 'manual'].includes(verification)) throw new AppError('VALIDATION_FAILED', 'Способ проверки критерия неизвестен.');
      p.criteria = JSON.stringify([...this.criteriaOf(m), { id: rid, text, verification, status: 'pending', evidence: '', notes: '', decidedBy: null, source: 'user' } satisfies Criterion]);
    } else if (n) {
      p.normalized = JSON.stringify(kind === 'constraint' ? { ...n, constraints: [...n.constraints, text] } : { ...n, requirements: [...n.requirements, { id: rid, text, source: 'user' }] });
    }
    const hasPlan = !!m.plan && this.planOf(m).length > 0;
    if (kind !== 'criterion' && hasPlan) p.plan_stale = Math.max(1, m.plan_stale);
    this.patch(m.id, p);
    this.message(m.id, 'user', text, { kind: 'requirement', id: rid, type: kind });
    this.rt.audit.record({ actor, action: 'mission.requirement', target: m.key, details: { id: rid, kind } });
    this.event(m.id, null, 'info', 'mission.requirement', `Добавлено ${kind === 'criterion' ? 'критерий' : kind === 'constraint' ? 'ограничение' : 'требование'} ${rid}: ${clip(text, 200)}${kind !== 'criterion' && hasPlan ? ' — план будет пересчитан, выполненные этапы сохраняются' : ''}`);
    this.afterChange(m.id, kind === 'criterion' ? 'verification' : hasPlan ? 'planning' : null);
    return this.get(m.id);
  }

  /**
   * After a change by the user: a waiting plan/strategy question is outdated → re-plan; a finished mission continues
   * only because the user explicitly changed it.
   */
  private afterChange(id: string, redo: MissionPhase | null): void {
    const m = this.row(id);
    const p = this.pendingOf(m);
    if (!redo) return;
    if (m.status === 'awaiting_approval' && p && (p.kind === 'plan' || p.kind === 'strategy' || p.kind === 'apply_changes')) {
      if (p.kind === 'apply_changes' && redo === 'verification') {
        this.continueAt(id, 'verification');
        return;
      }
      this.continueAt(id, redo === 'verification' ? 'verification' : m.plan_stale === 2 ? 'strategy' : 'planning');
      return;
    }
    if (TERMINAL_STATUSES.includes(m.status) && m.status !== 'cancelled') {
      if (redo === 'verification' && m.mode === 'plan') return;
      this.continueAt(id, redo === 'verification' ? 'verification' : m.plan_stale === 2 ? 'strategy' : 'planning');
    }
    // working: the driver re-plans at the next safe boundary; paused / needs_input: on continue
  }

  /** «Уточнить критерии готовности»: the user's list replaces the current one; unchanged criteria keep their status. */
  updateCriteria(id: string, list: { id?: string; text: string; verification?: CriterionVerification }[], actor = 'user'): MissionView {
    const m = this.row(id);
    if (m.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение отменено.');
    if (!Array.isArray(list) || list.length > 50) throw new AppError('VALIDATION_FAILED', 'Критерии — список (до 50).');
    const prev = this.criteriaOf(m);
    const used = new Set<string>();
    const next: Criterion[] = list.map((c, i) => {
      const text = String(c.text ?? '').trim();
      if (text.length < 3) throw new AppError('VALIDATION_FAILED', `Критерий №${i + 1} пустой.`);
      const verification = c.verification ?? prev.find((p) => p.id === c.id)?.verification ?? 'review';
      if (!['artifact_exists', 'check_command', 'review', 'source_verification', 'manual'].includes(verification)) throw new AppError('VALIDATION_FAILED', `Критерий №${i + 1}: неизвестный способ проверки.`);
      let cid = c.id && /^[A-Za-z0-9_-]{1,20}$/.test(c.id) ? c.id : `UC${i + 1}`;
      while (used.has(cid)) cid = `${cid}x`;
      used.add(cid);
      const old = prev.find((p) => p.id === cid && p.text === text && p.verification === verification);
      return old ?? { id: cid, text, verification, status: 'pending', evidence: '', notes: '', decidedBy: null, source: 'user' };
    });
    this.patch(m.id, { criteria: JSON.stringify(next), revision: m.revision + 1 });
    this.rt.audit.record({ actor, action: 'mission.criteria', target: m.key, details: { count: next.length } });
    this.event(m.id, null, 'info', 'mission.criteria', `Критерии готовности обновлены пользователем (${next.length})`);
    if (next.some((c) => c.status === 'pending') && this.row(m.id).phase !== 'analysis') this.afterChange(m.id, 'verification');
    return this.get(m.id);
  }

  /** «Изменить план»: the user's plan is validated by the same rules as the planner's. */
  updatePlan(id: string, steps: PlanStep[], actor = 'user'): MissionView {
    const m = this.row(id);
    if (TERMINAL_STATUSES.includes(m.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Поручение завершено — добавьте требование, чтобы продолжить.');
    if (!Array.isArray(steps)) throw new AppError('VALIDATION_FAILED', 'План — список шагов.');
    const norm: PlanStep[] = steps.map((s) => ({ id: String(s.id), title: String(s.title ?? '').slice(0, 300), goal: String(s.goal ?? s.title ?? '').slice(0, 2000), role: s.role, inputs: (s.inputs ?? []).map(String), expected_output: String(s.expected_output ?? ''), depends_on: (s.depends_on ?? []).map(String), tools: (s.tools ?? []).map(String), done_criteria: (s.done_criteria ?? []).map(String), verification: String(s.verification ?? ''), risk: (['low', 'medium', 'high'].includes(s.risk) ? s.risk : 'medium') as PlanStep['risk'], keep_existing: s.keep_existing !== false }));
    for (const s of norm) if (!(s.role in ROLE_AGENTS)) throw new AppError('VALIDATION_FAILED', `${s.id}: неизвестная роль «${s.role}».`);
    const check = validatePlan(norm, { mode: m.mode, availableRoles: this.availableRoles(), completed: new Set(this.currentExecSteps(m.id).filter((s) => s.status === 'completed').map((s) => s.plan_step!)) });
    if (check.errors.length) throw new AppError('VALIDATION_FAILED', check.errors.join('; '), { details: check });
    this.installPlan(m, check.steps);
    this.rt.audit.record({ actor, action: 'mission.plan.edit', target: m.key, details: { steps: check.steps.length } });
    this.event(m.id, null, 'info', 'plan.edited', `План изменён пользователем (${check.steps.length} шагов)`, { warnings: check.warnings });
    const cur = this.row(m.id);
    const p = this.pendingOf(cur);
    if (p?.kind === 'plan') this.patch(m.id, { pending: JSON.stringify({ ...p, data: { ...p.data, plan: check.steps, warnings: check.warnings } }) });
    return this.get(m.id);
  }

  /** «Попросить исследовать дополнительный вариант». */
  researchOption(id: string, text: string, actor = 'user'): MissionView {
    const m = this.row(id);
    if (m.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение отменено.');
    const t = String(text ?? '').trim();
    if (t.length < 3 || t.length > 2000) throw new AppError('VALIDATION_FAILED', 'Опишите вариант (3–2000 символов).');
    const extras = this.extrasOf(m);
    extras.push({ id: `O${extras.filter((x) => x.kind === 'option').length + 1}`, text: t, kind: 'option', addedAt: nowIso() });
    this.patch(m.id, { extra_requirements: JSON.stringify(extras), plan_stale: 2, revision: m.revision + 1 });
    this.message(m.id, 'user', t, { kind: 'option' });
    this.rt.audit.record({ actor, action: 'mission.option', target: m.key });
    this.event(m.id, null, 'info', 'mission.option', `Пользователь попросил исследовать вариант: ${clip(t, 200)}`);
    const cur = this.row(m.id);
    if (['analyzing', 'researching'].includes(cur.status)) return this.get(m.id); // strategy has not run yet: it will include the option
    if (cur.status === 'planning' || cur.status === 'awaiting_approval' || TERMINAL_STATUSES.includes(cur.status)) this.continueAt(m.id, 'strategy');
    return this.get(m.id);
  }

  private chooseOption(id: string, optionId: string, actor: string): void {
    const m = this.row(id);
    const options = parseJson<SolutionOption[]>(m.options, []);
    const option = options.find((o) => o.id === optionId);
    if (!option) throw new AppError('NOT_FOUND', `Вариант ${optionId} не найден.`);
    const prev = parseJson<Strategy | null>(m.strategy, null);
    if (prev?.selected === optionId) return;
    const strategy: Strategy = { selected: option.id, option, rationale: `Выбрано пользователем${prev ? ` вместо варианта ${prev.selected}` : ''}.`, tradeoffs: option.cons, selectedBy: 'user' };
    this.patch(id, { strategy: JSON.stringify(strategy), plan_stale: m.plan ? 1 : 0, revision: m.revision + 1 });
    this.rt.audit.record({ actor, action: 'mission.strategy', target: m.key, details: { optionId } });
    this.event(id, null, 'info', 'strategy.user', `Пользователь выбрал вариант ${option.id} «${option.name}»`);
  }

  /** «Выбрать другой способ решения». */
  async selectStrategy(id: string, optionId: string, actor = 'user'): Promise<MissionView> {
    const m = this.row(id);
    if (m.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение отменено.');
    const p = this.pendingOf(m);
    if (p?.kind === 'strategy' && m.status !== 'paused') return this.decide(m.id, { decision: 'approve', optionId, pendingId: p.id }, actor);
    this.chooseOption(m.id, optionId, actor);
    this.afterChange(m.id, this.planOf(this.row(m.id)).length ? 'planning' : null);
    return this.get(m.id);
  }

  /** «Запретить инструмент»: applies immediately, including to steps that are already running. */
  denyTool(id: string, tool: string, actor = 'user'): MissionView {
    const m = this.row(id);
    if (!KNOWN_TOOLS.has(tool)) throw new AppError('VALIDATION_FAILED', `Неизвестный инструмент: ${tool}`);
    const policy = this.policyOf(m);
    if (!policy.deniedTools.includes(tool)) policy.deniedTools.push(tool);
    this.patch(m.id, { policy: JSON.stringify(policy) });
    const a = this.active.get(m.id);
    if (a) {
      a.scope.deniedTools ??= [];
      if (!a.scope.deniedTools.includes(tool)) a.scope.deniedTools.push(tool);
    }
    this.rt.audit.record({ actor, action: 'mission.deny_tool', target: m.key, details: { tool } });
    this.rt.security.record({ actor, action: 'tool.deny', outcome: 'ok', taskId: m.id, resources: [tool], message: `Инструмент ${tool} запрещён для поручения ${m.key}` });
    this.event(m.id, null, 'info', 'mission.deny_tool', `Инструмент ${tool} запрещён пользователем для этого поручения`);
    return this.get(m.id);
  }

  /** «Повторить неудачный этап». */
  retryStep(id: string, stepId: string, actor = 'user'): MissionView {
    const m = this.row(id);
    if (m.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение отменено.');
    const s = this.rt.db.get<StepRow>('SELECT * FROM mission_steps WHERE (id = ? OR plan_step = ?) AND mission_id = ? ORDER BY seq DESC LIMIT 1', stepId, stepId, m.id);
    if (!s) throw new AppError('NOT_FOUND', 'Этап не найден.');
    if (!['failed', 'cancelled', 'skipped'].includes(s.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Повторить можно только неудачный, отменённый или пропущенный этап.');
    if (WORKING_STATUSES.includes(m.status) && s.phase !== 'execution') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение выполняется — дождитесь паузы или ошибки.');
    this.patchStep(s.id, { status: 'pending', error: null, finished_at: null });
    this.rt.audit.record({ actor, action: 'mission.retry_step', target: m.key, details: { stepId: s.id } });
    this.event(m.id, s.id, 'info', 'step.retry', `Пользователь повторяет этап «${s.title}»`);
    if (WORKING_STATUSES.includes(m.status)) return this.get(m.id);
    if (m.status === 'paused') return this.get(m.id);
    const phase: MissionPhase = s.phase === 'execution' || s.phase === 'fix' ? 'execution' : s.phase;
    if (s.phase === 'execution') this.patch(m.id, { phase: 'execution' });
    this.continueAt(m.id, phase);
    return this.get(m.id);
  }

  /** «Повторить этап» for a whole phase (e.g. verification after the user fixed checks). */
  retryPhase(id: string, phase: MissionPhase, actor = 'user'): MissionView {
    const m = this.row(id);
    if (m.status === 'cancelled') throw new AppError('INVALID_STATE_TRANSITION', 'Поручение отменено.');
    if (!['analysis', 'context', 'research', 'strategy', 'planning', 'execution', 'verification', 'summary'].includes(phase)) throw new AppError('VALIDATION_FAILED', 'Неизвестный этап.');
    if (WORKING_STATUSES.includes(m.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Поручение выполняется.');
    if (m.mode === 'plan' && ['execution', 'verification'].includes(phase)) throw new AppError('VALIDATION_FAILED', 'В режиме «Исследовать и спланировать» нет выполнения.');
    // re-running a phase means a new revision: completed agent steps of the old revision are not reused for it
    this.patch(m.id, { revision: m.revision + 1, ...(phase === 'summary' ? { summary: null } : {}) });
    this.rt.audit.record({ actor, action: 'mission.retry_phase', target: m.key, details: { phase } });
    this.continueAt(m.id, phase, `повтор этапа «${PHASE_LABELS[phase]}» по решению пользователя`);
    return this.get(m.id);
  }

  /** Manual criteria are confirmed only by the user (28.16); a finished mission's status is recomputed. */
  confirmCriterion(id: string, criterionId: string, status: 'met' | 'partially_met' | 'not_met', evidence: string, actor = 'user'): MissionView {
    const m = this.row(id);
    if (!['met', 'partially_met', 'not_met'].includes(status)) throw new AppError('VALIDATION_FAILED', 'Статус: met, partially_met или not_met.');
    const ev = String(evidence ?? '').trim();
    if (status !== 'not_met' && ev.length < 3) throw new AppError('VALIDATION_FAILED', 'Укажите, чем подтверждается выполнение.');
    const criteria = this.criteriaOf(m);
    const c = criteria.find((x) => x.id === criterionId);
    if (!c) throw new AppError('NOT_FOUND', `Критерий ${criterionId} не найден.`);
    Object.assign(c, { status, evidence: ev, notes: `Подтверждено пользователем (${nowIso().slice(0, 16).replace('T', ' ')}).`, decidedBy: 'user' });
    this.patch(m.id, { criteria: JSON.stringify(criteria) });
    this.rt.audit.record({ actor, action: 'mission.criterion', target: m.key, details: { criterionId, status } });
    this.event(m.id, null, 'info', 'criterion.user', `Пользователь отметил критерий ${criterionId}: ${status}`);
    if (TERMINAL_STATUSES.includes(m.status) && m.status !== 'cancelled') {
      this.setStatus(m.id, 'verifying', { phase: 'summary', reason: 'пересчёт итога после решения пользователя' });
      this.kick(m.id);
    }
    return this.get(m.id);
  }

  updateLimits(id: string, patch: Partial<MissionLimits>, actor = 'user'): MissionView {
    const m = this.row(id);
    if (TERMINAL_STATUSES.includes(m.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Поручение завершено.');
    const limits = this.normalizeLimits(patch, this.limitsOf(m));
    this.patch(m.id, { limits: JSON.stringify(limits) });
    const a = this.active.get(m.id);
    if (a) Object.assign(a.budget.limits, { maxModelCalls: limits.maxModelCalls, maxTokens: limits.maxTokens, maxCostUsd: limits.maxCostUsd });
    this.rt.audit.record({ actor, action: 'mission.limits', target: m.key, details: patch });
    return this.get(m.id);
  }

  rename(id: string, title: string, actor = 'user'): MissionView {
    const m = this.row(id);
    const t = String(title ?? '').trim();
    if (t.length < 2 || t.length > 300) throw new AppError('VALIDATION_FAILED', 'Название: от 2 до 300 символов.');
    this.patch(m.id, { title: t });
    this.rt.audit.record({ actor, action: 'mission.rename', target: m.key });
    return this.get(m.id);
  }

  // ============================================================================================ discussion (28.2 / 28.12.7)

  private stateForAdvisor(m: MissionRow): Record<string, unknown> {
    const v = this.get(m.id);
    return {
      key: v.key,
      title: v.title,
      original_request: v.originalRequest,
      mode: v.mode,
      status: v.statusLabel,
      status_reason: v.statusReason,
      phase: v.phaseLabel,
      normalized: v.normalized ? { task_type: v.normalized.task_type, desired_outcome: v.normalized.desired_outcome, requirements: v.normalized.requirements, constraints: v.normalized.constraints, assumptions: v.normalized.assumptions } : null,
      criteria: v.criteria.map((c) => ({ id: c.id, text: c.text, status: c.status, evidence: clip(c.evidence, 300), notes: clip(c.notes, 300) })),
      options: v.options.map((o) => ({ id: o.id, name: o.name, kind: o.kind, pros: o.pros, cons: o.cons })),
      strategy: v.strategy ? { selected: v.strategy.selected, rationale: v.strategy.rationale, by: v.strategy.selectedBy } : null,
      plan: v.plan.map((p) => {
        const st = this.currentExecSteps(m.id).find((s) => s.plan_step === p.id);
        return { id: p.id, title: p.title, role: p.role, status: st?.status ?? 'pending', depends_on: p.depends_on };
      }),
      checks: v.checks.filter((c) => c.kind !== 'criterion').slice(-20).map((c) => ({ name: c.name, status: c.status, round: c.round })),
      limitations: v.limitations,
      artifacts: v.artifacts.map((x) => ({ type: x.type, title: x.title, status: x.status })),
      pending: v.pending ? { kind: v.pending.kind, title: v.pending.title, message: v.pending.message } : null,
      denied_tools: v.policy.deniedTools,
      recent_messages: this.messages(m.id).slice(-10).map((x) => ({ role: x.role, body: clip(x.body, 500) })),
    };
  }

  /** «Обсуждение задачи»: answers are grounded in the mission state; suggestions are applied only by the user. */
  async discuss(id: string, question: string, actor = 'user'): Promise<{ messageId: string; answer: AdvisorOutput }> {
    const m = this.row(id);
    const q = String(question ?? '').trim();
    if (q.length < 2 || q.length > 5000) throw new AppError('VALIDATION_FAILED', 'Вопрос: от 2 до 5000 символов.');
    if (!this.enabledAgents().has('mission-advisor')) throw new AppError('AGENT_NOT_ENABLED', 'Агент «Консультант поручения» не включён.', { hint: 'Подготовьте агентов поручений.' });
    this.message(m.id, 'user', q, { kind: 'question' });
    const { pkg, config } = await this.deps.agents.forRun('mission-advisor');
    const a = this.activate(m.id);
    const res = await this.deps.agentRuntime.run('mission-advisor', pkg, config, { question: q, mission_state: this.stateForAdvisor(m) }, { runId: m.id, scope: { ...a.scope, deniedTools: [...(a.scope.deniedTools ?? []), ...LOCAL_TOOLS, ...WEB_TOOLS] }, budget: a.budget, containsConfidential: this.scopeConfidential(m) });
    const out = res.output as unknown as AdvisorOutput;
    const messageId = this.message(m.id, 'advisor', out.answer, { references: out.references, suggested_actions: out.suggested_actions });
    this.rt.audit.record({ actor, action: 'mission.discuss', target: m.key });
    return { messageId, answer: out };
  }

  /** Applies one suggestion of the advisor — always an explicit user action. */
  async applySuggestion(id: string, messageId: string, index: number, actor = 'user'): Promise<MissionView> {
    const m = this.row(id);
    const msg = this.rt.db.get<{ data: string | null; role: string }>('SELECT data, role FROM mission_messages WHERE id = ? AND mission_id = ?', messageId, m.id);
    if (!msg || msg.role !== 'advisor') throw new AppError('NOT_FOUND', 'Сообщение консультанта не найдено.');
    const s = parseJson<{ suggested_actions?: AdvisorOutput['suggested_actions'] }>(msg.data, {}).suggested_actions?.[index];
    if (!s) throw new AppError('NOT_FOUND', 'Предложение не найдено.');
    switch (s.action) {
      case 'add_requirement':
        return this.addRequirement(m.id, { text: s.detail }, actor);
      case 'research_option':
        return this.researchOption(m.id, s.detail, actor);
      case 'deny_tool':
        return this.denyTool(m.id, s.detail.trim(), actor);
      case 'change_strategy': {
        const opts = parseJson<SolutionOption[]>(m.options, []);
        const o = opts.find((x) => x.id === s.detail.trim() || x.name.toLowerCase() === s.detail.trim().toLowerCase());
        if (!o) throw new AppError('NOT_FOUND', `Вариант «${s.detail}» не найден среди рассмотренных.`);
        return this.selectStrategy(m.id, o.id, actor);
      }
      case 'retry_step':
        return this.retryStep(m.id, s.detail.trim(), actor);
      default:
        throw new AppError('VALIDATION_FAILED', 'Это предложение не требует действия.');
    }
  }

  // ============================================================================================ agents & preflight

  /** Installs and enables the built-in mission agents — only as an explicit user action. */
  async setupAgents(actor = 'user'): Promise<{ installed: string[]; enabled: string[] }> {
    const catalog = appAI(this.rt.app).catalog;
    const installed: string[] = [];
    const enabled: string[] = [];
    for (const id of MISSION_AGENTS) {
      const row = this.rt.db.get<{ enabled: number }>('SELECT enabled FROM agents WHERE id = ?', id);
      if (!row) {
        const pkg = catalog.builtinPackage(id);
        if (!pkg) continue;
        await this.deps.agents.install({ id, scope: 'builtin', grants: pkg.manifest.permissions.map((p) => p.permission) });
        installed.push(id);
      }
      if (!row?.enabled) {
        await this.deps.agents.setEnabled(id, true);
        enabled.push(id);
      }
    }
    this.rt.audit.record({ actor, action: 'mission.setup_agents', target: 'missions', details: { installed, enabled } });
    return { installed, enabled };
  }

  /** «Перед выполнением оцени доступность моделей и необходимых инструментов» (28.15). */
  async preflight(input: { scope?: Partial<MissionScope>; mode?: 'plan' | 'execute' } = {}): Promise<MissionPreflight> {
    const scope = this.normalizeScope(input.scope);
    const mode = input.mode ?? 'execute';
    const problems: string[] = [];
    const warnings: string[] = [];
    const rows = new Map(this.rt.db.all<{ id: string; enabled: number }>('SELECT id, enabled FROM agents').map((r) => [r.id, r]));
    const ai = appAI(this.rt.app).ai;
    const fake = { scope: JSON.stringify(scope) } as MissionRow;
    const confidential = this.scopeConfidential(fake);
    const agents: MissionPreflight['agents'] = [];
    const roleOf = (id: string) => (Object.entries(ROLE_AGENTS).find(([, a]) => a === id)?.[0] ?? id);
    for (const id of MISSION_AGENTS) {
      const r = rows.get(id);
      let missing: PermissionId[] = [];
      let route: MissionPreflight['agents'][number]['route'] = null;
      let routeError: string | null = null;
      if (r) {
        try {
          const info = await this.deps.agents.get(id);
          const granted = new Set(info.grants.map((g) => g.permission));
          const needed = new Set<PermissionId>();
          for (const t of info.tools) for (const p of TOOL_PERMISSIONS[t] ?? []) needed.add(p);
          missing = [...needed].filter((p) => !granted.has(p));
          const rr = ai.preview({ rt: this.rt, policy: this.deps.agents.config(id).modelPolicy, taskType: info.taskType as never, containsConfidential: confidential, needsStructured: true });
          route = { providerId: rr.providerId, model: rr.model, locality: rr.locality };
        } catch (e) {
          routeError = toAppError(e).message;
        }
      }
      agents.push({ id, role: roleOf(id), installed: !!r, enabled: !!r?.enabled, missingGrants: missing, route, routeError });
      if (CORE_AGENTS.includes(id) && !r?.enabled) problems.push(`Агент «${id}» не ${r ? 'включён' : 'установлен'} — нажмите «Подготовить агентов».`);
      if (r?.enabled && routeError && CORE_AGENTS.includes(id)) problems.push(`${id}: ${routeError}`);
      if (r?.enabled && missing.length) warnings.push(`${id}: не выданы разрешения ${missing.join(', ')} — соответствующие инструменты будут отклонены.`);
    }
    if (agents.some((x) => x.route?.locality === 'cloud')) warnings.push('Часть этапов будет выполнена облачной моделью: содержимое выбранных материалов будет отправлено провайдеру.');
    if (agents.every((x) => !x.route || x.route.locality === 'local') && agents.some((x) => x.route)) warnings.push('Все этапы выполняются локальными моделями: данные не покидают компьютер.');
    if (confidential) warnings.push('В области поручения есть конфиденциальные источники: используются только локальные модели.');
    if (!scope.allowWeb) warnings.push('Веб-доступ не разрешён: внешние источники изучаться не будут (это будет указано в итоге).');
    const projects = (scope.kind === 'public' ? [] : this.deps.sources.list('project').filter((s) => !scope.sourceIds.length || scope.sourceIds.includes(s.id))).map((s) => ({ sourceId: s.id, name: s.name, accessMode: s.accessMode, accessModeLabel: modeLabel(s.accessMode), checks: s.checks.map((c) => c.name) }));
    if (mode === 'execute') {
      for (const p of projects) {
        if (p.accessMode === 'read_only') warnings.push(`Проект «${p.name}» в режиме «${p.accessModeLabel}»: изменения в нём подготовлены не будут.`);
        else if (p.accessMode === 'prepare') warnings.push(`Проект «${p.name}» в режиме «${p.accessModeLabel}»: изменения будут подготовлены, но проверки в рабочей копии не запустятся.`);
        if (!p.checks.length && p.accessMode !== 'read_only') warnings.push(`Для проекта «${p.name}» не заданы команды проверки — корректность изменений не будет подтверждена автоматически.`);
      }
    }
    return { ok: problems.length === 0, aiMode: String(this.rt.settings.get<string>('ai.mode') ?? 'local'), offline: !!this.rt.app.appSettings.get<boolean>('net.offline'), agents, projects, problems, warnings };
  }

  /** What a check would execute in the current work copy (shown before approval in the plan dialog). */
  async inspectMissionCheck(id: string, sourceId: string, name: string): Promise<{ command: string; autoRun: boolean; findings: unknown[]; contentHash: string; notes: string[] }> {
    const m = this.row(id);
    const set = this.openSet(m.id);
    let root: string;
    if (set && set.files.some((f) => f.sourceId === sourceId)) root = (await this.deps.changes.applyToWorkCopy(set.id, sourceId, 'user')).rootPath;
    else root = this.deps.sources.get(sourceId).rootPath;
    const { def, vetting } = await inspectCheck(this.rt, sourceId, name, root);
    return { command: [def.program, ...def.args].join(' '), autoRun: vetting.autoRun, findings: vetting.findings, contentHash: vetting.contentHash, notes: vetting.notes };
  }

  // ============================================================================================ lifecycle

  hasActive(): number {
    return this.rt.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM missions WHERE status IN (${WORKING_STATUSES.map(() => '?').join(',')})`, ...WORKING_STATUSES)!.c;
  }

  async pauseAll(reason: string): Promise<void> {
    for (const r of this.rt.db.all<{ id: string }>(`SELECT id FROM missions WHERE status IN (${WORKING_STATUSES.map(() => '?').join(',')})`, ...WORKING_STATUSES)) this.setStatus(r.id, 'paused', { reason });
    await Promise.allSettled([...this.active.values()].map((a) => a.driving ?? Promise.resolve()));
  }

  async cancelAll(reason: string): Promise<void> {
    for (const r of this.rt.db.all<{ id: string }>("SELECT id FROM missions WHERE status NOT IN ('completed','partially_completed','failed','cancelled','draft')")) await this.cancel(r.id, 'system', reason);
  }

  /**
   * Recovery (28.11): missions interrupted by a crash or shutdown are paused, never continued silently. Steps that
   * could have changed something are not repeated automatically.
   */
  start(): void {
    const rows = this.rt.db.all<{ id: string; status: MissionStatus }>(`SELECT id, status FROM missions WHERE status IN (${WORKING_STATUSES.map(() => '?').join(',')})`, ...WORKING_STATUSES);
    for (const r of rows) {
      for (const s of this.stepRows(r.id).filter((x) => x.status === 'running')) this.interruptStep(s, 'Прервано перезапуском приложения.');
      this.setStatus(r.id, 'paused', { reason: 'Восстановлено после перезапуска приложения. Выполненные этапы и результаты сохранены; нажмите «Продолжить».' });
      this.event(r.id, null, 'warn', 'mission.recovered', 'Поручение было прервано и восстановлено после перезапуска');
    }
    // steps left "running" under a paused / waiting mission (e.g. crash during pause)
    for (const s of this.rt.db.all<StepRow>("SELECT s.* FROM mission_steps s JOIN missions m ON m.id = s.mission_id WHERE s.status = 'running'")) this.interruptStep(s, 'Прервано перезапуском приложения.');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const waits: Promise<unknown>[] = [];
    for (const [id, a] of this.active) {
      a.abortReason = 'stop';
      a.controller.abort();
      if (a.driving) waits.push(a.driving);
      try {
        const m = this.row(id);
        if (WORKING_STATUSES.includes(m.status)) this.setStatus(id, 'paused', { reason: 'Прервано закрытием системы. Нажмите «Продолжить», чтобы возобновить.' });
      } catch {
        // closing
      }
    }
    await Promise.race([Promise.allSettled(waits), new Promise((res) => setTimeout(res, 5000))]);
    this.active.clear();
  }
}
