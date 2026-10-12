import { AppError } from '@aos/core';
import { appAI, services, PROVIDER_PRESETS, TASK_TYPES, PERMISSIONS, TOOLS, runCheck, ACCESS_MODES, describeRepository, type AccessMode, type AgentScope, type GrantScope, type PermissionId, type ModelPolicy, type ProviderKind, type Locality, type TaskType, type ChangeSetStatus } from '@aos/core/internal';
import type { RouteContext, Router } from '../http/router.ts';
import { raw } from '../http/router.ts';
import { body, bool, int, optStr, str, sys } from './util.ts';

const PROVIDER_KINDS = new Set<ProviderKind>(['ollama', 'openai-compatible', 'anthropic']);
const pulls = new Map<string, AbortController>();

function ai(ctx: RouteContext) {
  return appAI(ctx.core.services);
}

function obj(v: unknown, name: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) throw new AppError('VALIDATION_FAILED', `Поле «${name}» должно быть объектом.`);
  return v as Record<string, unknown>;
}

function zipBody(ctx: RouteContext): Uint8Array {
  if (!Buffer.isBuffer(ctx.body)) throw new AppError('VALIDATION_FAILED', 'Ожидается ZIP-архив пакета (Content-Type: application/zip).');
  return ctx.body;
}

function permissionList(v: unknown): PermissionId[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new AppError('VALIDATION_FAILED', 'Разрешения — список идентификаторов.');
  const known = new Set(PERMISSIONS.map((p) => p.id));
  for (const p of v) if (!known.has(p as PermissionId)) throw new AppError('VALIDATION_FAILED', `Неизвестное разрешение: ${p}`);
  return v as PermissionId[];
}

function grantScopes(v: unknown): Partial<Record<PermissionId, GrantScope>> {
  const o = obj(v, 'grantScopes');
  const out: Partial<Record<PermissionId, GrantScope>> = {};
  for (const [k, raw] of Object.entries(o)) {
    const sc = obj(raw, k);
    const scope: GrantScope = {};
    for (const f of ['sources', 'folders', 'domains'] as const) {
      const val = sc[f];
      if (val === undefined) continue;
      if (!Array.isArray(val) || !val.every((x) => typeof x === 'string')) throw new AppError('VALIDATION_FAILED', `${k}.${f}: ожидается список строк.`);
      scope[f] = val as string[];
    }
    out[k as PermissionId] = scope;
  }
  return out;
}

export function registerAiRoutes(r: Router): void {
  // --- providers (application level) ---
  r.get('/api/ai/providers', async (ctx) => ({ providers: await ai(ctx).providers.views(), presets: PROVIDER_PRESETS, taskTypes: TASK_TYPES, testProvider: ai(ctx).testEnabled }));
  r.post('/api/ai/providers', async (ctx) => {
    const b = body(ctx);
    const kind = str(b.kind, 'kind') as ProviderKind;
    if (!PROVIDER_KINDS.has(kind)) throw new AppError('VALIDATION_FAILED', 'Неизвестный тип провайдера.');
    const locality = str(b.locality, 'locality') as Locality;
    if (locality !== 'local' && locality !== 'cloud') throw new AppError('VALIDATION_FAILED', 'locality: local или cloud.');
    const input: Parameters<ReturnType<typeof ai>['providers']['create']>[0] = { kind, name: str(b.name, 'name', { max: 100 }), baseUrl: str(b.baseUrl, 'baseUrl', { max: 500 }), locality, options: obj(b.options, 'options') };
    const apiKey = optStr(b.apiKey, 'apiKey', 4000);
    if (apiKey) input.apiKey = apiKey;
    const backend = optStr(b.secretBackend, 'secretBackend', 100);
    if (backend) input.secretBackend = backend;
    const envKey = optStr(b.envKey, 'envKey', 100);
    if (envKey) input.envKey = envKey;
    const p = await ai(ctx).providers.create(input);
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'ai.provider.create', details: { id: p.id, kind, locality } });
    ctx.core.services.events.emit('providers.changed', { providerId: p.id });
    return { provider: p };
  });
  r.patch('/api/ai/providers/:id', async (ctx) => {
    const b = body(ctx);
    const patch: Parameters<ReturnType<typeof ai>['providers']['update']>[1] = {};
    const name = optStr(b.name, 'name', 100);
    if (name) patch.name = name;
    const baseUrl = optStr(b.baseUrl, 'baseUrl', 500);
    if (baseUrl) patch.baseUrl = baseUrl;
    if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
    if (b.options !== undefined) patch.options = obj(b.options, 'options');
    if (b.locality === 'local' || b.locality === 'cloud') patch.locality = b.locality;
    const p = await ai(ctx).providers.update(ctx.params.id!, patch);
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'ai.provider.update', details: { id: p.id, fields: Object.keys(patch) } });
    ctx.core.services.events.emit('providers.changed', { providerId: p.id });
    return { provider: p };
  });
  r.delete('/api/ai/providers/:id', async (ctx) => {
    await ai(ctx).providers.remove(ctx.params.id!);
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'ai.provider.remove', details: { id: ctx.params.id } });
    ctx.core.services.events.emit('providers.changed', { providerId: ctx.params.id });
    return { ok: true };
  });
  r.put('/api/ai/providers/:id/key', async (ctx) => {
    const b = body(ctx);
    const envKey = optStr(b.envKey, 'envKey', 100);
    if (envKey) await ai(ctx).providers.setEnvKey(ctx.params.id!, envKey);
    else await ai(ctx).providers.setApiKey(ctx.params.id!, str(b.apiKey, 'apiKey', { max: 4000 }), optStr(b.backend, 'backend', 100));
    // the key itself is never logged or returned — only its presence and storage backend
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'ai.provider.key.set', details: { id: ctx.params.id, via: envKey ? 'env' : 'secret-store' } });
    return { key: (await ai(ctx).providers.views()).find((p) => p.id === ctx.params.id)?.key ?? null };
  });
  r.delete('/api/ai/providers/:id/key', async (ctx) => {
    await ai(ctx).providers.clearApiKey(ctx.params.id!);
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'ai.provider.key.clear', details: { id: ctx.params.id } });
    return { ok: true };
  });
  r.post('/api/ai/providers/:id/health', async (ctx) => {
    try {
      return { health: await ai(ctx).providers.health(ctx.params.id!) };
    } catch (e) {
      const err = e instanceof AppError ? e : new AppError('PROVIDER_ERROR', String(e));
      return { health: { ok: false, error: err.toJSON() } };
    }
  });
  r.get('/api/ai/providers/:id/models', async (ctx) => ai(ctx).providers.models(ctx.params.id!, { refresh: ctx.query.get('refresh') === '1' }));
  r.post('/api/ai/providers/:id/pull', async (ctx) => {
    const model = str(body(ctx).model, 'model', { max: 200 });
    const key = `${ctx.params.id}:${model}`;
    if (pulls.has(key)) throw new AppError('VALIDATION_FAILED', 'Загрузка этой модели уже выполняется.');
    const ac = new AbortController();
    pulls.set(key, ac);
    const events = ctx.core.services.events;
    const providerId = ctx.params.id!;
    void ai(ctx)
      .ai.pull(providerId, model, (p) => events.emit('model.pull', { providerId, model, ...p }), ac.signal)
      .then(() => events.emit('model.pull', { providerId, model, status: 'success', done: true }))
      .catch((e) => events.emit('model.pull', { providerId, model, status: 'error', done: true, error: e instanceof AppError ? e.toJSON() : { code: 'INTERNAL', message: String(e) } }))
      .finally(() => pulls.delete(key));
    return { started: true };
  });
  r.post('/api/ai/providers/:id/pull/cancel', async (ctx) => {
    const model = str(body(ctx).model, 'model', { max: 200 });
    pulls.get(`${ctx.params.id}:${model}`)?.abort();
    return { ok: true };
  });
  r.delete('/api/ai/providers/:id/models/:model', async (ctx) => {
    await ai(ctx).ai.deleteModel(ctx.params.id!, decodeURIComponent(ctx.params.model!));
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'ai.model.delete', details: { provider: ctx.params.id, model: ctx.params.model } });
    return { ok: true };
  });
  r.get('/api/ai/secret-backends', async (ctx) => ({ backends: await ai(ctx).secrets.describe() }));
  r.get('/api/ai/prices', async (ctx) => ({ prices: ai(ctx).providers.prices() }));
  r.put('/api/ai/prices', async (ctx) => {
    const b = body(ctx);
    const num = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'number' && v >= 0 ? v : (() => { throw new AppError('VALIDATION_FAILED', 'Цена — неотрицательное число или null.'); })());
    ai(ctx).providers.setPrice(str(b.providerId, 'providerId'), str(b.model, 'model', { max: 200 }), num(b.inputPerMTok), num(b.outputPerMTok));
    return { ok: true };
  });
  r.get('/api/ai/usage', async (ctx) => {
    const systemId = ctx.query.get('systemId');
    const days = int(ctx.query.get('days'), 30, 366);
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const where = ['ts >= ?'];
    const params: (string | number)[] = [since];
    if (systemId) {
      where.push('system_id = ?');
      params.push(systemId);
    }
    const db = ctx.core.registryDb;
    const byModel = db.all(
      `SELECT provider_id AS providerId, model, locality, COUNT(*) AS calls, SUM(status = 'ok') AS ok, SUM(status = 'error') AS errors, SUM(status = 'denied') AS denied,
              SUM(COALESCE(input_tokens,0)) AS inputTokens, SUM(COALESCE(output_tokens,0)) AS outputTokens, SUM(COALESCE(cost_usd,0)) AS costUsd, SUM(cost_usd IS NULL AND locality = 'cloud' AND status = 'ok') AS unpriced,
              CAST(AVG(latency_ms) AS INTEGER) AS avgLatencyMs
         FROM ai_usage WHERE ${where.join(' AND ')} GROUP BY provider_id, model, locality ORDER BY calls DESC`,
      ...params,
    );
    const bySystem = db.all(`SELECT system_id AS systemId, COUNT(*) AS calls, SUM(COALESCE(cost_usd,0)) AS costUsd FROM ai_usage WHERE ${where.join(' AND ')} GROUP BY system_id`, ...params);
    const recent = db.all(`SELECT ts, system_id AS systemId, provider_id AS providerId, model, purpose, agent_id AS agentId, run_id AS runId, input_tokens AS inputTokens, output_tokens AS outputTokens, latency_ms AS latencyMs, cost_usd AS costUsd, status, error_code AS errorCode FROM ai_usage WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 100`, ...params);
    return { since, byModel, bySystem, recent, budget: ctx.core.services.appSettings.get('ai.budget') };
  });

  // Route preview for a system: which model would serve each task type, and why (or why nothing can).
  r.get('/api/systems/:systemId/ai/routes', async (ctx) => {
    const rt = await sys(ctx);
    const out = TASK_TYPES.map((t) => {
      try {
        const route = ai(ctx).ai.preview({ rt, policy: { mode: 'inherit' }, taskType: t.id, containsConfidential: false, needsStructured: t.id !== 'embedding' });
        return { taskType: t.id, label: t.label, route };
      } catch (e) {
        return { taskType: t.id, label: t.label, route: null, error: e instanceof AppError ? e.toJSON() : { code: 'INTERNAL', message: String(e) } };
      }
    });
    return { environment: ai(ctx).ai.environment(rt), routes: out };
  });
  r.post('/api/systems/:systemId/ai/preview', async (ctx) => {
    const rt = await sys(ctx);
    const b = body(ctx);
    const taskType = str(b.taskType, 'taskType') as TaskType;
    return { route: ai(ctx).ai.preview({ rt, policy: obj(b.policy, 'policy') as ModelPolicy, taskType, containsConfidential: bool(b.containsConfidential), needsStructured: true }) };
  });
}

export function registerAgentRoutes(r: Router): void {
  r.get('/api/agents/permissions', () => ({ permissions: PERMISSIONS }));
  r.get('/api/agents/tools', () => ({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) }));
  r.get('/api/agents/shared', async (ctx) => ({ agents: await ai(ctx).catalog.sharedEntries() }));
  r.post(
    '/api/agents/shared/import',
    async (ctx) => {
      const res = await ai(ctx).catalog.importShared(zipBody(ctx));
      ctx.core.services.registryAudit.record({ actor: 'user', action: 'agent.shared.import', details: { id: res.entry.id, version: res.entry.version } });
      ctx.core.services.events.emit('agents.changed', { shared: true });
      return res;
    },
    { maxBodyBytes: 10 * 1024 * 1024 },
  );
  r.delete('/api/agents/shared/:id/:version', async (ctx) => {
    await ai(ctx).catalog.removeShared(ctx.params.id!, ctx.params.version!);
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'agent.shared.remove', details: { id: ctx.params.id, version: ctx.params.version } });
    ctx.core.services.events.emit('agents.changed', { shared: true });
    return { ok: true };
  });

  const base = '/api/systems/:systemId/agents';
  r.get(base, async (ctx) => ({ agents: await services(await sys(ctx)).agents.list() }));
  r.get(`${base}/catalog`, async (ctx) => ({ catalog: await services(await sys(ctx)).agents.catalog() }));
  r.post(`${base}/install`, async (ctx) => {
    const b = body(ctx);
    const scope = str(b.scope, 'scope') as AgentScope;
    if (!['builtin', 'app', 'system'].includes(scope)) throw new AppError('VALIDATION_FAILED', 'scope: builtin, app или system.');
    const version = optStr(b.version, 'version', 40);
    return { agent: await services(await sys(ctx)).agents.install({ id: str(b.id, 'id', { max: 64 }), scope, ...(version ? { version } : {}), grants: permissionList(b.grants), grantScopes: grantScopes(b.grantScopes) }) };
  });
  r.post(
    `${base}/import`,
    async (ctx) => services(await sys(ctx)).agents.importSystemPackage(zipBody(ctx)),
    { maxBodyBytes: 10 * 1024 * 1024 },
  );
  r.post(`${base}/definitions`, async (ctx) => {
    const b = body(ctx);
    const arr = (v: unknown, n: string) => {
      if (!Array.isArray(v)) throw new AppError('VALIDATION_FAILED', `Поле «${n}» — список.`);
      return v;
    };
    const def = {
      id: str(b.id, 'id', { max: 64 }),
      name: str(b.name, 'name', { max: 100 }),
      description: str(b.description, 'description', { max: 1000 }),
      category: optStr(b.category, 'category', 60) ?? 'custom',
      instructions: str(b.instructions, 'instructions', { max: 30000 }),
      tools: arr(b.tools, 'tools').map(String),
      permissions: arr(b.permissions, 'permissions').map((p) => ({ permission: String((p as { permission: unknown }).permission) as PermissionId, reason: String((p as { reason?: unknown }).reason ?? '') })),
      taskType: str(b.taskType, 'taskType') as TaskType,
      inputSchema: obj(b.inputSchema, 'inputSchema'),
      outputSchema: obj(b.outputSchema, 'outputSchema'),
      ...(Array.isArray(b.tests) ? { tests: b.tests as never } : {}),
      ...(typeof b.readme === 'string' ? { readme: b.readme } : {}),
      ...(typeof b.version === 'string' ? { version: b.version } : {}),
    };
    return services(await sys(ctx)).agents.saveDefinition(def);
  });
  r.get(`${base}/:agentId`, async (ctx) => ({ agent: await services(await sys(ctx)).agents.get(ctx.params.agentId!) }));
  r.put(`${base}/:agentId/grants`, async (ctx) => {
    const b = body(ctx);
    const s = services(await sys(ctx));
    s.agents.setGrants(ctx.params.agentId!, permissionList(b.grants), grantScopes(b.grantScopes));
    return { agent: await s.agents.get(ctx.params.agentId!) };
  });
  r.patch(`${base}/:agentId/config`, async (ctx) => {
    const b = body(ctx);
    const cfg: Record<string, unknown> = {};
    if (b.modelPolicy !== undefined) cfg.modelPolicy = obj(b.modelPolicy, 'modelPolicy');
    if (b.generation !== undefined) cfg.generation = obj(b.generation, 'generation');
    return { config: services(await sys(ctx)).agents.configure(ctx.params.agentId!, cfg) };
  });
  r.post(`${base}/:agentId/enable`, async (ctx) => ({ agent: await services(await sys(ctx)).agents.setEnabled(ctx.params.agentId!, true) }));
  r.post(`${base}/:agentId/disable`, async (ctx) => ({ agent: await services(await sys(ctx)).agents.setEnabled(ctx.params.agentId!, false) }));
  r.post(`${base}/:agentId/rollback`, async (ctx) => ({ agent: await services(await sys(ctx)).agents.rollback(ctx.params.agentId!) }));
  r.post(`${base}/:agentId/test`, async (ctx) => services(await sys(ctx)).agents.testRun(ctx.params.agentId!));
  r.delete(`${base}/:agentId`, async (ctx) => {
    await services(await sys(ctx)).agents.uninstall(ctx.params.agentId!);
    return { ok: true };
  });
  r.get(`${base}/:agentId/export`, async (ctx) => {
    const res = await services(await sys(ctx)).agents.exportPackage(ctx.params.agentId!, ctx.query.get('version') ?? undefined);
    return raw(Buffer.from(res.bytes), { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${res.fileName}"` });
  });
}

export function registerChangeRoutes(r: Router): void {
  const base = '/api/systems/:systemId/changes';
  r.get(base, async (ctx) => {
    const opts: { missionId?: string; status?: ChangeSetStatus; limit?: number } = { limit: int(ctx.query.get('limit'), 100, 500) };
    const m = ctx.query.get('missionId');
    if (m) opts.missionId = m;
    const st = ctx.query.get('status');
    if (st) opts.status = st as ChangeSetStatus;
    return { changeSets: services(await sys(ctx)).changes.list(opts) };
  });
  r.get(`${base}/:id`, async (ctx) => ({ changeSet: services(await sys(ctx)).changes.get(ctx.params.id!) }));
  r.get(`${base}/:id/patch`, async (ctx) => raw(services(await sys(ctx)).changes.patch(ctx.params.id!, 'user'), { 'content-type': 'text/x-diff; charset=utf-8', 'content-disposition': `attachment; filename="${ctx.params.id}.patch"` }));
  r.get(`${base}/files/:fileId/content`, async (ctx) => services(await sys(ctx)).changes.proposedContent(ctx.params.fileId!));
  // review screen actions (29.7)
  r.post(`${base}/:id/review`, async (ctx) => ({ changeSet: services(await sys(ctx)).changes.review(ctx.params.id!, 'user') }));
  r.post(`${base}/:id/reject-files`, async (ctx) => {
    const ids = body(ctx).fileIds;
    if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) throw new AppError('VALIDATION_FAILED', 'fileIds — список идентификаторов файлов.');
    return { changeSet: services(await sys(ctx)).changes.rejectFiles(ctx.params.id!, ids as string[], 'user') };
  });
  r.get(`${base}/:id/check-plan`, async (ctx) => ({ plan: await services(await sys(ctx)).changes.checkPlan(ctx.params.id!, 'user') }));
  r.post(`${base}/:id/verify`, async (ctx) => {
    const approved = body(ctx).approvedScripts;
    const approvedScripts: Record<string, string> = {};
    if (approved && typeof approved === 'object' && !Array.isArray(approved)) for (const [k, v] of Object.entries(approved)) if (typeof v === 'string') approvedScripts[k] = v;
    return { changeSet: await services(await sys(ctx)).changes.verifyInWorkCopy(ctx.params.id!, { actor: 'user', approvedScripts }) };
  });
  r.post(`${base}/:id/apply`, async (ctx) => {
    const b = body(ctx);
    const fileIds = Array.isArray(b.fileIds) ? b.fileIds.map(String) : undefined;
    const confirmRisks = Array.isArray(b.confirmRisks) ? b.confirmRisks.map(String) : [];
    return { changeSet: await services(await sys(ctx)).changes.apply(ctx.params.id!, { actor: 'user', confirmRisks, ...(fileIds ? { fileIds } : {}) }) };
  });
  r.post(`${base}/:id/revert`, async (ctx) => ({ changeSet: await services(await sys(ctx)).changes.revert(ctx.params.id!, { actor: 'user', confirmOverwrite: bool(body(ctx).confirmOverwrite) }) }));
  r.post(`${base}/:id/reject`, async (ctx) => {
    const reason = optStr(body(ctx).reason, 'reason', 1000);
    return { changeSet: services(await sys(ctx)).changes.reject(ctx.params.id!, { actor: 'user', ...(reason ? { reason } : {}) }) };
  });
}

export function registerSecurityRoutes(r: Router): void {
  const s = '/api/systems/:systemId';
  r.get('/api/security/modes', () => ({ modes: ACCESS_MODES }));
  r.post(`${s}/sources/:id/access-mode`, async (ctx) => {
    const b = body(ctx);
    return { source: services(await sys(ctx)).sources.setAccessMode(ctx.params.id!, str(b.mode, 'mode') as AccessMode, { actor: 'user', confirm: bool(b.confirm) }) };
  });
  r.get(`${s}/sources/:id/repository`, async (ctx) => {
    const info = await services(await sys(ctx)).sources.gitInfo(ctx.params.id!);
    return { git: info, description: describeRepository(info) };
  });
  // work copies
  r.get(`${s}/workcopies`, async (ctx) => ({ workCopies: services(await sys(ctx)).workcopies.list(ctx.query.get('sourceId') ?? undefined) }));
  r.post(`${s}/sources/:id/workcopies`, async (ctx) => ({ workCopy: await services(await sys(ctx)).workcopies.create(ctx.params.id!, { actor: 'user' }) }));
  r.delete(`${s}/workcopies/:wcId`, async (ctx) => {
    await services(await sys(ctx)).workcopies.discard(ctx.params.wcId!, 'user');
    return { ok: true };
  });
  r.post(`${s}/sources/:id/checks/:name/run`, async (ctx) => {
    const svc = services(await sys(ctx));
    const wc = svc.workcopies.current(ctx.params.id!, null) ?? (await svc.workcopies.create(ctx.params.id!, { actor: 'user' }));
    const approved = optStr(body(ctx).approvedContentHash, 'approvedContentHash', 200);
    return { result: await runCheck(await sys(ctx), ctx.params.id!, ctx.params.name!, { workCopy: { id: wc.id, rootPath: wc.rootPath }, actor: 'user', approvedContentHash: approved ?? null }) };
  });
  // backups and restore
  r.get(`${s}/backups`, async (ctx) => ({ backups: services(await sys(ctx)).backups.list({ ...(ctx.query.get('sourceId') ? { sourceId: ctx.query.get('sourceId')! } : {}) }) }));
  r.get(`${s}/backups/:id`, async (ctx) => {
    const b = services(await sys(ctx)).backups;
    return { backup: b.get(ctx.params.id!), integrity: await b.verify(ctx.params.id!), editedSinceApply: await b.changedSinceApply(ctx.params.id!) };
  });
  r.post(`${s}/backups/:id/restore`, async (ctx) => services(await sys(ctx)).backups.restore(ctx.params.id!, { actor: 'user', confirmOverwrite: bool(body(ctx).confirmOverwrite) }));
  // security journal
  r.get(`${s}/security-log`, async (ctx) => {
    const rt = await sys(ctx);
    const f: Parameters<typeof rt.security.list>[0] = { limit: int(ctx.query.get('limit'), 200, 2000) };
    const before = ctx.query.get('before');
    if (before) f.before = int(before, 0, Number.MAX_SAFE_INTEGER);
    for (const k of ['action', 'sourceId', 'taskId'] as const) {
      const v = ctx.query.get(k);
      if (v) f[k] = v;
    }
    const o = ctx.query.get('outcome');
    if (o) f.outcome = o as 'ok' | 'denied' | 'error' | 'warning';
    return { entries: rt.security.list(f), integrity: rt.security.verify() };
  });
  r.get('/api/security-log', (ctx) => ({ entries: ctx.core.services.security.list({ limit: int(ctx.query.get('limit'), 200, 2000) }), integrity: ctx.core.services.security.verify() }));
}

export function registerWebRoutes(r: Router): void {
  r.get('/api/web/settings', async (ctx) => {
    const s = ai(ctx).web.settings();
    return { settings: { ...s, braveKey: await ai(ctx).secrets.masked(s.braveSecretRef), githubToken: await ai(ctx).secrets.masked(s.githubSecretRef) } };
  });
  r.put('/api/web/settings', async (ctx) => {
    const b = body(ctx);
    const cur = ai(ctx).web.settings();
    const next = { ...cur };
    if (b.provider === 'none' || b.provider === 'searxng' || b.provider === 'brave') next.provider = b.provider;
    if (typeof b.searxngUrl === 'string') {
      if (b.searxngUrl) {
        try {
          const u = new URL(b.searxngUrl);
          if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('protocol');
        } catch {
          throw new AppError('VALIDATION_FAILED', 'Некорректный адрес SearXNG.');
        }
      }
      next.searxngUrl = b.searxngUrl;
    }
    if (typeof b.allowHttp === 'boolean') next.allowHttp = b.allowHttp;
    const brave = optStr(b.braveKey, 'braveKey', 500);
    if (brave) next.braveSecretRef = await ai(ctx).secrets.put('web_brave', brave, optStr(b.secretBackend, 'secretBackend', 100));
    const gh = optStr(b.githubToken, 'githubToken', 500);
    if (gh) next.githubSecretRef = await ai(ctx).secrets.put('web_github', gh, optStr(b.secretBackend, 'secretBackend', 100));
    if (b.clearBraveKey === true) {
      await ai(ctx).secrets.remove(cur.braveSecretRef);
      next.braveSecretRef = null;
    }
    if (b.clearGithubToken === true) {
      await ai(ctx).secrets.remove(cur.githubSecretRef);
      next.githubSecretRef = null;
    }
    ctx.core.services.appSettings.set('web.search', next);
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'settings.web', details: { provider: next.provider, searxng: !!next.searxngUrl, brave: !!next.braveSecretRef, github: !!next.githubSecretRef } });
    return { ok: true };
  });
  r.get('/api/systems/:systemId/web/sources', async (ctx) => ({ sources: ai(ctx).web.sources(await sys(ctx), int(ctx.query.get('limit'), 200, 1000)) }));
  r.post('/api/systems/:systemId/web/fetch', async (ctx) => ({ page: await ai(ctx).web.fetchAndStore(await sys(ctx), str(body(ctx).url, 'url', { max: 2000 }), { maxChars: 30000 }) }));
}
