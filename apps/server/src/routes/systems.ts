import { AppError, APP_VERSION, SETTINGS, type ActiveRunsPolicy } from '@aos/core';
import type { Router } from '../http/router.ts';
import { body, bool, optStr, str, sys } from './util.ts';

const POLICIES: ActiveRunsPolicy[] = ['refuse', 'pause', 'cancel'];
function policy(v: unknown): ActiveRunsPolicy {
  return POLICIES.includes(v as ActiveRunsPolicy) ? (v as ActiveRunsPolicy) : 'refuse';
}

export function registerAppRoutes(r: Router): void {
  r.get('/api/app', (ctx) => ({
    version: APP_VERSION,
    dataDir: ctx.core.services.paths.dataDir,
    platform: process.platform,
    activeSystemId: ctx.core.systems.activeSystemId(),
    offline: ctx.core.services.appSettings.get<boolean>('net.offline'),
    testProviderEnabled: (ctx.core.services.ext.env as NodeJS.ProcessEnv | undefined)?.AOS_ENABLE_TEST_PROVIDER === '1',
  }));

  r.get('/api/app/settings', (ctx) => ({ settings: ctx.core.services.appSettings.resolvedAll(), catalog: SETTINGS.map((s) => ({ key: s.key, level: s.level, label: s.label, description: s.description, default: s.default })) }));
  r.put('/api/app/settings/:key', (ctx) => {
    const b = body<{ value: unknown }>(ctx);
    ctx.core.services.appSettings.set(ctx.params.key!, b.value);
    ctx.core.services.events.emit('settings.changed', { scope: 'app', key: ctx.params.key });
    ctx.core.services.registryAudit.record({ actor: 'user', action: 'settings.app.set', details: { key: ctx.params.key } });
    return { ok: true };
  });
  r.delete('/api/app/settings/:key', (ctx) => {
    ctx.core.services.appSettings.reset(ctx.params.key!);
    ctx.core.services.events.emit('settings.changed', { scope: 'app', key: ctx.params.key });
    return { ok: true };
  });
  r.get('/api/app/logs', (ctx) => ({ records: ctx.core.services.logger.recentRecords(300, (ctx.query.get('level') as 'warn') ?? 'warn') }));
  r.get('/api/app/audit', (ctx) => ({ entries: ctx.core.services.registryAudit.list(300) }));
  r.get('/api/app/operations', (ctx) => ({ operations: ctx.core.systems.registry.operations(ctx.query.get('systemId') ?? undefined, 100) }));
  r.get('/api/app/integrity', (ctx) => ({ problems: ctx.core.systems.registry.integrity() }));
}

export function registerSystemRoutes(r: Router): void {
  r.get('/api/systems', async (ctx) => {
    if (ctx.query.get('check') === '1') {
      for (const s of ctx.core.systems.registry.list()) await ctx.core.systems.checkAvailability(s.systemId);
    }
    return { systems: ctx.core.systems.list(), activeSystemId: ctx.core.systems.activeSystemId() };
  });

  r.post('/api/systems', async (ctx) => {
    const b = body(ctx);
    const template = b.template === 'starter' ? 'starter' : 'empty';
    const input = {
      name: str(b.name, 'name', { max: 120 }),
      storagePath: str(b.storagePath, 'storagePath'),
      template: template as 'starter' | 'empty',
      adoptExistingFolder: bool(b.adoptExistingFolder),
      ...(optStr(b.description, 'description', 2000) !== undefined ? { description: optStr(b.description, 'description', 2000)! } : {}),
      ...(optStr(b.icon, 'icon', 40) !== undefined ? { icon: optStr(b.icon, 'icon', 40)! } : {}),
      ...(optStr(b.color, 'color', 7) !== undefined ? { color: optStr(b.color, 'color', 7)! } : {}),
    };
    const created = await ctx.core.systems.create(input);
    if (bool(b.open)) await ctx.core.systems.switchTo(created.systemId);
    return { system: ctx.core.systems.get(created.systemId) };
  });

  r.post('/api/systems/inspect', async (ctx) => {
    const b = body(ctx);
    const res = await ctx.core.systems.inspectFolder(str(b.storagePath, 'storagePath'));
    return res;
  });

  r.post('/api/systems/attach', async (ctx) => {
    const b = body(ctx);
    const name = optStr(b.name, 'name', 120);
    const sysInfo = await ctx.core.systems.attach(str(b.storagePath, 'storagePath'), { asCopy: bool(b.asCopy), ...(name ? { name } : {}) });
    return { system: sysInfo };
  });

  r.get('/api/systems/:systemId', (ctx) => ({ system: ctx.core.systems.get(ctx.params.systemId!) }));

  r.patch('/api/systems/:systemId', async (ctx) => {
    const b = body(ctx);
    const patch: { name?: string; description?: string; icon?: string; color?: string } = {};
    for (const k of ['name', 'description', 'icon', 'color'] as const) {
      const v = optStr(b[k], k, k === 'description' ? 2000 : 120);
      if (v !== undefined) patch[k] = v;
    }
    return { system: await ctx.core.systems.update(ctx.params.systemId!, patch) };
  });

  r.post('/api/systems/:systemId/switch', async (ctx) => ({ system: await ctx.core.systems.switchTo(ctx.params.systemId!) }));
  r.post('/api/systems/:systemId/check', async (ctx) => {
    await ctx.core.systems.checkAvailability(ctx.params.systemId!);
    return { system: ctx.core.systems.get(ctx.params.systemId!) };
  });
  r.post('/api/systems/:systemId/disconnect', async (ctx) => ({ system: await ctx.core.systems.disconnect(ctx.params.systemId!, policy(body(ctx).activeRuns)) }));
  r.post('/api/systems/:systemId/reconnect', async (ctx) => ({ system: await ctx.core.systems.reconnect(ctx.params.systemId!) }));
  r.post('/api/systems/:systemId/relocate', async (ctx) => ({ system: await ctx.core.systems.relocate(ctx.params.systemId!, str(body(ctx).storagePath, 'storagePath')) }));
  r.post('/api/systems/:systemId/forget', async (ctx) => {
    await ctx.core.systems.forget(ctx.params.systemId!, policy(body(ctx).activeRuns));
    return { ok: true };
  });
  r.get('/api/systems/:systemId/deletion-plan', async (ctx) => ({ plan: await ctx.core.systems.deletionPlan(ctx.params.systemId!) }));
  r.post('/api/systems/:systemId/delete-data', async (ctx) => {
    const b = body(ctx);
    const mode = b.mode === 'everything' ? 'everything' : b.mode === 'service-data' ? 'service-data' : null;
    if (!mode) throw new AppError('VALIDATION_FAILED', 'Choose the deletion mode: service-data or everything.');
    return ctx.core.systems.deleteData(ctx.params.systemId!, { mode, confirmName: str(b.confirmName, 'confirmName'), activeRuns: policy(b.activeRuns) });
  });

  r.get('/api/systems/:systemId/settings', async (ctx) => {
    const rt = await sys(ctx);
    return { settings: rt.settings.resolvedAll() };
  });
  r.put('/api/systems/:systemId/settings/:key', async (ctx) => {
    const rt = await sys(ctx);
    rt.settings.set(ctx.params.key!, body<{ value: unknown }>(ctx).value);
    rt.audit.record({ actor: 'user', action: 'settings.system.set', target: ctx.params.key! });
    rt.emit('settings.changed', { scope: 'system', key: ctx.params.key });
    return { setting: rt.settings.resolve(ctx.params.key!) };
  });
  r.delete('/api/systems/:systemId/settings/:key', async (ctx) => {
    const rt = await sys(ctx);
    rt.settings.reset(ctx.params.key!);
    rt.emit('settings.changed', { scope: 'system', key: ctx.params.key });
    return { setting: rt.settings.resolve(ctx.params.key!) };
  });

  r.get('/api/systems/:systemId/audit', async (ctx) => {
    const rt = await sys(ctx);
    const before = ctx.query.get('before');
    const runId = ctx.query.get('runId');
    const action = ctx.query.get('action');
    return { entries: rt.audit.list({ limit: 200, ...(before ? { before: Number(before) } : {}), ...(runId ? { runId } : {}), ...(action ? { action } : {}) }) };
  });
  r.get('/api/systems/:systemId/errors', async (ctx) => ({ errors: (await sys(ctx)).audit.errors(200) }));
  r.get('/api/systems/:systemId/integrity', async (ctx) => ({ problems: (await sys(ctx)).integrity() }));
}
