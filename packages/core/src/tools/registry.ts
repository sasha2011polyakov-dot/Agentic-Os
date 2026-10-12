import type { SystemRuntime } from '../systems/runtime.ts';
import type { SystemManager } from '../systems/manager.ts';
import type { WebResearch } from '../research/web.ts';
import { services } from '../wiring.ts';
import { AppError, errorMessage, toAppError } from '../util/errors.ts';
import { validator, formatErrors } from '../agents/schema.ts';
import type { PermissionGuard, PermissionRequirement, RunScope } from '../agents/permissions.ts';
import { projectInventory } from '../sources/inventory.ts';
import { compareSources } from '../research/grounding.ts';
import { docNodeId } from '../graph/graph.ts';
import { shortHash } from '../util/hash.ts';
import { redactValue } from '../util/redact.ts';
import { detectInjection } from '../security/injection.ts';
import { newId } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import { runCheck } from '../missions/checks.ts';
import { PERMISSION_IDS, type PermissionId } from '../agents/permissions.ts';
import { TASK_TYPES, type TaskType } from '../ai/types.ts';

export interface ToolContext {
  rt: SystemRuntime;
  agentId: string;
  runId: string | null;
  stepId: string | null;
  scope: RunScope;
  signal?: AbortSignal;
  web: WebResearch;
  systems: SystemManager;
  guard: PermissionGuard;
  onEvent?: (e: { type: string; message: string; data?: unknown }) => void;
}

export interface ToolDefinition<I = Record<string, unknown>, O = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissions(input: I, ctx: ToolContext): PermissionRequirement[];
  execute(input: I, ctx: ToolContext): Promise<O>;
}

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const int = (description: string, min: number, max: number) => ({ type: 'integer', description, minimum: min, maximum: max });

function clip(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** Resolves the runtime a tool call targets: the home system, or an extra system explicitly selected for the run. */
async function targetRuntime(ctx: ToolContext, systemId: string | undefined): Promise<SystemRuntime> {
  if (!systemId || systemId === ctx.rt.systemId) return ctx.rt;
  if (!ctx.scope.extraSystems.includes(systemId)) throw new AppError('CROSS_SYSTEM_DENIED');
  return ctx.systems.runtime(systemId);
}

function docSource(rt: SystemRuntime, docId: string): { sourceId: string; kind: string; confidential: number } {
  const r = rt.db.get<{ source_id: string; kind: string; confidential: number }>('SELECT d.source_id, s.kind, s.confidential FROM documents d JOIN sources s ON s.id = d.source_id WHERE d.id = ?', docId);
  if (!r) throw new AppError('NOT_FOUND', `Документ ${docId} не найден.`);
  return { sourceId: r.source_id, kind: r.kind, confidential: r.confidential };
}

/** Sources the agent may read in the home system: run scope (if set) — vault always included for reading. */
function readableSources(ctx: ToolContext): string[] | null {
  if (!ctx.scope.sourceIds.length) return null;
  return [...new Set([...ctx.scope.sourceIds, ctx.rt.primaryVaultId()])];
}

/** Latest version of a file proposed in this mission's still-unapplied change sets, if any. */
function proposedVersion(ctx: ToolContext, sourceId: string, path: string): { op: string; text: string } | null {
  if (!ctx.scope.missionId) return null;
  const row = ctx.rt.db.get<{ op: string; new_blob: string | null }>(
    `SELECT f.op, f.new_blob FROM change_set_files f JOIN change_sets s ON s.id = f.change_set_id
      WHERE s.mission_id = ? AND s.status = 'proposed' AND f.source_id = ? AND f.rel_path = ? ORDER BY s.created_at DESC LIMIT 1`,
    ctx.scope.missionId,
    sourceId,
    path,
  );
  if (!row) return null;
  return { op: row.op, text: row.new_blob ? (ctx.rt.history.getBlob(row.new_blob) ?? '') : '' };
}

export const TOOLS: ToolDefinition<any, any>[] = [
  {
    name: 'search_documents',
    description: 'Полнотекстовый поиск по документам системы (поддерживает операторы tag:, type:, path:, "фраза"). Возвращает фрагменты с найденным текстом.',
    inputSchema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: str('Поисковый запрос', { minLength: 1, maxLength: 500 }), limit: int('Сколько результатов вернуть', 1, 30), systemId: str('ID другой системы (только если выбрана для запуска)') } },
    permissions: (i: { systemId?: string }, ctx) => [{ permission: 'search.use' }, { permission: 'documents.read', ...(i.systemId && i.systemId !== ctx.rt.systemId ? { systemId: i.systemId } : {}) }],
    async execute(i: { query: string; limit?: number; systemId?: string }, ctx) {
      const rt = await targetRuntime(ctx, i.systemId);
      const allowed = rt === ctx.rt ? readableSources(ctx) : null;
      const res = services(rt).search.search(i.query, { limit: i.limit ?? 10, ...(allowed ? { sourceIds: allowed } : {}) });
      return {
        total: res.total,
        hits: res.hits.map((h) => ({ systemId: rt.systemId, docId: h.docId, title: h.title, path: h.relPath, source: h.sourceName, type: h.docType, snippet: (h.snippet ?? '').replace(/\u0002|\u0003/g, '') })),
      };
    },
  },
  {
    name: 'read_document',
    description: 'Читает документ по docId (текст может быть усечён до maxChars).',
    inputSchema: { type: 'object', required: ['docId'], additionalProperties: false, properties: { docId: str('ID документа'), maxChars: int('Максимум символов', 500, 60000), systemId: str('ID другой системы') } },
    permissions: (i: { docId: string; systemId?: string }, ctx) => {
      if (i.systemId && i.systemId !== ctx.rt.systemId) return [{ permission: 'documents.read', systemId: i.systemId }];
      const s = docSource(ctx.rt, i.docId);
      return [{ permission: s.kind === 'project' ? 'projects.read' : 'documents.read', ...(s.kind === 'project' ? { sourceId: s.sourceId } : {}) }];
    },
    async execute(i: { docId: string; maxChars?: number; systemId?: string }, ctx) {
      const rt = await targetRuntime(ctx, i.systemId);
      const d = await services(rt).docs.get(i.docId);
      const c = clip(d.content, i.maxChars ?? 20000);
      return { systemId: rt.systemId, docId: d.id, title: d.title, path: d.relPath, source: d.sourceName, type: d.docType, properties: d.frontmatter, content: c.text, truncated: c.truncated };
    },
  },
  {
    name: 'list_documents',
    description: 'Список документов с фильтрами (тип, тег, папка, источник).',
    inputSchema: { type: 'object', additionalProperties: false, properties: { type: str('Тип документа'), tag: str('Тег'), folder: str('Папка'), sourceId: str('ID источника'), limit: int('Лимит', 1, 200) } },
    permissions: (i: { sourceId?: string }) => [{ permission: 'documents.read', ...(i.sourceId ? { sourceId: i.sourceId } : {}) }],
    async execute(i: { type?: string; tag?: string; folder?: string; sourceId?: string; limit?: number }, ctx) {
      const allowed = readableSources(ctx);
      const res = services(ctx.rt).docs.list({ ...i, limit: i.limit ?? 50 });
      return { total: res.total, items: res.items.filter((d) => !allowed || allowed.includes(d.sourceId)).map((d) => ({ docId: d.id, title: d.title, path: d.relPath, type: d.docType, status: d.status, tags: d.tags })) };
    },
  },
  {
    name: 'project_inventory',
    description: 'Детерминированная инвентаризация проекта: языки, манифесты, точки входа, тесты, документация, пропущенные файлы.',
    inputSchema: { type: 'object', required: ['sourceId'], additionalProperties: false, properties: { sourceId: str('ID подключённого проекта') } },
    permissions: (i: { sourceId: string }) => [{ permission: 'projects.read', sourceId: i.sourceId }],
    async execute(i: { sourceId: string }, ctx) {
      return projectInventory(ctx.rt, i.sourceId);
    },
  },
  {
    name: 'list_project_files',
    description: 'Содержимое папки проекта (из индекса): подпапки и файлы со статусом индексации.',
    inputSchema: { type: 'object', required: ['sourceId'], additionalProperties: false, properties: { sourceId: str('ID проекта'), dir: str('Относительный путь папки') } },
    permissions: (i: { sourceId: string }) => [{ permission: 'projects.read', sourceId: i.sourceId }],
    async execute(i: { sourceId: string; dir?: string }, ctx) {
      const t = services(ctx.rt).sources.tree(i.sourceId, i.dir ?? '');
      return { path: t.path, folders: t.folders.slice(0, 200), files: t.files.slice(0, 300).map((f) => ({ name: f.name, path: f.path, kind: f.kind, status: f.status, skipReason: f.skipReason })) };
    },
  },
  {
    name: 'read_project_file',
    description: 'Читает файл проекта (только проиндексированные, не секретные файлы).',
    inputSchema: { type: 'object', required: ['sourceId', 'path'], additionalProperties: false, properties: { sourceId: str('ID проекта'), path: str('Относительный путь'), maxChars: int('Максимум символов', 500, 60000) } },
    permissions: (i: { sourceId: string }) => [{ permission: 'projects.read', sourceId: i.sourceId }],
    async execute(i: { sourceId: string; path: string; maxChars?: number }, ctx) {
      const f = ctx.rt.db.get<{ status: string; skip_reason: string | null }>('SELECT status, skip_reason FROM files WHERE source_id = ? AND rel_path = ?', i.sourceId, i.path);
      if (!f) {
        const created = proposedVersion(ctx, i.sourceId, i.path);
        if (created && created.op === 'create') return { sourceId: i.sourceId, path: i.path, content: clip(created.text, i.maxChars ?? 20000).text, proposed: true, note: 'Файл создан в предложенном наборе изменений (ещё не применён).' };
        throw new AppError('NOT_FOUND', `Файл ${i.path} не найден в индексе.`);
      }
      if (f.status !== 'indexed') throw new AppError('PERMISSION_DENIED', `Файл не читается: ${f.skip_reason ?? f.status}.`);
      const r = await services(ctx.rt).sources.readFile(i.sourceId, i.path);
      // inside a mission, later steps see the version proposed by earlier steps (not yet applied to disk)
      const overlay = proposedVersion(ctx, i.sourceId, i.path);
      if (overlay) {
        if (overlay.op === 'delete') return { sourceId: i.sourceId, path: i.path, content: '', deletedInProposal: true, note: 'Файл предложено удалить в текущем наборе изменений (не применено).' };
        const c = clip(overlay.text, i.maxChars ?? 20000);
        return { sourceId: i.sourceId, path: i.path, content: c.text, truncated: c.truncated, proposed: true, note: 'Показана предложенная в этом поручении версия (ещё не применена к диску).' };
      }
      const c = clip(r.text, i.maxChars ?? 20000);
      return { sourceId: i.sourceId, path: i.path, content: c.text, truncated: c.truncated };
    },
  },
  {
    name: 'graph_neighbors',
    description: 'Связи документа в графе знаний (входящие и исходящие, с типом связи).',
    inputSchema: { type: 'object', required: ['docId'], additionalProperties: false, properties: { docId: str('ID документа'), depth: int('Глубина', 1, 2) } },
    permissions: () => [{ permission: 'graph.read' }],
    async execute(i: { docId: string; depth?: number }, ctx) {
      const g = services(ctx.rt).graph.local(docNodeId(i.docId), i.depth ?? 1, { includeUnresolved: true, limit: 200 });
      return { nodes: g.nodes.map((n) => ({ id: n.id, type: n.type, label: n.label, path: n.props.path ?? null })), edges: g.edges.map((e) => ({ from: e.src, to: e.dst, relation: e.relation, origin: e.origin })) };
    },
  },
  {
    name: 'create_document',
    description: 'Создаёт новый документ в разрешённой папке хранилища. Существующие документы не изменяет.',
    inputSchema: { type: 'object', required: ['title', 'content'], additionalProperties: false, properties: { title: str('Название', { maxLength: 200 }), folder: str('Папка'), content: str('Markdown', { maxLength: 500000 }), templateId: str('ID шаблона') } },
    permissions: (i: { folder?: string }, ctx) => [{ permission: 'documents.create', folder: i.folder ?? ctx.scope.outputFolder ?? '' }],
    async execute(i: { title: string; folder?: string; content: string; templateId?: string }, ctx) {
      const d = await services(ctx.rt).docs.create({ title: i.title, folder: i.folder ?? ctx.scope.outputFolder ?? '', content: i.content, ...(i.templateId ? { templateId: i.templateId } : {}), actor: `agent:${ctx.agentId}` });
      return { docId: d.id, path: d.relPath };
    },
  },
  {
    name: 'web_search',
    description: 'Поиск в интернете через настроенного провайдера. Возвращает URL, заголовок и фрагмент.',
    inputSchema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: str('Запрос', { minLength: 2, maxLength: 400 }), limit: int('Лимит', 1, 20) } },
    permissions: () => [{ permission: 'web.search' }, { permission: 'network.fetch' }],
    async execute(i: { query: string; limit?: number }, ctx) {
      const results = await ctx.web.search(i.query, i.limit ?? 8, ctx.signal, ctx.rt.systemId);
      return { results };
    },
  },
  ...['open_url', 'extract_page_content', 'fetch_documentation'].map(
    (name): ToolDefinition<{ url: string; maxChars?: number }> => ({
      name,
      description:
        name === 'open_url'
          ? 'Открывает публичную веб-страницу и возвращает её основной текст. Источник сохраняется для проверки цитат.'
          : name === 'fetch_documentation'
            ? 'Загружает страницу документации по URL (основной текст и ссылки на соседние разделы).'
            : 'Извлекает основной текст страницы (без навигации, скриптов и рекламы).',
      inputSchema: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: str('HTTPS-адрес', { maxLength: 2000 }), maxChars: int('Максимум символов', 1000, 60000) } },
      permissions: (i) => {
        let domain: string | undefined;
        try {
          domain = new URL(i.url).hostname;
        } catch {
          domain = undefined;
        }
        return [{ permission: 'network.fetch', ...(domain ? { domain } : {}) }];
      },
      async execute(i, ctx) {
        const p = await ctx.web.fetchAndStore(ctx.rt, i.url, { maxChars: i.maxChars ?? 15000, ...(ctx.signal ? { signal: ctx.signal } : {}) });
        return { url: p.url, finalUrl: p.finalUrl, title: p.title, publishedAt: p.publishedAt, retrievedAt: p.retrievedAt, content: name === 'fetch_documentation' ? p.markdown : p.text, truncated: p.truncated, ...(name === 'fetch_documentation' ? { links: p.links.slice(0, 30) } : {}) };
      },
    }),
  ),
  {
    name: 'search_github',
    description: 'Поиск репозиториев (без токена) или кода (нужен токен) на GitHub.',
    inputSchema: { type: 'object', required: ['query'], additionalProperties: false, properties: { query: str('Запрос GitHub search', { maxLength: 300 }), type: { enum: ['repositories', 'code'] }, limit: int('Лимит', 1, 30) } },
    permissions: () => [{ permission: 'external.api' }, { permission: 'network.fetch', domain: 'api.github.com' }],
    async execute(i: { query: string; type?: 'repositories' | 'code'; limit?: number }, ctx) {
      const gh = await ctx.web.github();
      return { results: await gh.search(i.query, i.type ?? 'repositories', i.limit ?? 10, ctx.signal, ctx.rt.systemId) };
    },
  },
  {
    name: 'inspect_repository',
    description: 'Сведения о публичном репозитории GitHub: описание, язык, лицензия, README, файлы верхнего уровня.',
    inputSchema: { type: 'object', required: ['owner', 'repo'], additionalProperties: false, properties: { owner: str('Владелец'), repo: str('Репозиторий') } },
    permissions: () => [{ permission: 'external.api' }, { permission: 'network.fetch', domain: 'api.github.com' }],
    async execute(i: { owner: string; repo: string }, ctx) {
      const gh = await ctx.web.github();
      return gh.inspect(i.owner, i.repo, ctx.signal, ctx.rt.systemId);
    },
  },
  {
    name: 'compare_sources',
    description: 'Проверяет КОДОМ, что каждая цитата дословно присутствует в ранее загруженном источнике. Возвращает verified / not_found_in_source / source_missing.',
    inputSchema: {
      type: 'object',
      required: ['claims'],
      additionalProperties: false,
      properties: { claims: { type: 'array', maxItems: 100, items: { type: 'object', required: ['statement', 'quote', 'sourceUrl'], additionalProperties: false, properties: { statement: str('Утверждение'), quote: str('Дословная цитата'), sourceUrl: str('URL источника') } } } },
    },
    permissions: () => [],
    async execute(i: { claims: { statement: string; quote: string; sourceUrl: string }[] }, ctx) {
      const texts = ctx.web.storedTexts(ctx.rt, i.claims.map((c) => c.sourceUrl));
      return compareSources(i.claims, texts);
    },
  },
  {
    name: 'save_research_note',
    description: 'Сохраняет отчёт исследования в папку исследований системы (новый документ, ничего не перезаписывает).',
    inputSchema: { type: 'object', required: ['title', 'content'], additionalProperties: false, properties: { title: str('Название', { maxLength: 200 }), content: str('Markdown отчёта', { maxLength: 500000 }) } },
    permissions: (_i, ctx) => [{ permission: 'documents.create', folder: ctx.rt.settings.get<string>('docs.researchFolder') }],
    async execute(i: { title: string; content: string }, ctx) {
      const d = await services(ctx.rt).docs.create({ title: i.title, folder: ctx.rt.settings.get<string>('docs.researchFolder'), content: i.content, actor: `agent:${ctx.agentId}` });
      return { docId: d.id, path: d.relPath };
    },
  },
  {
    name: 'create_source_links',
    description: 'Добавляет в граф узлы-источники (URL) и связи «использует источник» от документа.',
    inputSchema: { type: 'object', required: ['docId', 'urls'], additionalProperties: false, properties: { docId: str('ID документа'), urls: { type: 'array', maxItems: 100, items: str('URL') } } },
    permissions: () => [{ permission: 'graph.write' }],
    async execute(i: { docId: string; urls: string[] }, ctx) {
      const g = services(ctx.rt).graph;
      let created = 0;
      for (const url of i.urls) {
        const row = ctx.rt.db.get<{ id: string; title: string | null; retrieved_at: string }>('SELECT id, title, retrieved_at FROM web_sources WHERE url = ? OR canonical_url = ?', url, url);
        const nodeId = `web:${shortHash(url)}`;
        g.upsertNode({ id: nodeId, type: 'source', label: row?.title ?? url, refId: row?.id ?? null, props: { url, retrievedAt: row?.retrieved_at ?? null } });
        g.addEdge({ src: docNodeId(i.docId), dst: nodeId, relation: 'uses_source', origin: 'system', createdBy: `agent:${ctx.agentId}`, evidence: ctx.runId ? `запуск ${ctx.runId}` : null });
        created++;
      }
      ctx.rt.emit('graph.changed', { docId: i.docId });
      return { created };
    },
  },
  {
    name: 'verify_source_freshness',
    description: 'Повторно загружает источник и сообщает, изменилось ли содержимое с прошлого получения.',
    inputSchema: { type: 'object', required: ['url'], additionalProperties: false, properties: { url: str('URL') } },
    permissions: (i: { url: string }) => {
      try {
        return [{ permission: 'network.fetch', domain: new URL(i.url).hostname }];
      } catch {
        return [{ permission: 'network.fetch' }];
      }
    },
    async execute(i: { url: string }, ctx) {
      return ctx.web.verifyFreshness(ctx.rt, i.url, ctx.signal);
    },
  },
  {
    name: 'propose_file_change',
    description:
      'Предлагает изменение файла (создать, заменить содержимое целиком, удалить) в наборе изменений текущего шага. Файл на диске НЕ меняется: набор просматривает и применяет пользователь. Для изменения передайте ПОЛНОЕ новое содержимое файла.',
    inputSchema: {
      type: 'object',
      required: ['sourceId', 'path', 'op', 'rationale'],
      additionalProperties: false,
      properties: {
        sourceId: str('ID проекта или хранилища'),
        path: str('Относительный путь файла', { maxLength: 500 }),
        op: { enum: ['create', 'modify', 'delete'], description: 'create — новый файл, modify — новое полное содержимое, delete — удалить' },
        content: str('Полное новое содержимое файла (для create и modify)', { maxLength: 1000000 }),
        rationale: str('Зачем нужно изменение (одно-два предложения)', { maxLength: 2000 }),
      },
    },
    permissions: (i: { sourceId: string }, ctx) => [{ permission: 'changes.propose', ...(i.sourceId === ctx.rt.primaryVaultId() ? {} : { sourceId: i.sourceId }) }],
    async execute(i: { sourceId: string; path: string; op: 'create' | 'modify' | 'delete'; content?: string; rationale: string }, ctx) {
      const changes = services(ctx.rt).changes;
      const stepKey = ctx.scope.changeGroup ?? ctx.stepId ?? ctx.runId ?? `adhoc:${ctx.agentId}`;
      const setId = changes.forStep({ missionId: ctx.scope.missionId ?? null, runId: ctx.runId, stepId: stepKey, title: `Изменения агента ${ctx.agentId}`, createdBy: `agent:${ctx.agentId}` });
      const f = await changes.propose(setId, { sourceId: i.sourceId, path: i.path, op: i.op, ...(i.content !== undefined ? { content: i.content } : {}), rationale: i.rationale }, `agent:${ctx.agentId}`);
      return { changeSetId: setId, fileId: f.id, path: f.path, op: f.op, added: f.added, removed: f.removed, applied: false, note: 'Изменение предложено и не применено. Применяет пользователь после просмотра.' };
    },
  },
  {
    name: 'run_check',
    description: 'Запускает проверку проекта ПО ИМЕНИ (например, тесты). Доступны только проверки, заданные пользователем в настройках проекта и подтверждённые для этого запуска. Возвращает код выхода и конец вывода.',
    inputSchema: { type: 'object', required: ['sourceId', 'name'], additionalProperties: false, properties: { sourceId: str('ID проекта'), name: str('Имя проверки из настроек проекта', { maxLength: 41 }) } },
    permissions: (i: { sourceId: string }) => [{ permission: 'commands.run', sourceId: i.sourceId }],
    async execute(i: { sourceId: string; name: string }, ctx) {
      const approved = (ctx.scope.approvedChecks ?? []).find((c) => c.sourceId === i.sourceId && c.name === i.name);
      if (!approved) throw new AppError('CHECK_NOT_APPROVED', `Проверка «${i.name}» не подтверждена пользователем для этого запуска.`);
      // checks never run in the original project: only in this mission's/run's work copy
      const wc = services(ctx.rt).workcopies.current(i.sourceId, ctx.scope.missionId ?? null);
      if (!wc) throw new AppError('MODE_FORBIDS', 'Рабочая копия проекта не создана: проверки запускаются только в рабочей копии, исходный проект не используется.');
      const res = await runCheck(ctx.rt, i.sourceId, i.name, { workCopy: { id: wc.id, rootPath: wc.rootPath }, actor: `agent:${ctx.agentId}`, runId: ctx.scope.missionId ?? ctx.runId, approvedContentHash: approved.contentHash ?? null, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (ctx.scope.missionId) {
        const round = ctx.rt.db.get<{ fix_rounds: number }>('SELECT fix_rounds FROM missions WHERE id = ?', ctx.scope.missionId)?.fix_rounds ?? 0;
        ctx.rt.db.run(
          "INSERT INTO mission_checks(id, mission_id, step_id, round, kind, name, source_id, status, exit_code, duration_ms, output, evidence, created_at) VALUES (?, ?, ?, ?, 'command', ?, ?, ?, ?, ?, ?, ?, ?)",
          newId('chk'),
          ctx.scope.missionId,
          ctx.stepId,
          round,
          i.name,
          i.sourceId,
          res.ok ? 'passed' : res.timedOut ? 'timeout' : 'failed',
          res.exitCode,
          res.durationMs,
          res.output,
          JSON.stringify({ command: res.command, by: `agent:${ctx.agentId}` }),
          nowIso(),
        );
      }
      return res;
    },
  },
  {
    name: 'create_agent_definition',
    description: 'Создаёт ЧЕРНОВИК нового агента в этой системе (пакет без кода: инструкции, схемы, список инструментов, запрашиваемые разрешения). Агент не устанавливается и не включается: это делает пользователь, выдавая разрешения явно.',
    inputSchema: {
      type: 'object',
      required: ['id', 'name', 'description', 'instructions', 'tools', 'permissions', 'taskType', 'inputSchema', 'outputSchema'],
      additionalProperties: false,
      properties: {
        id: str('Идентификатор: латиница, цифры и дефисы', { pattern: '^[a-z][a-z0-9-]{2,63}$' }),
        name: str('Название', { maxLength: 100 }),
        description: str('Что делает агент', { maxLength: 1000 }),
        instructions: str('Инструкции (Markdown)', { maxLength: 30000 }),
        tools: { type: 'array', maxItems: 20, items: { type: 'string' } },
        permissions: { type: 'array', maxItems: 20, items: { type: 'object', required: ['permission', 'reason'], additionalProperties: false, properties: { permission: { type: 'string' }, reason: str('Зачем нужно разрешение', { maxLength: 300 }) } } },
        taskType: { enum: TASK_TYPES.filter((t) => t.id !== 'embedding').map((t) => t.id) },
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
      },
    },
    permissions: () => [{ permission: 'agents.create' }],
    async execute(i: { id: string; name: string; description: string; instructions: string; tools: string[]; permissions: { permission: string; reason: string }[]; taskType: TaskType; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }, ctx) {
      for (const p of i.permissions) if (!PERMISSION_IDS.has(p.permission as PermissionId)) throw new AppError('VALIDATION_FAILED', `Неизвестное разрешение: ${p.permission}`);
      const res = await services(ctx.rt).agents.saveDefinition({
        id: i.id,
        name: i.name,
        description: i.description,
        category: 'custom',
        instructions: i.instructions,
        tools: i.tools,
        permissions: i.permissions as { permission: PermissionId; reason: string }[],
        taskType: i.taskType,
        inputSchema: i.inputSchema,
        outputSchema: i.outputSchema,
        readme: `# ${i.name}\n\n${i.description}\n\nЧерновик создан агентом ${ctx.agentId}${ctx.scope.missionId ? ` в поручении ${ctx.scope.missionId}` : ''}. Перед установкой проверьте инструкции и запрашиваемые разрешения.\n`,
      });
      ctx.rt.audit.record({ actor: `agent:${ctx.agentId}`, action: 'agent.definition.create', target: res.id, details: { version: res.version, missionId: ctx.scope.missionId ?? null } });
      return { ...res, installed: false, enabled: false, note: 'Черновик агента сохранён в системе. Установка, выдача разрешений и включение выполняются только пользователем.' };
    },
  },
  {
    name: 'create_workflow_definition',
    description: 'Сохраняет ЧЕРНОВИК процесса (workflow) из узлов agent/function/approval/loop. Определение проверяется; процесс не запускается — это делает пользователь.',
    inputSchema: { type: 'object', required: ['definition'], additionalProperties: false, properties: { definition: { type: 'object', description: 'Определение процесса (id, name, version, inputSchema, nodes)' } } },
    permissions: () => [{ permission: 'workflows.create' }],
    async execute(i: { definition: Record<string, unknown> }, ctx) {
      const engine = services(ctx.rt).workflows;
      const def = { description: '', version: 1, ...i.definition };
      const check = engine.check(def);
      if (!check.ok) return { saved: false, errors: check.errors, warnings: check.warnings, note: 'Определение не прошло проверку и не сохранено.' };
      const draft = { ...def, description: `[Черновик от агента ${ctx.agentId}] ${String(def.description ?? '')}`.trim() };
      const res = engine.save(draft, `agent:${ctx.agentId}`);
      return { saved: true, id: res.definition.id, version: res.definition.version, warnings: res.check.warnings, note: 'Черновик процесса сохранён. Запуск — только пользователем.' };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));

/** Tools whose output is external/untrusted content: scanned for instructions aimed at AI (29.10). */
const CONTENT_TOOLS = new Set(['read_document', 'read_project_file', 'search_documents', 'open_url', 'extract_page_content', 'fetch_documentation', 'inspect_repository']);
const SECURITY_DENIALS = new Set(['PERMISSION_DENIED', 'CROSS_SYSTEM_DENIED', 'FETCH_BLOCKED', 'MODE_FORBIDS', 'PATH_OUTSIDE_SCOPE', 'COMMAND_BLOCKED', 'SECRET_EGRESS_BLOCKED', 'CHECK_NOT_APPROVED', 'READ_ONLY_SOURCE', 'NETWORK_POLICY_DENIED', 'OFFLINE_MODE']);

export interface ToolCallRecord {
  tool: string;
  input: unknown;
  ok: boolean;
  output?: unknown;
  error?: { code: string; message: string };
  durationMs: number;
}

/**
 * Controlled executor: (1) tool allowed by the agent package; (2) input valid; (3) every permission requirement
 * satisfied by grants ∩ run scope; (4) audited. Errors are returned to the agent as data, never thrown past it.
 */
export async function executeTool(name: string, input: unknown, allowedTools: string[], ctx: ToolContext): Promise<ToolCallRecord> {
  const started = Date.now();
  const audit = (ok: boolean, details: unknown, outcome: 'ok' | 'denied' | 'error') =>
    ctx.rt.audit.record({ actor: `agent:${ctx.agentId}`, action: `tool.${name}`, outcome, details: { input: redactValue(input), ...((details as object) ?? {}) }, runId: ctx.runId });
  try {
    if (!allowedTools.includes(name)) throw new AppError('PERMISSION_DENIED', `Инструмент «${name}» не входит в пакет агента.`);
    if (ctx.scope.deniedTools?.includes(name)) throw new AppError('PERMISSION_DENIED', `Инструмент «${name}» запрещён пользователем для этого поручения.`);
    const tool = TOOL_MAP.get(name);
    if (!tool) throw new AppError('VALIDATION_FAILED', `Неизвестный инструмент «${name}».`);
    const validate = validator(tool.inputSchema);
    if (!validate(input)) throw new AppError('VALIDATION_FAILED', `Неверные аргументы: ${formatErrors(validate.errors).join('; ')}`);
    for (const req of tool.permissions(input as never, ctx)) ctx.guard.check(ctx.agentId, req, ctx.scope, ctx.rt.systemId);
    if (ctx.signal?.aborted) throw new AppError('CANCELLED');
    const output = await tool.execute(input as never, ctx);
    audit(true, { durationMs: Date.now() - started }, 'ok');
    if (CONTENT_TOOLS.has(name)) {
      const signals = detectInjection(JSON.stringify(output));
      if (signals.length) {
        ctx.rt.security.record({ actor: `agent:${ctx.agentId}`, action: 'injection.suspected', outcome: 'warning', taskId: ctx.scope.missionId ?? ctx.runId, resources: [String((input as { path?: string; docId?: string; url?: string }).path ?? (input as { docId?: string }).docId ?? (input as { url?: string }).url ?? name)], message: `В данных, полученных инструментом ${name}, найдены инструкции для AI (${signals.join(', ')}). Они обработаны как данные и не выполнялись.` });
        ctx.onEvent?.({ type: 'security.injection', message: `Подозрительные инструкции в данных (${signals.join(', ')}) — обработаны как данные`, data: { tool: name, signals } });
      }
    }
    ctx.onEvent?.({ type: 'tool.ok', message: `Инструмент ${name}: выполнено`, data: { tool: name, input } });
    return { tool: name, input, ok: true, output, durationMs: Date.now() - started };
  } catch (e) {
    const err = toAppError(e);
    const outcome = SECURITY_DENIALS.has(err.code) ? 'denied' : 'error';
    audit(false, { error: err.code, message: err.message }, outcome);
    if (outcome === 'denied') ctx.rt.security.record({ actor: `agent:${ctx.agentId}`, action: err.code === 'SECRET_EGRESS_BLOCKED' ? 'secret.blocked' : err.code === 'PATH_OUTSIDE_SCOPE' ? 'path.denied' : err.code === 'COMMAND_BLOCKED' ? 'command.blocked' : 'policy.denied', outcome: 'denied', taskId: ctx.scope.missionId ?? ctx.runId, resources: [name], message: `Отказ инструменту ${name}: ${err.message}`, details: { input: redactValue(input) } });
    ctx.onEvent?.({ type: outcome === 'denied' ? 'tool.denied' : 'tool.error', message: `Инструмент ${name}: ${err.message}`, data: { tool: name, code: err.code } });
    if (err.code === 'CANCELLED') throw err;
    return { tool: name, input, ok: false, error: { code: err.code, message: errorMessage(err) }, durationMs: Date.now() - started };
  }
}
