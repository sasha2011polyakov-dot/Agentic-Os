import { AppError } from '@aos/core';
import { services, type CreateMissionInput, type CriterionVerification, type MissionAttachment, type MissionDecision, type MissionLimits, type MissionPhase, type MissionPolicy, type MissionScope, type MissionStatus, type PlanStep } from '@aos/core/internal';
import type { RouteContext, Router } from '../http/router.ts';
import { body, int, optStr, str, sys } from './util.ts';

function obj(v: unknown, name: string): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION_FAILED', `The field "${name}" must be an object.`);
  return v as Record<string, unknown>;
}

function arr<T>(v: unknown, name: string): T[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v)) throw new AppError('VALIDATION_FAILED', `The field "${name}" must be a list.`);
  return v as T[];
}

/**
 * Missions (section 28): natural-language assignments. Every decision is a separate explicit user action; the routes
 * never accept an "actor" from the client — actions over HTTP are the user's.
 */
export function registerMissionRoutes(r: Router): void {
  const base = '/api/systems/:systemId/missions';
  const eng = async (ctx: RouteContext) => services(await sys(ctx)).missions;
  const id = (ctx: RouteContext) => ctx.params.mid!;

  r.get(base, async (ctx) => {
    const status = ctx.query.get('status');
    const q = ctx.query.get('q');
    return (await eng(ctx)).list({ limit: int(ctx.query.get('limit'), 50, 500), offset: int(ctx.query.get('offset'), 0, 1_000_000), ...(status ? { status: status.split(',').map((s) => s.trim()) as MissionStatus[] } : {}), ...(q ? { q } : {}) });
  });
  r.post(`${base}/preflight`, async (ctx) => {
    const b = body(ctx);
    const mode = optStr(b.mode, 'mode');
    return { preflight: await (await eng(ctx)).preflight({ ...(obj(b.scope, 'scope') ? { scope: b.scope as Partial<MissionScope> } : {}), ...(mode ? { mode: mode as 'plan' | 'execute' } : {}) }) };
  });
  r.post(`${base}/setup-agents`, async (ctx) => (await eng(ctx)).setupAgents('user'));
  r.post(base, async (ctx) => {
    const b = body(ctx);
    const input: CreateMissionInput = { request: str(b.request, 'request', { max: 20_000 }), actor: 'user' };
    const title = optStr(b.title, 'title', 300);
    if (title) input.title = title;
    if (b.mode !== undefined) input.mode = str(b.mode, 'mode') as 'plan' | 'execute';
    if (b.priority !== undefined) input.priority = str(b.priority, 'priority') as CreateMissionInput['priority'] & string;
    if (obj(b.scope, 'scope')) input.scope = b.scope as Partial<MissionScope>;
    const atts = arr<MissionAttachment>(b.attachments, 'attachments');
    if (atts) input.attachments = atts;
    if (obj(b.policy, 'policy')) input.policy = b.policy as Partial<MissionPolicy>;
    if (obj(b.limits, 'limits')) input.limits = b.limits as Partial<MissionLimits>;
    if (b.start === false) input.start = false;
    return { mission: await (await eng(ctx)).create(input) };
  });
  r.get(`${base}/:mid`, async (ctx) => ({ mission: (await eng(ctx)).get(id(ctx), { full: ctx.query.get('full') === '1' }) }));
  r.get(`${base}/:mid/events`, async (ctx) => ({ events: (await eng(ctx)).events(id(ctx), int(ctx.query.get('after'), 0, Number.MAX_SAFE_INTEGER), int(ctx.query.get('limit'), 500, 2000)) }));
  r.get(`${base}/:mid/messages`, async (ctx) => ({ messages: (await eng(ctx)).messages(id(ctx)) }));
  r.post(`${base}/:mid/start`, async (ctx) => ({ mission: (await eng(ctx)).launch(id(ctx)) }));
  r.post(`${base}/:mid/decide`, async (ctx) => {
    const b = body(ctx);
    const d: MissionDecision & { pendingId?: string; contentHash?: string; approvedScripts?: Record<string, string> } = { decision: str(b.decision, 'decision') as MissionDecision['decision'] };
    const comment = optStr(b.comment, 'comment', 10_000);
    if (comment) d.comment = comment;
    const pendingId = optStr(b.pendingId, 'pendingId', 100);
    if (pendingId) d.pendingId = pendingId;
    const answers = arr<{ question: string; answer: string }>(b.answers, 'answers');
    if (answers) d.answers = answers;
    const checks = arr<{ sourceId: string; name: string; contentHash?: string | null }>(b.approvedChecks, 'approvedChecks');
    if (checks) d.approvedChecks = checks;
    const optionId = optStr(b.optionId, 'optionId', 100);
    if (optionId) d.optionId = optionId;
    const risks = arr<string>(b.confirmRisks, 'confirmRisks');
    if (risks) d.confirmRisks = risks.map(String);
    const hash = optStr(b.contentHash, 'contentHash', 200);
    if (hash) d.contentHash = hash;
    if (obj(b.approvedScripts, 'approvedScripts')) d.approvedScripts = b.approvedScripts as Record<string, string>;
    return { mission: await (await eng(ctx)).decide(id(ctx), d, 'user') };
  });
  r.post(`${base}/:mid/pause`, async (ctx) => ({ mission: await (await eng(ctx)).pause(id(ctx)) }));
  r.post(`${base}/:mid/resume`, async (ctx) => ({ mission: await (await eng(ctx)).resume(id(ctx)) }));
  r.post(`${base}/:mid/cancel`, async (ctx) => ({ mission: await (await eng(ctx)).cancel(id(ctx)) }));
  r.post(`${base}/:mid/requirements`, async (ctx) => {
    const b = body(ctx);
    const kind = optStr(b.kind, 'kind') as 'requirement' | 'criterion' | 'constraint' | undefined;
    const verification = optStr(b.verification, 'verification') as CriterionVerification | undefined;
    return { mission: (await eng(ctx)).addRequirement(id(ctx), { text: str(b.text, 'text', { max: 2000 }), ...(kind ? { kind } : {}), ...(verification ? { verification } : {}) }) };
  });
  r.put(`${base}/:mid/criteria`, async (ctx) => ({ mission: (await eng(ctx)).updateCriteria(id(ctx), arr(body(ctx).criteria, 'criteria') ?? []) }));
  r.post(`${base}/:mid/criteria/:cid/confirm`, async (ctx) => {
    const b = body(ctx);
    return { mission: (await eng(ctx)).confirmCriterion(id(ctx), ctx.params.cid!, str(b.status, 'status') as 'met' | 'partially_met' | 'not_met', str(b.evidence, 'evidence', { optional: true, max: 5000 })) };
  });
  r.put(`${base}/:mid/plan`, async (ctx) => ({ mission: (await eng(ctx)).updatePlan(id(ctx), arr<PlanStep>(body(ctx).steps, 'steps') ?? []) }));
  r.post(`${base}/:mid/options`, async (ctx) => ({ mission: (await eng(ctx)).researchOption(id(ctx), str(body(ctx).text, 'text', { max: 2000 })) }));
  r.post(`${base}/:mid/strategy`, async (ctx) => ({ mission: await (await eng(ctx)).selectStrategy(id(ctx), str(body(ctx).optionId, 'optionId', { max: 100 })) }));
  r.post(`${base}/:mid/deny-tool`, async (ctx) => ({ mission: (await eng(ctx)).denyTool(id(ctx), str(body(ctx).tool, 'tool', { max: 100 })) }));
  r.post(`${base}/:mid/steps/:sid/retry`, async (ctx) => ({ mission: (await eng(ctx)).retryStep(id(ctx), ctx.params.sid!) }));
  r.post(`${base}/:mid/phases/:phase/retry`, async (ctx) => ({ mission: (await eng(ctx)).retryPhase(id(ctx), ctx.params.phase as MissionPhase) }));
  r.put(`${base}/:mid/limits`, async (ctx) => ({ mission: (await eng(ctx)).updateLimits(id(ctx), (obj(body(ctx).limits, 'limits') ?? {}) as Partial<MissionLimits>) }));
  r.put(`${base}/:mid/title`, async (ctx) => ({ mission: (await eng(ctx)).rename(id(ctx), str(body(ctx).title, 'title', { max: 300 })) }));
  r.post(`${base}/:mid/discuss`, async (ctx) => (await eng(ctx)).discuss(id(ctx), str(body(ctx).question, 'question', { max: 5000 })));
  r.post(`${base}/:mid/messages/:msg/apply`, async (ctx) => ({ mission: await (await eng(ctx)).applySuggestion(id(ctx), ctx.params.msg!, Number(body(ctx).index ?? 0)) }));
  r.get(`${base}/:mid/checks/:sourceId/:name/inspect`, async (ctx) => ({ check: await (await eng(ctx)).inspectMissionCheck(id(ctx), ctx.params.sourceId!, ctx.params.name!) }));
}
