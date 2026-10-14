import type { Db } from '../db/db.ts';
import { AppError } from '../util/errors.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';

export type PermissionId =
  | 'documents.read'
  | 'projects.read'
  | 'search.use'
  | 'graph.read'
  | 'graph.write'
  | 'documents.create'
  | 'documents.modify'
  | 'tasks.create'
  | 'agents.invoke'
  | 'web.search'
  | 'network.fetch'
  | 'external.api'
  | 'commands.run'
  | 'changes.propose'
  | 'agents.create'
  | 'workflows.create'
  | 'systems.read'
  | 'extensions.use';

export const PERMISSIONS: { id: PermissionId; label: string; description: string; risk: 'low' | 'medium' | 'high' }[] = [
  { id: 'documents.read', label: 'Чтение документов', description: 'Чтение документов хранилища в пределах области запуска.', risk: 'low' },
  { id: 'projects.read', label: 'Чтение проектов', description: 'Чтение файлов подключённых проектов в пределах области запуска.', risk: 'medium' },
  { id: 'search.use', label: 'Поиск', description: 'Полнотекстовый поиск по индексу системы.', risk: 'low' },
  { id: 'graph.read', label: 'Чтение графа', description: 'Просмотр связей между документами.', risk: 'low' },
  { id: 'graph.write', label: 'Предложение связей', description: 'Создание связей в графе (как предложения или ссылки на источники).', risk: 'medium' },
  { id: 'documents.create', label: 'Создание документов', description: 'Создание новых документов в разрешённых папках.', risk: 'medium' },
  { id: 'documents.modify', label: 'Изменение документов', description: 'Изменение существующих документов. Ни один встроенный инструмент v1 этим не пользуется.', risk: 'high' },
  { id: 'tasks.create', label: 'Создание задач', description: 'Создание задач в разделе «Задачи».', risk: 'medium' },
  { id: 'agents.invoke', label: 'Запуск других агентов', description: 'Вызов других агентов из этого агента.', risk: 'medium' },
  { id: 'web.search', label: 'Веб-поиск', description: 'Запросы к настроенному поисковому провайдеру.', risk: 'medium' },
  { id: 'network.fetch', label: 'Загрузка веб-страниц', description: 'Загрузка публичных веб-страниц (локальные и внутренние адреса запрещены).', risk: 'medium' },
  { id: 'external.api', label: 'Внешние API', description: 'Запросы к внешним API (например, GitHub).', risk: 'medium' },
  { id: 'commands.run', label: 'Запуск проверок проекта', description: 'Запуск ТОЛЬКО тех команд проверки (например, тестов), которые пользователь задал в настройках проекта. Произвольные команды недоступны.', risk: 'high' },
  { id: 'changes.propose', label: 'Предложение изменений файлов', description: 'Подготовка наборов изменений для проектов и документов. Файлы не меняются, пока пользователь не применит набор.', risk: 'medium' },
  { id: 'agents.create', label: 'Создание агентов', description: 'Создание черновиков новых агентов в системе (включает их только пользователь).', risk: 'medium' },
  { id: 'workflows.create', label: 'Создание процессов', description: 'Сохранение черновиков процессов (workflow). Запускает их только пользователь.', risk: 'medium' },
  { id: 'systems.read', label: 'Чтение других систем', description: 'Чтение данных систем, явно выбранных при запуске процесса.', risk: 'high' },
  { id: 'extensions.use', label: 'Инструменты расширений', description: 'Вызов инструментов включённых расширений. Расширение при этом ограничено своими собственными разрешениями и областью запуска.', risk: 'high' },
];

export const PERMISSION_IDS = new Set(PERMISSIONS.map((p) => p.id));

export interface GrantScope {
  /** Source ids the grant is limited to (absent = whatever the run scope allows). */
  sources?: string[];
  /** Vault-relative folders for documents.create. */
  folders?: string[];
  /** Domains for network.fetch (absent = any public domain). */
  domains?: string[];
}

export interface Grant {
  id: string;
  agentId: string;
  permission: PermissionId;
  scope: GrantScope;
  grantedAt: string;
}

/** The scope a workflow run was started with — chosen by the user, never by an agent. */
export interface RunScope {
  sourceIds: string[];
  docIds: string[];
  /** Systems (besides the home system) the user explicitly selected for cross-system reading. */
  extraSystems: string[];
  allowWeb: boolean;
  outputFolder?: string;
  /** Tools the user explicitly forbade for this run/mission. */
  deniedTools?: string[];
  /** Mission id when the run belongs to a mission (for change sets and checks). */
  missionId?: string;
  /** Project checks the user approved for this run (run_check refuses anything else). contentHash binds an
   * approval of a check with risky scripts to exactly the content the user saw. */
  approvedChecks?: { sourceId: string; name: string; contentHash?: string | null }[];
  /** Groups proposed file changes into one change set (e.g. one per mission round). */
  changeGroup?: string;
}

export interface PermissionRequirement {
  permission: PermissionId;
  tool?: string;
  sourceId?: string;
  folder?: string;
  domain?: string;
  systemId?: string;
}

/**
 * Checks tool calls against agent grants ∩ run scope. Grants are changed only through the settings API
 * (user action); no tool exists that modifies grants, so agents cannot escalate their own privileges.
 */
export class PermissionGuard {
  constructor(private readonly db: Db) {}

  grants(agentId: string): Grant[] {
    return this.db
      .all<{ id: string; agent_id: string; permission: PermissionId; scope: string; granted_at: string }>('SELECT * FROM agent_grants WHERE agent_id = ? ORDER BY permission', agentId)
      .map((r) => ({ id: r.id, agentId: r.agent_id, permission: r.permission, scope: parseJson(r.scope, {}), grantedAt: r.granted_at }));
  }

  grant(agentId: string, permission: PermissionId, scope: GrantScope = {}): void {
    if (!PERMISSION_IDS.has(permission)) throw new AppError('VALIDATION_FAILED', `Неизвестное разрешение: ${permission}`);
    this.db.run(
      'INSERT INTO agent_grants(id, agent_id, permission, scope, granted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id, permission) DO UPDATE SET scope = excluded.scope, granted_at = excluded.granted_at',
      newId('grant'),
      agentId,
      permission,
      JSON.stringify(scope),
      nowIso(),
    );
  }

  revoke(agentId: string, permission: PermissionId): void {
    this.db.run('DELETE FROM agent_grants WHERE agent_id = ? AND permission = ?', agentId, permission);
  }

  revokeAll(agentId: string): void {
    this.db.run('DELETE FROM agent_grants WHERE agent_id = ?', agentId);
  }

  /** Returns null when allowed, otherwise a human-readable reason. */
  denialReason(agentId: string, req: PermissionRequirement, run: RunScope, homeSystemId: string): string | null {
    const g = this.grants(agentId).find((x) => x.permission === req.permission);
    if (!g) return `нет разрешения «${PERMISSIONS.find((p) => p.id === req.permission)?.label ?? req.permission}»`;
    if (req.systemId && req.systemId !== homeSystemId) {
      if (!this.grants(agentId).some((x) => x.permission === 'systems.read')) return 'нет разрешения «Чтение других систем»';
      if (!run.extraSystems.includes(req.systemId)) return 'эта система не выбрана для запуска';
      return null; // source-level checks happen inside the other system against its own run scope
    }
    if (req.sourceId) {
      if (g.scope.sources?.length && !g.scope.sources.includes(req.sourceId)) return 'источник вне области разрешения агента';
      if (run.sourceIds.length && !run.sourceIds.includes(req.sourceId)) return 'источник не выбран для этого запуска';
    }
    if (req.folder !== undefined) {
      const allowed = g.scope.folders?.length ? g.scope.folders : [];
      const f = req.folder.replace(/^\/+|\/+$/g, '');
      if (!allowed.some((a) => f === a || f.startsWith(`${a}/`))) return `папка «${f || '/'}» вне разрешённых (${allowed.join(', ') || 'не заданы'})`;
    }
    if (req.domain && g.scope.domains?.length) {
      const d = req.domain.toLowerCase();
      if (!g.scope.domains.some((x) => d === x.toLowerCase() || d.endsWith(`.${x.toLowerCase()}`))) return `домен ${d} вне разрешённых`;
    }
    if ((req.permission === 'web.search' || req.permission === 'network.fetch' || req.permission === 'external.api') && !run.allowWeb) return 'веб-доступ не разрешён для этого запуска';
    if (run.deniedTools?.length && req.tool && run.deniedTools.includes(req.tool)) return `инструмент «${req.tool}» запрещён пользователем для этого запуска`;
    return null;
  }

  check(agentId: string, req: PermissionRequirement, run: RunScope, homeSystemId: string): void {
    const reason = this.denialReason(agentId, req, run, homeSystemId);
    if (reason) throw new AppError('PERMISSION_DENIED', `Действие запрещено: ${reason}.`, { details: { requirement: req } });
  }
}
