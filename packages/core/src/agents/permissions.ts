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
  { id: 'documents.read', label: 'Read documents', description: 'Read vault documents within the run scope.', risk: 'low' },
  { id: 'projects.read', label: 'Read projects', description: 'Read files of connected projects within the run scope.', risk: 'medium' },
  { id: 'search.use', label: 'Search', description: 'Full-text search in the system index.', risk: 'low' },
  { id: 'graph.read', label: 'Read the graph', description: 'View links between documents.', risk: 'low' },
  { id: 'graph.write', label: 'Suggest links', description: 'Create graph links (as suggestions or links to sources).', risk: 'medium' },
  { id: 'documents.create', label: 'Create documents', description: 'Create new documents in allowed folders.', risk: 'medium' },
  { id: 'documents.modify', label: 'Modify documents', description: 'Change existing documents. No built-in v1 tool uses it.', risk: 'high' },
  { id: 'tasks.create', label: 'Create tasks', description: 'Create tasks on the Tasks board.', risk: 'medium' },
  { id: 'agents.invoke', label: 'Run other agents', description: 'Call other agents from this agent.', risk: 'medium' },
  { id: 'web.search', label: 'Web search', description: 'Queries to the configured search provider.', risk: 'medium' },
  { id: 'network.fetch', label: 'Fetch web pages', description: 'Download public web pages (local and internal addresses are blocked).', risk: 'medium' },
  { id: 'external.api', label: 'External APIs', description: 'Requests to external APIs (for example GitHub).', risk: 'medium' },
  { id: 'commands.run', label: 'Run project checks', description: 'Run ONLY the check commands (for example tests) that the user set in the project settings. Arbitrary commands are not available.', risk: 'high' },
  { id: 'changes.propose', label: 'Propose file changes', description: 'Prepare change sets for projects and documents. Files do not change until the user applies the set.', risk: 'medium' },
  { id: 'agents.create', label: 'Create agents', description: 'Create drafts of new agents in the system (only the user enables them).', risk: 'medium' },
  { id: 'workflows.create', label: 'Create workflows', description: 'Save workflow drafts. Only the user runs them.', risk: 'medium' },
  { id: 'systems.read', label: 'Read other systems', description: 'Read data of the systems explicitly selected when the workflow starts.', risk: 'high' },
  { id: 'extensions.use', label: 'Extension tools', description: 'Call tools of enabled extensions. The extension stays limited by its own permissions and the run scope.', risk: 'high' },
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
    if (!PERMISSION_IDS.has(permission)) throw new AppError('VALIDATION_FAILED', `Unknown permission: ${permission}`);
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
    if (!g) return `no "${PERMISSIONS.find((p) => p.id === req.permission)?.label ?? req.permission}" permission`;
    if (req.systemId && req.systemId !== homeSystemId) {
      if (!this.grants(agentId).some((x) => x.permission === 'systems.read')) return 'no "Read other systems" permission';
      if (!run.extraSystems.includes(req.systemId)) return 'this system is not selected for the run';
      return null; // source-level checks happen inside the other system against its own run scope
    }
    if (req.sourceId) {
      if (g.scope.sources?.length && !g.scope.sources.includes(req.sourceId)) return 'the source is outside the agent permission scope';
      if (run.sourceIds.length && !run.sourceIds.includes(req.sourceId)) return 'the source is not selected for this run';
    }
    if (req.folder !== undefined) {
      const allowed = g.scope.folders?.length ? g.scope.folders : [];
      const f = req.folder.replace(/^\/+|\/+$/g, '');
      if (!allowed.some((a) => f === a || f.startsWith(`${a}/`))) return `the folder "${f || '/'}" is outside the allowed ones (${allowed.join(', ') || 'none set'})`;
    }
    if (req.domain && g.scope.domains?.length) {
      const d = req.domain.toLowerCase();
      if (!g.scope.domains.some((x) => d === x.toLowerCase() || d.endsWith(`.${x.toLowerCase()}`))) return `the domain ${d} is outside the allowed ones`;
    }
    if ((req.permission === 'web.search' || req.permission === 'network.fetch' || req.permission === 'external.api') && !run.allowWeb) return 'web access is not allowed for this run';
    if (run.deniedTools?.length && req.tool && run.deniedTools.includes(req.tool)) return `the tool "${req.tool}" was denied by the user for this run`;
    return null;
  }

  check(agentId: string, req: PermissionRequirement, run: RunScope, homeSystemId: string): void {
    const reason = this.denialReason(agentId, req, run, homeSystemId);
    if (reason) throw new AppError('PERMISSION_DENIED', `Action denied: ${reason}.`, { details: { requirement: req } });
  }
}
