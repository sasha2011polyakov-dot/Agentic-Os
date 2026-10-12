import { AppError } from '@aos/core';
import { services, integrityReport, NativeDialog, listDirectories, RELATIONS, type GraphQuery } from '@aos/core/internal';
import type { Router } from '../http/router.ts';
import { raw } from '../http/router.ts';
import { body, bool, int, optStr, str, sys } from './util.ts';

const dialog = new NativeDialog();

function list(v: string | null): string[] | undefined {
  if (!v) return undefined;
  const items = v.split(',').map((x) => x.trim()).filter(Boolean);
  return items.length ? items : undefined;
}

function strArray(v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new AppError('VALIDATION_FAILED', 'Ожидается список строк.');
  return v as string[];
}

export function registerFsRoutes(r: Router): void {
  r.get('/api/fs/dialog', async () => dialog.availability());
  r.post('/api/fs/pick-directory', async (ctx) => {
    const b = body(ctx);
    const avail = await dialog.availability();
    if (!avail.native) return { path: null, native: false };
    return { path: await dialog.pickDirectory(optStr(b.title, 'title', 200) ?? 'Выберите папку'), native: true };
  });
  r.get('/api/fs/list', async (ctx) => {
    try {
      return await listDirectories(ctx.query.get('path') ?? undefined);
    } catch (e) {
      throw new AppError('SOURCE_NOT_ACCESSIBLE', 'Папку нельзя открыть.', { details: { path: ctx.query.get('path'), reason: e instanceof Error ? e.message : String(e) } });
    }
  });
}

export function registerSourceRoutes(r: Router): void {
  r.get('/api/systems/:systemId/sources', async (ctx) => ({ sources: services(await sys(ctx)).sources.list() }));
  r.post('/api/systems/:systemId/sources/preview', async (ctx) => {
    const b = body(ctx);
    const rules: { includeGlobs?: string[]; excludeGlobs?: string[]; respectGitignore?: boolean; maxFileBytes?: number } = {};
    const inc = strArray(b.includeGlobs);
    const exc = strArray(b.excludeGlobs);
    if (inc) rules.includeGlobs = inc;
    if (exc) rules.excludeGlobs = exc;
    if (typeof b.respectGitignore === 'boolean') rules.respectGitignore = b.respectGitignore;
    if (typeof b.maxFileBytes === 'number') rules.maxFileBytes = b.maxFileBytes;
    return { preview: await services(await sys(ctx)).sources.preview(str(b.path, 'path'), rules) };
  });
  r.post('/api/systems/:systemId/sources', async (ctx) => {
    const b = body(ctx);
    const input: Parameters<ReturnType<typeof services>['sources']['connect']>[0] = { path: str(b.path, 'path') };
    const name = optStr(b.name, 'name', 120);
    if (name) input.name = name;
    const purpose = optStr(b.purpose, 'purpose', 1000);
    if (purpose) input.purpose = purpose;
    const category = optStr(b.category, 'category', 100);
    if (category) input.category = category;
    const inc = strArray(b.includeGlobs);
    if (inc) input.includeGlobs = inc;
    const exc = strArray(b.excludeGlobs);
    if (exc) input.excludeGlobs = exc;
    if (typeof b.respectGitignore === 'boolean') input.respectGitignore = b.respectGitignore;
    if (typeof b.maxFileBytes === 'number') input.maxFileBytes = b.maxFileBytes;
    if (typeof b.confidential === 'boolean') input.confidential = b.confidential;
    if (typeof b.watch === 'boolean') input.watch = b.watch;
    return { source: await services(await sys(ctx)).sources.connect(input) };
  });
  r.get('/api/systems/:systemId/sources/:id', async (ctx) => ({ source: services(await sys(ctx)).sources.get(ctx.params.id!) }));
  r.patch('/api/systems/:systemId/sources/:id', async (ctx) => {
    const b = body(ctx);
    const patch: Record<string, unknown> = {};
    for (const k of ['name', 'purpose', 'category'] as const) if (typeof b[k] === 'string') patch[k] = b[k];
    for (const k of ['confidential', 'watch', 'respectGitignore', 'writable'] as const) if (typeof b[k] === 'boolean') patch[k] = b[k];
    if (typeof b.maxFileBytes === 'number') patch.maxFileBytes = b.maxFileBytes;
    const inc = strArray(b.includeGlobs);
    if (inc) patch.includeGlobs = inc;
    const exc = strArray(b.excludeGlobs);
    if (exc) patch.excludeGlobs = exc;
    return { source: await services(await sys(ctx)).sources.update(ctx.params.id!, patch) };
  });
  r.delete('/api/systems/:systemId/sources/:id', async (ctx) => {
    await services(await sys(ctx)).sources.disconnect(ctx.params.id!);
    return { ok: true };
  });
  r.post('/api/systems/:systemId/sources/:id/reindex', async (ctx) => {
    const s = services(await sys(ctx));
    const force = bool(body(ctx).force);
    s.sources.get(ctx.params.id!);
    void s.sources.reindex(ctx.params.id!, force).catch(() => undefined);
    return { started: true };
  });
  r.post('/api/systems/:systemId/sources/:id/cancel', async (ctx) => {
    services(await sys(ctx)).indexer.cancel(ctx.params.id!);
    return { ok: true };
  });
  r.post('/api/systems/:systemId/sources/:id/check', async (ctx) => ({ source: await services(await sys(ctx)).sources.checkAvailability(ctx.params.id!) }));
  r.get('/api/systems/:systemId/sources/:id/tree', async (ctx) => services(await sys(ctx)).sources.tree(ctx.params.id!, ctx.query.get('dir') ?? ''));
  r.get('/api/systems/:systemId/sources/:id/files', async (ctx) => {
    const opts: { status?: string; q?: string; limit?: number; offset?: number } = { limit: int(ctx.query.get('limit'), 200, 2000), offset: int(ctx.query.get('offset'), 0, 1_000_000) };
    const st = ctx.query.get('status');
    if (st) opts.status = st;
    const q = ctx.query.get('q');
    if (q) opts.q = q;
    return services(await sys(ctx)).sources.files(ctx.params.id!, opts);
  });
  r.get('/api/systems/:systemId/sources/:id/file', async (ctx) => services(await sys(ctx)).sources.readFile(ctx.params.id!, ctx.query.get('path') ?? ''));
  r.get('/api/systems/:systemId/sources/:id/git', async (ctx) => ({ git: await services(await sys(ctx)).sources.gitInfo(ctx.params.id!) }));
}

export function registerDocRoutes(r: Router): void {
  r.get('/api/systems/:systemId/docs', async (ctx) => {
    const q = ctx.query;
    const opts: Parameters<ReturnType<typeof services>['docs']['list']>[0] = { limit: int(q.get('limit'), 100, 1000), offset: int(q.get('offset'), 0, 1_000_000) };
    for (const k of ['sourceId', 'folder', 'tag', 'type'] as const) {
      const v = q.get(k);
      if (v) opts[k] = v;
    }
    const sort = q.get('sort');
    if (sort === 'title' || sort === 'updated' || sort === 'path') opts.sort = sort;
    const pk = q.get('propKey');
    if (pk) opts.property = q.get('propValue') !== null ? { key: pk, value: q.get('propValue')! } : { key: pk };
    return services(await sys(ctx)).docs.list(opts);
  });
  r.get('/api/systems/:systemId/docs/table', async (ctx) => {
    const q = ctx.query;
    const opts: Parameters<ReturnType<typeof services>['docs']['table']>[0] = { columns: list(q.get('columns')) ?? [], limit: int(q.get('limit'), 500, 2000) };
    for (const k of ['sourceId', 'type', 'tag'] as const) {
      const v = q.get(k);
      if (v) opts[k] = v;
    }
    return services(await sys(ctx)).docs.table(opts);
  });
  r.get('/api/systems/:systemId/docs/suggest', async (ctx) => ({ items: services(await sys(ctx)).docs.suggest(ctx.query.get('q') ?? '', int(ctx.query.get('limit'), 20, 100)) }));
  r.get('/api/systems/:systemId/docs/resolve', async (ctx) => services(await sys(ctx)).docs.resolve(ctx.query.get('target') ?? '', ctx.query.get('from') ?? undefined));
  r.post('/api/systems/:systemId/docs', async (ctx) => {
    const b = body(ctx);
    const input: Parameters<ReturnType<typeof services>['docs']['create']>[0] = { title: str(b.title, 'title', { max: 200 }) };
    const folder = optStr(b.folder, 'folder', 500);
    if (folder !== undefined) input.folder = folder;
    const templateId = optStr(b.templateId, 'templateId', 500);
    if (templateId) input.templateId = templateId;
    const content = optStr(b.content, 'content', 5_000_000);
    if (content) input.content = content;
    if (b.properties && typeof b.properties === 'object' && !Array.isArray(b.properties)) input.properties = b.properties as Record<string, unknown>;
    return { doc: await services(await sys(ctx)).docs.create(input) };
  });
  r.get('/api/systems/:systemId/docs/:docId', async (ctx) => ({ doc: await services(await sys(ctx)).docs.get(ctx.params.docId!) }));
  r.put(
    '/api/systems/:systemId/docs/:docId',
    async (ctx) => {
      const b = body(ctx);
      return services(await sys(ctx)).docs.save(ctx.params.docId!, str(b.content, 'content', { optional: true, max: 10_000_000 }), str(b.expectedHash, 'expectedHash'));
    },
    { maxBodyBytes: 12 * 1024 * 1024 },
  );
  r.patch('/api/systems/:systemId/docs/:docId/properties', async (ctx) => {
    const b = body(ctx);
    if (!b.patch || typeof b.patch !== 'object' || Array.isArray(b.patch)) throw new AppError('VALIDATION_FAILED', 'Ожидается объект patch.');
    return services(await sys(ctx)).docs.updateProperties(ctx.params.docId!, b.patch as Record<string, unknown>, str(b.expectedHash, 'expectedHash'));
  });
  r.post('/api/systems/:systemId/docs/:docId/rename-plan', async (ctx) => ({ plan: await services(await sys(ctx)).docs.planRename(ctx.params.docId!, str(body(ctx).to, 'to', { max: 1000 })) }));
  r.post('/api/systems/:systemId/docs/:docId/rename', async (ctx) => {
    const b = body(ctx);
    const opts: { updateLinks: boolean; planHash?: string } = { updateLinks: b.updateLinks !== false };
    const ph = optStr(b.planHash, 'planHash', 100);
    if (ph) opts.planHash = ph;
    return services(await sys(ctx)).docs.rename(ctx.params.docId!, str(b.to, 'to', { max: 1000 }), opts);
  });
  r.delete('/api/systems/:systemId/docs/:docId', async (ctx) => services(await sys(ctx)).docs.delete(ctx.params.docId!));
  r.get('/api/systems/:systemId/docs/:docId/versions', async (ctx) => ({ versions: services(await sys(ctx)).docs.versions(ctx.params.docId!) }));
  r.get('/api/systems/:systemId/versions/:versionId', async (ctx) => ({ version: services(await sys(ctx)).docs.version(Number(ctx.params.versionId)) }));
  r.post('/api/systems/:systemId/docs/:docId/restore', async (ctx) => {
    const b = body(ctx);
    if (typeof b.versionId !== 'number') throw new AppError('VALIDATION_FAILED', 'Укажите versionId.');
    return services(await sys(ctx)).docs.restore(ctx.params.docId!, b.versionId, str(b.expectedHash, 'expectedHash'));
  });
  r.get('/api/systems/:systemId/docs/:docId/unlinked', async (ctx) => ({ mentions: services(await sys(ctx)).docs.unlinkedMentions(ctx.params.docId!) }));
  r.post('/api/systems/:systemId/daily', async (ctx) => {
    const d = optStr(body(ctx).date, 'date', 10);
    const date = d ? new Date(`${d}T12:00:00`) : new Date();
    if (Number.isNaN(date.getTime())) throw new AppError('VALIDATION_FAILED', 'Неверная дата.');
    return { doc: await services(await sys(ctx)).docs.daily(date) };
  });
  r.get('/api/systems/:systemId/folders', async (ctx) => ({ folders: await services(await sys(ctx)).docs.folders() }));
  r.post('/api/systems/:systemId/folders', async (ctx) => ({ path: await services(await sys(ctx)).docs.createFolder(str(body(ctx).path, 'path', { max: 500 })) }));
  r.get('/api/systems/:systemId/templates', async (ctx) => ({ templates: services(await sys(ctx)).docs.templates().map(({ content, ...t }) => ({ ...t, preview: content.slice(0, 600) })) }));
  r.get('/api/systems/:systemId/tags', async (ctx) => ({ tags: services(await sys(ctx)).docs.tags() }));
  r.post(
    '/api/systems/:systemId/attachments',
    async (ctx) => {
      const b = body(ctx);
      const data = str(b.data, 'data', { max: 30 * 1024 * 1024 });
      return services(await sys(ctx)).docs.uploadAttachment(str(b.name, 'name', { max: 200 }), Buffer.from(data, 'base64'));
    },
    { maxBodyBytes: 30 * 1024 * 1024 },
  );
  r.get('/api/systems/:systemId/attachment', async (ctx) => {
    const a = await services(await sys(ctx)).docs.attachment(ctx.query.get('target') ?? '', ctx.query.get('from') ?? undefined);
    return raw(a.bytes, { 'content-type': a.mime, 'content-disposition': 'inline', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
  });
  r.get('/api/systems/:systemId/search', async (ctx) => {
    const q = ctx.query;
    const opts: Parameters<ReturnType<typeof services>['search']['search']>[1] = { limit: int(q.get('limit'), 50, 500), offset: int(q.get('offset'), 0, 1_000_000) };
    const s = q.get('sort');
    if (s === 'relevance' || s === 'updated' || s === 'title') opts.sort = s;
    const sourceIds = list(q.get('sourceIds'));
    if (sourceIds) opts.sourceIds = sourceIds;
    const types = list(q.get('types'));
    if (types) opts.types = types;
    const tags = list(q.get('tags'));
    if (tags) opts.tags = tags;
    return services(await sys(ctx)).search.search(q.get('q') ?? '', opts);
  });
  r.get('/api/systems/:systemId/integrity/report', async (ctx) => {
    const rt = await sys(ctx);
    return integrityReport(rt, services(rt).graph);
  });
}

export function registerGraphRoutes(r: Router): void {
  const graphQuery = (q: URLSearchParams): GraphQuery => {
    const gq: GraphQuery = { limit: int(q.get('limit'), 1500, 20000) };
    const types = list(q.get('types'));
    if (types) gq.types = types;
    const relations = list(q.get('relations'));
    if (relations) gq.relations = relations;
    const sourceIds = list(q.get('sourceIds'));
    if (sourceIds) gq.sourceIds = sourceIds;
    const tags = list(q.get('tags'));
    if (tags) gq.tags = tags;
    const origins = list(q.get('origins'));
    if (origins) gq.origins = origins;
    const search = q.get('search');
    if (search) gq.search = search;
    const from = q.get('from');
    if (from) gq.updatedFrom = from;
    const to = q.get('to');
    if (to) gq.updatedTo = to;
    gq.includeSuggested = q.get('includeSuggested') === '1';
    gq.includeUnresolved = q.get('includeUnresolved') === '1';
    gq.includeTags = q.get('includeTags') === '1';
    return gq;
  };
  r.get('/api/graph/relations', () => ({ relations: RELATIONS }));
  r.get('/api/systems/:systemId/graph', async (ctx) => services(await sys(ctx)).graph.graph(graphQuery(ctx.query)));
  r.get('/api/systems/:systemId/graph/local', async (ctx) => services(await sys(ctx)).graph.local(str(ctx.query.get('node'), 'node'), int(ctx.query.get('depth'), 1, 4), graphQuery(ctx.query)));
  r.get('/api/systems/:systemId/graph/path', async (ctx) => ({ path: services(await sys(ctx)).graph.path(str(ctx.query.get('from'), 'from'), str(ctx.query.get('to'), 'to')) }));
  r.get('/api/systems/:systemId/graph/cycles', async (ctx) => {
    const g = services(await sys(ctx)).graph;
    return { cycles: g.cycles(list(ctx.query.get('relations'))).map((c) => g.nodesByIds(c)) };
  });
  r.get('/api/systems/:systemId/graph/orphans', async (ctx) => services(await sys(ctx)).graph.orphans());
  r.get('/api/systems/:systemId/graph/stats', async (ctx) => services(await sys(ctx)).graph.stats());
  r.get('/api/systems/:systemId/graph/suggestions', async (ctx) => ({ suggestions: services(await sys(ctx)).graph.suggestions() }));
  r.get('/api/systems/:systemId/graph/node', async (ctx) => {
    const g = services(await sys(ctx)).graph;
    const id = str(ctx.query.get('id'), 'id');
    const node = g.getNode(id);
    if (!node) throw new AppError('NOT_FOUND', 'Узел графа не найден.');
    const { incoming, outgoing } = g.edgesOf(id);
    const others = g.nodesByIds([...new Set([...incoming.map((e) => e.src), ...outgoing.map((e) => e.dst)])]);
    return { node, incoming, outgoing, nodes: others };
  });
  r.post('/api/systems/:systemId/graph/edges', async (ctx) => {
    const rt = await sys(ctx);
    const b = body(ctx);
    const relation = str(b.relation, 'relation', { max: 40 });
    if (!RELATIONS.some((x) => x.id === relation)) throw new AppError('VALIDATION_FAILED', 'Неизвестный тип связи.');
    const id = services(rt).graph.addEdge({ src: str(b.src, 'src'), dst: str(b.dst, 'dst'), relation, origin: 'explicit', createdBy: 'user', evidence: optStr(b.note, 'note', 500) ?? null });
    rt.audit.record({ actor: 'user', action: 'graph.edge.create', target: id, details: { src: b.src, dst: b.dst, relation } });
    rt.emit('graph.changed', { edge: id });
    return { id };
  });
  r.delete('/api/systems/:systemId/graph/edges/:edgeId', async (ctx) => {
    const rt = await sys(ctx);
    const e = rt.db.get<{ derived_key: string | null; created_by: string | null }>('SELECT derived_key, created_by FROM graph_edges WHERE id = ?', ctx.params.edgeId!);
    if (!e) throw new AppError('NOT_FOUND', 'Связь не найдена.');
    if (e.derived_key) throw new AppError('VALIDATION_FAILED', 'Эта связь построена из содержимого документа. Измените ссылку в самом документе.');
    services(rt).graph.removeEdge(ctx.params.edgeId!);
    rt.audit.record({ actor: 'user', action: 'graph.edge.delete', target: ctx.params.edgeId! });
    rt.emit('graph.changed', {});
    return { ok: true };
  });
  r.post('/api/systems/:systemId/graph/suggestions/:edgeId', async (ctx) => {
    const rt = await sys(ctx);
    const decision = body(ctx).decision;
    if (decision !== 'confirmed' && decision !== 'rejected') throw new AppError('VALIDATION_FAILED', 'decision: confirmed или rejected.');
    const edge = services(rt).graph.reviewSuggestion(ctx.params.edgeId!, decision);
    rt.audit.record({ actor: 'user', action: `graph.suggestion.${decision}`, target: edge.id });
    rt.emit('graph.changed', {});
    return { edge };
  });
  r.post('/api/systems/:systemId/graph/rebuild', async (ctx) => {
    const rt = await sys(ctx);
    const changed = services(rt).indexer.rebuildAllEdges();
    rt.audit.record({ actor: 'user', action: 'graph.rebuild', details: { changed } });
    rt.emit('graph.changed', {});
    return { changed, problems: services(rt).graph.integrity() };
  });
}
