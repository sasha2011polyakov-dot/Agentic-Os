import { AppError } from '@aos/core';
import { services, workflowFunctionList, TASK_STATUSES, type RunScope, type TaskStatus, type TaskPriority, type RunStatus } from '@aos/core/internal';
import type { RouteContext, Router } from '../http/router.ts';
import { raw } from '../http/router.ts';
import { body, bool, int, optStr, str, sys } from './util.ts';

function strArray(v: unknown, name: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new AppError('VALIDATION_FAILED', `The field "${name}" must be a list of strings.`);
  return v as string[];
}

export function parseScope(v: unknown): RunScope {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>;
  const scope: RunScope = {
    sourceIds: strArray(o.sourceIds, 'scope.sourceIds'),
    docIds: strArray(o.docIds, 'scope.docIds'),
    extraSystems: strArray(o.extraSystems, 'scope.extraSystems'),
    allowWeb: bool(o.allowWeb),
  };
  if (typeof o.outputFolder === 'string' && o.outputFolder) scope.outputFolder = o.outputFolder;
  const denied = strArray(o.deniedTools, 'scope.deniedTools');
  if (denied.length) scope.deniedTools = denied;
  return scope;
}

function limits(v: unknown): Record<string, number | null> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION_FAILED', 'Limits must be an object.');
  const out: Record<string, number | null> = {};
  for (const k of ['maxModelCalls', 'maxTokens', 'maxCostUsd', 'maxReviewIterations', 'stepTimeoutMs', 'maxParallel']) {
    const x = (v as Record<string, unknown>)[k];
    if (x === undefined) continue;
    if (x !== null && (typeof x !== 'number' || !Number.isFinite(x) || x < 0)) throw new AppError('VALIDATION_FAILED', `Limit ${k}: a non-negative number or null.`);
    out[k] = x as number | null;
  }
  return out;
}

const list = (v: string | null) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export function registerWorkflowRoutes(r: Router): void {
  const w = '/api/systems/:systemId/workflows';
  const wf = async (ctx: RouteContext) => services(await sys(ctx)).workflows;
  r.get(w, async (ctx) => ({ workflows: (await wf(ctx)).list() }));
  r.get('/api/workflows/functions', () => ({ functions: workflowFunctionList() }));
  r.post(`${w}/check`, async (ctx) => ({ check: (await wf(ctx)).check(body(ctx).definition) }));
  r.get(`${w}/:wid`, async (ctx) => (await wf(ctx)).definition(ctx.params.wid!));
  r.put(`${w}/:wid`, async (ctx) => {
    const def = body(ctx).definition as { id?: string } | undefined;
    if (!def || def.id !== ctx.params.wid) throw new AppError('VALIDATION_FAILED', 'The identifier in the definition must match the address.');
    return (await wf(ctx)).save(def);
  });
  r.post(`${w}/:wid/duplicate`, async (ctx) => {
    const b = body(ctx);
    return { definition: (await wf(ctx)).duplicate(ctx.params.wid!, str(b.id, 'id', { max: 64 }), str(b.name, 'name', { max: 120 })) };
  });
  r.delete(`${w}/:wid`, async (ctx) => {
    (await wf(ctx)).remove(ctx.params.wid!);
    return { ok: true };
  });
  r.post(`${w}/:wid/preflight`, async (ctx) => {
    const b = body(ctx);
    return { preflight: await (await wf(ctx)).preflight(ctx.params.wid!, parseScope(b.scope), limits(b.limits)) };
  });
  r.post(`${w}/:wid/setup-agents`, async (ctx) => (await wf(ctx)).setupAgents(ctx.params.wid!));
  r.post(`${w}/:wid/runs`, async (ctx) => {
    const b = body(ctx);
    const l = limits(b.limits);
    const title = optStr(b.title, 'title', 300);
    return { run: await (await wf(ctx)).startRun(ctx.params.wid!, b.input ?? {}, { scope: parseScope(b.scope), ...(l ? { limits: l } : {}), ...(title ? { title } : {}) }) };
  });

  const runs = '/api/systems/:systemId/runs';
  r.get(runs, async (ctx) => {
    const f: { workflowId?: string; status?: RunStatus[]; limit: number; offset: number } = { limit: int(ctx.query.get('limit'), 50, 500), offset: int(ctx.query.get('offset'), 0, 1_000_000) };
    const wid = ctx.query.get('workflowId');
    if (wid) f.workflowId = wid;
    const st = list(ctx.query.get('status'));
    if (st) f.status = st as RunStatus[];
    return (await wf(ctx)).listRuns(f);
  });
  r.get(`${runs}/:runId`, async (ctx) => ({ run: (await wf(ctx)).get(ctx.params.runId!) }));
  r.get(`${runs}/:runId/events`, async (ctx) => ({ events: (await wf(ctx)).events(ctx.params.runId!, int(ctx.query.get('after'), 0, Number.MAX_SAFE_INTEGER), int(ctx.query.get('limit'), 500, 2000)) }));
  r.post(`${runs}/:runId/pause`, async (ctx) => ({ run: await (await wf(ctx)).pause(ctx.params.runId!) }));
  r.post(`${runs}/:runId/resume`, async (ctx) => ({ run: await (await wf(ctx)).resume(ctx.params.runId!) }));
  r.post(`${runs}/:runId/cancel`, async (ctx) => ({ run: await (await wf(ctx)).cancel(ctx.params.runId!) }));
  r.patch(`${runs}/:runId/limits`, async (ctx) => ({ run: (await wf(ctx)).updateLimits(ctx.params.runId!, limits(body(ctx)) ?? {}) }));
  r.post(`${runs}/:runId/steps/:stepId/approve`, async (ctx) => {
    const b = body(ctx);
    const decision = str(b.decision, 'decision') as 'approve' | 'reject' | 'revise';
    const answers = Array.isArray(b.answers) ? (b.answers as { question?: unknown; answer?: unknown }[]).map((a) => ({ question: String(a?.question ?? ''), answer: String(a?.answer ?? '') })) : [];
    const choices = Array.isArray(b.choices) ? (b.choices as { id?: unknown; value?: unknown }[]).map((c) => ({ id: String(c?.id ?? ''), value: String(c?.value ?? '') })) : [];
    const comment = optStr(b.comment, 'comment', 10000);
    return { run: await (await wf(ctx)).approve(ctx.params.runId!, ctx.params.stepId!, { decision, answers, choices, ...(comment ? { comment } : {}) }) };
  });
}

export function registerTaskRoutes(r: Router): void {
  const t = '/api/systems/:systemId/tasks';
  const ts = async (ctx: RouteContext) => services(await sys(ctx)).tasks;
  const filters = (ctx: RouteContext) => {
    const f: Record<string, unknown> = {};
    const st = list(ctx.query.get('status'));
    if (st) f.status = st as TaskStatus[];
    const pr = list(ctx.query.get('priority'));
    if (pr) f.priority = pr as TaskPriority[];
    for (const [q, k] of [['projectId', 'projectId'], ['q', 'q'], ['requirementId', 'requirementId'], ['origin', 'origin'], ['runId', 'originRunId'], ['assignee', 'assigneeId']] as const) {
      const v = ctx.query.get(q);
      if (v) f[k] = v;
    }
    const parent = ctx.query.get('parentId');
    if (parent !== null) f.parentId = parent === 'root' ? null : parent;
    return f;
  };
  r.get(`${t}/statuses`, () => ({ statuses: TASK_STATUSES }));
  r.get(t, async (ctx) => (await ts(ctx)).list({ ...filters(ctx), limit: int(ctx.query.get('limit'), 500, 2000), offset: int(ctx.query.get('offset'), 0, 1_000_000) }));
  r.get(`${t}/board`, async (ctx) => (await ts(ctx)).board(filters(ctx) as { projectId?: string; q?: string }));
  r.get(`${t}/export`, async (ctx) => {
    const format = (ctx.query.get('format') ?? 'md') as 'md' | 'json' | 'csv';
    if (!['md', 'json', 'csv'].includes(format)) throw new AppError('VALIDATION_FAILED', 'Export format: md, json or csv.');
    const res = (await ts(ctx)).export(format, filters(ctx));
    return raw(res.body, { 'content-type': res.contentType, 'content-disposition': `attachment; filename="${res.fileName}"` });
  });
  r.post(t, async (ctx) => {
    const b = body(ctx);
    return {
      task: (await ts(ctx)).create({
        title: str(b.title, 'title', { max: 300 }),
        ...(typeof b.description === 'string' ? { description: b.description } : {}),
        ...(typeof b.goal === 'string' ? { goal: b.goal } : {}),
        ...(typeof b.rationale === 'string' ? { rationale: b.rationale } : {}),
        ...(typeof b.status === 'string' ? { status: b.status as TaskStatus } : {}),
        ...(typeof b.priority === 'string' ? { priority: b.priority as TaskPriority } : {}),
        ...(typeof b.parentId === 'string' ? { parentId: b.parentId } : {}),
        ...(typeof b.projectId === 'string' ? { projectId: b.projectId } : {}),
        acceptanceCriteria: strArray(b.acceptanceCriteria, 'acceptanceCriteria'),
        affectedModules: strArray(b.affectedModules, 'affectedModules'),
        unknowns: strArray(b.unknowns, 'unknowns'),
        requirementIds: strArray(b.requirementIds, 'requirementIds'),
        dependsOn: strArray(b.dependsOn, 'dependsOn'),
      }),
    };
  });
  r.get(`${t}/:id`, async (ctx) => ({ task: (await ts(ctx)).get(ctx.params.id!) }));
  r.patch(`${t}/:id`, async (ctx) => {
    const b = body(ctx);
    const patch: Record<string, unknown> = {};
    for (const k of ['title', 'description', 'goal', 'rationale', 'priority', 'projectId'] as const) if (typeof b[k] === 'string') patch[k] = b[k];
    if (b.parentId === null || typeof b.parentId === 'string') patch.parentId = b.parentId;
    if (typeof b.sortOrder === 'number') patch.sortOrder = b.sortOrder;
    if (b.assignee === null || (b.assignee && typeof b.assignee === 'object')) patch.assignee = b.assignee;
    for (const k of ['acceptanceCriteria', 'affectedModules', 'unknowns', 'requirementIds'] as const) if (b[k] !== undefined) patch[k] = strArray(b[k], k);
    return { task: (await ts(ctx)).update(ctx.params.id!, patch) };
  });
  r.post(`${t}/:id/status`, async (ctx) => {
    const b = body(ctx);
    const evidence = optStr(b.evidence, 'evidence', 5000);
    return { task: (await ts(ctx)).setStatus(ctx.params.id!, str(b.status, 'status') as TaskStatus, { ...(evidence ? { evidence } : {}), confirm: bool(b.confirm), force: bool(b.force) }) };
  });
  r.post(`${t}/:id/dependencies`, async (ctx) => ({ task: (await ts(ctx)).addDependency(ctx.params.id!, str(body(ctx).dependsOn, 'dependsOn')) }));
  r.delete(`${t}/:id/dependencies/:dep`, async (ctx) => ({ task: (await ts(ctx)).removeDependency(ctx.params.id!, ctx.params.dep!) }));
  r.post(`${t}/:id/comments`, async (ctx) => ({ task: (await ts(ctx)).addComment(ctx.params.id!, str(body(ctx).body, 'body', { max: 20000 })) }));
  r.post(`${t}/:id/links`, async (ctx) => {
    const b = body(ctx);
    return { task: (await ts(ctx)).addLink(ctx.params.id!, { type: str(b.type, 'type') as 'document' | 'url' | 'requirement', id: str(b.id, 'id', { max: 2000 }), ...(typeof b.label === 'string' ? { label: b.label } : {}) }) };
  });
  r.delete(`${t}/:id/links`, async (ctx) => ({ task: (await ts(ctx)).removeLink(ctx.params.id!, ctx.query.get('type') ?? '', ctx.query.get('target') ?? '') }));
  r.delete(`${t}/:id`, async (ctx) => {
    (await ts(ctx)).remove(ctx.params.id!);
    return { ok: true };
  });
}
