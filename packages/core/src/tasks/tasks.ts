import type { SystemRuntime } from '../systems/runtime.ts';
import type { GraphService } from '../graph/graph.ts';
import { docNodeId } from '../graph/graph.ts';
import { AppError } from '../util/errors.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';

export type TaskStatus = 'backlog' | 'todo' | 'in_progress' | 'review' | 'done' | 'blocked' | 'cancelled';
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';

export const TASK_STATUSES: { id: TaskStatus; label: string }[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'To do' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'review', label: 'In review' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'done', label: 'Done' },
  { id: 'cancelled', label: 'Cancelled' },
];

const PRIORITIES = new Set<TaskPriority>(['critical', 'high', 'medium', 'low']);
const STATUSES = new Set<TaskStatus>(TASK_STATUSES.map((s) => s.id));

export interface TaskInput {
  title: string;
  description?: string;
  goal?: string;
  rationale?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  parentId?: string | null;
  projectId?: string | null;
  assignee?: { type: 'user' | 'agent'; id: string } | null;
  acceptanceCriteria?: string[];
  affectedModules?: string[];
  unknowns?: string[];
  requirementIds?: string[];
  dependsOn?: string[];
  links?: { type: 'document' | 'url' | 'requirement'; id: string; label?: string }[];
  origin?: 'manual' | 'agent';
  originRunId?: string | null;
  originDocId?: string | null;
  actor?: string;
}

export interface TaskView {
  id: string;
  key: string;
  title: string;
  description: string;
  goal: string;
  rationale: string;
  status: TaskStatus;
  priority: TaskPriority;
  parentId: string | null;
  projectId: string | null;
  assignee: { type: 'user' | 'agent'; id: string } | null;
  acceptanceCriteria: string[];
  affectedModules: string[];
  unknowns: string[];
  requirementIds: string[];
  origin: 'manual' | 'agent';
  originRunId: string | null;
  originDocId: string | null;
  completionEvidence: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  dependsOn: { id: string; key: string; title: string; status: TaskStatus }[];
  blocks: { id: string; key: string; title: string; status: TaskStatus }[];
  /** Dependencies not yet done: the task should not be started/finished before them. */
  openDependencies: number;
  comments?: { id: string; author: string; body: string; createdAt: string }[];
  links?: { type: string; id: string; label: string; title?: string | null }[];
  children?: { id: string; key: string; title: string; status: TaskStatus }[];
}

interface Row {
  id: string;
  key: string;
  title: string;
  description: string;
  goal: string;
  rationale: string;
  status: TaskStatus;
  priority: TaskPriority;
  parent_id: string | null;
  project_id: string | null;
  assignee_type: 'user' | 'agent' | null;
  assignee_id: string | null;
  acceptance_criteria: string;
  affected_modules: string;
  unknowns: string;
  requirement_ids: string;
  origin: 'manual' | 'agent';
  origin_run_id: string | null;
  origin_doc_id: string | null;
  completion_evidence: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function strList(v: unknown, name: string, max = 100): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw new AppError('VALIDATION_FAILED', `${name}: a list of strings is expected.`);
  return (v as string[]).map((s) => s.trim()).filter(Boolean).slice(0, max);
}

/** Task tracker of ONE system. Tasks created by agents are marked origin=agent and keep a link to the run. */
export class TaskService {
  constructor(
    private readonly rt: SystemRuntime,
    private readonly graph: GraphService,
  ) {}

  private row(id: string): Row {
    const r = this.rt.db.get<Row>('SELECT * FROM tasks WHERE id = ? OR key = ?', id, id);
    if (!r) throw new AppError('NOT_FOUND', 'Task not found.');
    return r;
  }

  private nextKey(): string {
    const rows = this.rt.db.all<{ key: string }>("SELECT key FROM tasks WHERE key LIKE 'T-%'");
    let max = 0;
    for (const r of rows) {
      const m = /^T-(\d+)$/.exec(r.key);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `T-${String(max + 1).padStart(3, '0')}`;
  }

  private brief(id: string): { id: string; key: string; title: string; status: TaskStatus } | null {
    return this.rt.db.get<{ id: string; key: string; title: string; status: TaskStatus }>('SELECT id, key, title, status FROM tasks WHERE id = ?', id) ?? null;
  }

  private view(r: Row, full = false): TaskView {
    const deps = this.rt.db.all<{ depends_on: string }>('SELECT depends_on FROM task_deps WHERE task_id = ?', r.id).map((d) => this.brief(d.depends_on)).filter((x): x is NonNullable<typeof x> => !!x);
    const blocks = this.rt.db.all<{ task_id: string }>('SELECT task_id FROM task_deps WHERE depends_on = ?', r.id).map((d) => this.brief(d.task_id)).filter((x): x is NonNullable<typeof x> => !!x);
    const v: TaskView = {
      id: r.id,
      key: r.key,
      title: r.title,
      description: r.description,
      goal: r.goal,
      rationale: r.rationale,
      status: r.status,
      priority: r.priority,
      parentId: r.parent_id,
      projectId: r.project_id,
      assignee: r.assignee_type && r.assignee_id ? { type: r.assignee_type, id: r.assignee_id } : null,
      acceptanceCriteria: parseJson(r.acceptance_criteria, []),
      affectedModules: parseJson(r.affected_modules, []),
      unknowns: parseJson(r.unknowns, []),
      requirementIds: parseJson(r.requirement_ids, []),
      origin: r.origin,
      originRunId: r.origin_run_id,
      originDocId: r.origin_doc_id,
      completionEvidence: r.completion_evidence,
      sortOrder: r.sort_order,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      completedAt: r.completed_at,
      dependsOn: deps,
      blocks,
      openDependencies: deps.filter((d) => d.status !== 'done' && d.status !== 'cancelled').length,
    };
    if (full) {
      v.comments = this.rt.db.all<{ id: string; author: string; body: string; created_at: string }>('SELECT id, author, body, created_at FROM task_comments WHERE task_id = ? ORDER BY created_at', r.id).map((c) => ({ id: c.id, author: c.author, body: c.body, createdAt: c.created_at }));
      v.links = this.rt.db.all<{ target_type: string; target_id: string; label: string }>('SELECT target_type, target_id, label FROM task_links WHERE task_id = ? ORDER BY target_type, target_id', r.id).map((l) => ({
        type: l.target_type,
        id: l.target_id,
        label: l.label,
        title: l.target_type === 'document' ? (this.rt.db.get<{ title: string }>('SELECT title FROM documents WHERE id = ?', l.target_id)?.title ?? null) : null,
      }));
      v.children = this.rt.db.all<{ id: string; key: string; title: string; status: TaskStatus }>('SELECT id, key, title, status FROM tasks WHERE parent_id = ? ORDER BY sort_order, key', r.id);
    }
    return v;
  }

  get(id: string): TaskView {
    return this.view(this.row(id), true);
  }

  list(f: { status?: TaskStatus[]; priority?: TaskPriority[]; projectId?: string; parentId?: string | null; q?: string; requirementId?: string; origin?: 'manual' | 'agent'; originRunId?: string; assigneeId?: string; limit?: number; offset?: number } = {}): { items: TaskView[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.status?.length) {
      where.push(`status IN (${f.status.map(() => '?').join(',')})`);
      params.push(...f.status);
    }
    if (f.priority?.length) {
      where.push(`priority IN (${f.priority.map(() => '?').join(',')})`);
      params.push(...f.priority);
    }
    if (f.projectId) {
      where.push('project_id = ?');
      params.push(f.projectId);
    }
    if (f.parentId !== undefined) {
      where.push(f.parentId === null ? 'parent_id IS NULL' : 'parent_id = ?');
      if (f.parentId !== null) params.push(f.parentId);
    }
    if (f.q) {
      where.push('(ulower(title) LIKE ? OR ulower(description) LIKE ? OR ulower(key) LIKE ?)');
      const q = `%${f.q.toLowerCase()}%`;
      params.push(q, q, q);
    }
    if (f.requirementId) {
      where.push('requirement_ids LIKE ?');
      params.push(`%"${f.requirementId}"%`);
    }
    if (f.origin) {
      where.push('origin = ?');
      params.push(f.origin);
    }
    if (f.originRunId) {
      where.push('origin_run_id = ?');
      params.push(f.originRunId);
    }
    if (f.assigneeId) {
      where.push('assignee_id = ?');
      params.push(f.assigneeId);
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = this.rt.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM tasks ${w}`, ...params)!.c;
    const rows = this.rt.db.all<Row>(
      `SELECT * FROM tasks ${w} ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, sort_order, key LIMIT ? OFFSET ?`,
      ...params,
      Math.min(f.limit ?? 500, 2000),
      f.offset ?? 0,
    );
    return { items: rows.map((r) => this.view(r)), total };
  }

  /** Kanban columns in a fixed order. */
  board(f: { projectId?: string; q?: string } = {}): { columns: { status: TaskStatus; label: string; tasks: TaskView[] }[] } {
    const all = this.list({ ...f, limit: 2000 }).items;
    return { columns: TASK_STATUSES.map((s) => ({ status: s.id, label: s.label, tasks: all.filter((t) => t.status === s.id).sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key)) })) };
  }

  create(input: TaskInput): TaskView {
    const title = input.title?.trim();
    if (!title) throw new AppError('VALIDATION_FAILED', 'Enter a task title.');
    if (title.length > 300) throw new AppError('VALIDATION_FAILED', 'The task title is longer than 300 characters.');
    const status = input.status ?? 'todo';
    if (!STATUSES.has(status)) throw new AppError('VALIDATION_FAILED', `Unknown status: ${status}`);
    if (status === 'done') throw new AppError('VALIDATION_FAILED', 'A new task cannot be done right away: mark it done with a confirmation.');
    const priority = input.priority ?? 'medium';
    if (!PRIORITIES.has(priority)) throw new AppError('VALIDATION_FAILED', `Unknown priority: ${priority}`);
    if (input.parentId) this.row(input.parentId);
    if (input.projectId && !this.rt.db.get('SELECT id FROM sources WHERE id = ?', input.projectId)) throw new AppError('NOT_FOUND', 'Project not found.');
    const id = newId('task');
    const now = nowIso();
    const key = this.nextKey();
    this.rt.db.transaction(() => {
      this.rt.db.run(
        `INSERT INTO tasks(id, key, title, description, goal, rationale, status, priority, parent_id, project_id, assignee_type, assignee_id, acceptance_criteria, affected_modules, unknowns,
           requirement_ids, origin, origin_run_id, origin_doc_id, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        key,
        title,
        (input.description ?? '').slice(0, 20000),
        (input.goal ?? '').slice(0, 2000),
        (input.rationale ?? '').slice(0, 2000),
        status,
        priority,
        input.parentId ? this.row(input.parentId).id : null,
        input.projectId ?? null,
        input.assignee?.type ?? null,
        input.assignee?.id ?? null,
        JSON.stringify(strList(input.acceptanceCriteria, 'acceptanceCriteria')),
        JSON.stringify(strList(input.affectedModules, 'affectedModules')),
        JSON.stringify(strList(input.unknowns, 'unknowns')),
        JSON.stringify(strList(input.requirementIds, 'requirementIds')),
        input.origin ?? 'manual',
        input.originRunId ?? null,
        input.originDocId ?? null,
        Date.now(),
        now,
        now,
      );
      for (const d of input.dependsOn ?? []) this.addDependencyRaw(id, this.row(d).id);
      for (const l of input.links ?? []) this.addLinkRaw(id, l.type, l.id, l.label ?? '');
    });
    this.syncGraph(id);
    this.rt.audit.record({ actor: input.actor ?? 'user', action: 'task.create', target: key, details: { title, origin: input.origin ?? 'manual', runId: input.originRunId ?? null } });
    this.rt.emit('tasks.changed', { taskId: id });
    return this.get(id);
  }

  update(id: string, patch: Partial<Omit<TaskInput, 'status' | 'dependsOn' | 'links' | 'origin' | 'originRunId'>> & { sortOrder?: number }, actor = 'user'): TaskView {
    const r = this.row(id);
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const set = (col: string, v: string | number | null) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (patch.title !== undefined) {
      const t = patch.title.trim();
      if (!t) throw new AppError('VALIDATION_FAILED', 'The task title cannot be empty.');
      set('title', t.slice(0, 300));
    }
    if (patch.description !== undefined) set('description', patch.description.slice(0, 20000));
    if (patch.goal !== undefined) set('goal', patch.goal.slice(0, 2000));
    if (patch.rationale !== undefined) set('rationale', patch.rationale.slice(0, 2000));
    if (patch.priority !== undefined) {
      if (!PRIORITIES.has(patch.priority)) throw new AppError('VALIDATION_FAILED', `Unknown priority: ${patch.priority}`);
      set('priority', patch.priority);
    }
    if (patch.parentId !== undefined) {
      if (patch.parentId) {
        const p = this.row(patch.parentId);
        // a task cannot become a child of its own descendant
        for (let cur: Row | undefined = p; cur; cur = cur.parent_id ? this.row(cur.parent_id) : undefined) if (cur.id === r.id) throw new AppError('DEPENDENCY_CYCLE', 'A task cannot be nested in its own subtask.');
        set('parent_id', p.id);
      } else set('parent_id', null);
    }
    if (patch.projectId !== undefined) set('project_id', patch.projectId);
    if (patch.assignee !== undefined) {
      set('assignee_type', patch.assignee?.type ?? null);
      set('assignee_id', patch.assignee?.id ?? null);
    }
    if (patch.acceptanceCriteria !== undefined) set('acceptance_criteria', JSON.stringify(strList(patch.acceptanceCriteria, 'acceptanceCriteria')));
    if (patch.affectedModules !== undefined) set('affected_modules', JSON.stringify(strList(patch.affectedModules, 'affectedModules')));
    if (patch.unknowns !== undefined) set('unknowns', JSON.stringify(strList(patch.unknowns, 'unknowns')));
    if (patch.requirementIds !== undefined) set('requirement_ids', JSON.stringify(strList(patch.requirementIds, 'requirementIds')));
    if (patch.sortOrder !== undefined) set('sort_order', patch.sortOrder);
    if (!sets.length) return this.get(r.id);
    set('updated_at', nowIso());
    params.push(r.id);
    this.rt.db.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...params);
    this.syncGraph(r.id);
    this.rt.audit.record({ actor, action: 'task.update', target: r.key, details: { fields: Object.keys(patch) } });
    this.rt.emit('tasks.changed', { taskId: r.id });
    return this.get(r.id);
  }

  /**
   * Status change. "done" needs evidence of completion (what was verified, link to result) or an explicit
   * user confirmation; open dependencies block starting and finishing.
   */
  setStatus(id: string, status: TaskStatus, opts: { evidence?: string; confirm?: boolean; actor?: string; force?: boolean } = {}): TaskView {
    const r = this.row(id);
    if (!STATUSES.has(status)) throw new AppError('VALIDATION_FAILED', `Unknown status: ${status}`);
    if (r.status === status) return this.get(r.id);
    const actor = opts.actor ?? 'user';
    const view = this.view(r);
    if ((status === 'in_progress' || status === 'done') && view.openDependencies > 0 && !opts.force) {
      throw new AppError('VALIDATION_FAILED', `Finish the dependencies first: ${view.dependsOn.filter((d) => d.status !== 'done' && d.status !== 'cancelled').map((d) => d.key).join(', ')}.`, { hint: 'Or mark the dependencies as cancelled if they are no longer needed.' });
    }
    let evidence = r.completion_evidence;
    if (status === 'done') {
      const ev = opts.evidence?.trim();
      if (!ev && !opts.confirm) throw new AppError('CONFIRMATION_REQUIRED', 'To mark the task as done, give a confirmation (what was checked, where the result is) or confirm it manually.');
      if (actor.startsWith('agent:') && !ev) throw new AppError('VALIDATION_FAILED', 'An agent can mark a task as done only with a confirmation of the result.');
      evidence = ev || `Confirmed by the user on ${nowIso().slice(0, 10)}`;
    }
    const now = nowIso();
    this.rt.db.run('UPDATE tasks SET status = ?, completion_evidence = ?, completed_at = ?, updated_at = ? WHERE id = ?', status, status === 'done' ? evidence : r.completion_evidence, status === 'done' ? now : null, now, r.id);
    this.rt.audit.record({ actor, action: 'task.status', target: r.key, details: { from: r.status, to: status, evidence: status === 'done' ? evidence : undefined } });
    this.rt.emit('tasks.changed', { taskId: r.id });
    return this.get(r.id);
  }

  private wouldCycle(taskId: string, dependsOn: string): boolean {
    // adding taskId → dependsOn creates a cycle if dependsOn already (transitively) depends on taskId
    const seen = new Set<string>();
    const stack = [dependsOn];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === taskId) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const d of this.rt.db.all<{ depends_on: string }>('SELECT depends_on FROM task_deps WHERE task_id = ?', cur)) stack.push(d.depends_on);
    }
    return false;
  }

  private addDependencyRaw(taskId: string, dependsOn: string): void {
    if (taskId === dependsOn) throw new AppError('DEPENDENCY_CYCLE', 'A task cannot depend on itself.');
    if (this.wouldCycle(taskId, dependsOn)) throw new AppError('DEPENDENCY_CYCLE', undefined, { details: { taskId, dependsOn } });
    this.rt.db.run('INSERT OR IGNORE INTO task_deps(task_id, depends_on) VALUES (?, ?)', taskId, dependsOn);
  }

  addDependency(id: string, dependsOn: string, actor = 'user'): TaskView {
    const a = this.row(id);
    const b = this.row(dependsOn);
    this.addDependencyRaw(a.id, b.id);
    this.syncGraph(a.id);
    this.rt.audit.record({ actor, action: 'task.dependency.add', target: a.key, details: { dependsOn: b.key } });
    this.rt.emit('tasks.changed', { taskId: a.id });
    return this.get(a.id);
  }

  removeDependency(id: string, dependsOn: string, actor = 'user'): TaskView {
    const a = this.row(id);
    const b = this.row(dependsOn);
    this.rt.db.run('DELETE FROM task_deps WHERE task_id = ? AND depends_on = ?', a.id, b.id);
    this.syncGraph(a.id);
    this.rt.audit.record({ actor, action: 'task.dependency.remove', target: a.key, details: { dependsOn: b.key } });
    this.rt.emit('tasks.changed', { taskId: a.id });
    return this.get(a.id);
  }

  addComment(id: string, body: string, author = 'user'): TaskView {
    const r = this.row(id);
    const text = body.trim();
    if (!text) throw new AppError('VALIDATION_FAILED', 'Empty comment.');
    this.rt.db.run('INSERT INTO task_comments(id, task_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)', newId('tc'), r.id, author, text.slice(0, 20000), nowIso());
    this.rt.emit('tasks.changed', { taskId: r.id });
    return this.get(r.id);
  }

  private addLinkRaw(taskId: string, type: 'document' | 'url' | 'requirement', target: string, label: string): void {
    if (!['document', 'url', 'requirement'].includes(type)) throw new AppError('VALIDATION_FAILED', 'Link type: document, url or requirement.');
    if (type === 'document' && !this.rt.db.get('SELECT id FROM documents WHERE id = ?', target)) throw new AppError('NOT_FOUND', 'Document not found.');
    if (type === 'url') {
      try {
        const u = new URL(target);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('protocol');
      } catch {
        throw new AppError('VALIDATION_FAILED', 'Invalid URL.');
      }
    }
    this.rt.db.run('INSERT OR REPLACE INTO task_links(task_id, target_type, target_id, label) VALUES (?, ?, ?, ?)', taskId, type, target, label.slice(0, 200));
  }

  addLink(id: string, link: { type: 'document' | 'url' | 'requirement'; id: string; label?: string }, actor = 'user'): TaskView {
    const r = this.row(id);
    this.addLinkRaw(r.id, link.type, link.id, link.label ?? '');
    this.syncGraph(r.id);
    this.rt.audit.record({ actor, action: 'task.link.add', target: r.key, details: link });
    this.rt.emit('tasks.changed', { taskId: r.id });
    return this.get(r.id);
  }

  removeLink(id: string, type: string, target: string, actor = 'user'): TaskView {
    const r = this.row(id);
    this.rt.db.run('DELETE FROM task_links WHERE task_id = ? AND target_type = ? AND target_id = ?', r.id, type, target);
    this.syncGraph(r.id);
    this.rt.audit.record({ actor, action: 'task.link.remove', target: r.key, details: { type, target } });
    this.rt.emit('tasks.changed', { taskId: r.id });
    return this.get(r.id);
  }

  remove(id: string, actor = 'user'): void {
    const r = this.row(id);
    this.rt.db.transaction(() => {
      this.rt.db.run('UPDATE tasks SET parent_id = NULL WHERE parent_id = ?', r.id);
      this.rt.db.run('DELETE FROM tasks WHERE id = ?', r.id);
      this.rt.db.run('DELETE FROM graph_nodes WHERE id = ?', `task:${r.id}`);
    });
    this.rt.audit.record({ actor, action: 'task.delete', target: r.key, details: { title: r.title } });
    this.rt.emit('tasks.changed', { taskId: r.id, removed: true });
    this.rt.emit('graph.changed', { taskId: r.id });
  }

  /** Mirrors a task into the knowledge graph: task node + implements → requirement docs, depends_on → tasks. */
  syncGraph(taskId: string): void {
    const r = this.rt.db.get<Row>('SELECT * FROM tasks WHERE id = ?', taskId);
    if (!r) return;
    const nodeId = `task:${r.id}`;
    this.graph.upsertNode({ id: nodeId, type: 'task', label: `${r.key} ${r.title}`, refId: r.id, sourceId: r.project_id, props: { status: r.status, priority: r.priority, key: r.key } });
    const edges: { src: string; dst: string; relation: 'implements' | 'depends_on' | 'derived_from' | 'belongs_to' | 'part_of' | 'references'; origin: 'explicit' }[] = [];
    for (const reqId of parseJson<string[]>(r.requirement_ids, [])) {
      const d = this.rt.db.get<{ id: string }>('SELECT id FROM documents WHERE upper(fm_id) = ?', reqId.toUpperCase());
      if (d) edges.push({ src: nodeId, dst: docNodeId(d.id), relation: 'implements', origin: 'explicit' });
    }
    for (const dep of this.rt.db.all<{ depends_on: string }>('SELECT depends_on FROM task_deps WHERE task_id = ?', r.id)) {
      const depNode = `task:${dep.depends_on}`;
      if (!this.graph.getNode(depNode)) this.syncGraphNodeOnly(dep.depends_on);
      edges.push({ src: nodeId, dst: depNode, relation: 'depends_on', origin: 'explicit' });
    }
    if (r.parent_id) {
      if (!this.graph.getNode(`task:${r.parent_id}`)) this.syncGraphNodeOnly(r.parent_id);
      edges.push({ src: nodeId, dst: `task:${r.parent_id}`, relation: 'part_of', origin: 'explicit' });
    }
    if (r.origin_doc_id && this.rt.db.get('SELECT id FROM documents WHERE id = ?', r.origin_doc_id)) edges.push({ src: nodeId, dst: docNodeId(r.origin_doc_id), relation: 'derived_from', origin: 'explicit' });
    if (r.project_id && this.graph.getNode(`project:${r.project_id}`)) edges.push({ src: nodeId, dst: `project:${r.project_id}`, relation: 'belongs_to', origin: 'explicit' });
    for (const l of this.rt.db.all<{ target_id: string }>("SELECT target_id FROM task_links WHERE task_id = ? AND target_type = 'document'", r.id)) {
      if (this.graph.getNode(docNodeId(l.target_id))) edges.push({ src: nodeId, dst: docNodeId(l.target_id), relation: 'references', origin: 'explicit' });
    }
    this.graph.setDerivedEdges(nodeId, edges.filter((e) => this.graph.getNode(e.dst)));
    this.rt.emit('graph.changed', { taskId: r.id });
  }

  private syncGraphNodeOnly(taskId: string): void {
    const r = this.rt.db.get<Row>('SELECT * FROM tasks WHERE id = ?', taskId);
    if (r) this.graph.upsertNode({ id: `task:${r.id}`, type: 'task', label: `${r.key} ${r.title}`, refId: r.id, sourceId: r.project_id, props: { status: r.status, priority: r.priority, key: r.key } });
  }

  export(format: 'md' | 'json' | 'csv', f: Parameters<TaskService['list']>[0] = {}): { fileName: string; contentType: string; body: string } {
    const items = this.list({ ...f, limit: 2000 }).items;
    const stamp = nowIso().slice(0, 10);
    if (format === 'json') return { fileName: `tasks-${stamp}.json`, contentType: 'application/json; charset=utf-8', body: JSON.stringify(items, null, 2) };
    if (format === 'csv') {
      const cell = (v: unknown) => {
        const s = Array.isArray(v) ? v.join('; ') : v === null || v === undefined ? '' : String(v);
        // neutralise spreadsheet formula injection
        const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return `"${safe.replace(/"/g, '""')}"`;
      };
      const head = ['key', 'title', 'status', 'priority', 'requirements', 'depends_on', 'acceptance_criteria', 'origin', 'completion_evidence', 'created_at', 'completed_at'];
      const lines = items.map((t) => [t.key, t.title, t.status, t.priority, t.requirementIds, t.dependsOn.map((d) => d.key), t.acceptanceCriteria, t.origin, t.completionEvidence, t.createdAt, t.completedAt].map(cell).join(','));
      return { fileName: `tasks-${stamp}.csv`, contentType: 'text/csv; charset=utf-8', body: `﻿${head.join(',')}\n${lines.join('\n')}\n` };
    }
    const label = new Map(TASK_STATUSES.map((s) => [s.id, s.label]));
    const md = [`# Tasks (${stamp})`, ''];
    for (const s of TASK_STATUSES) {
      const group = items.filter((t) => t.status === s.id);
      if (!group.length) continue;
      md.push(`## ${label.get(s.id)} (${group.length})`, '');
      for (const t of group) {
        md.push(`- [${t.status === 'done' ? 'x' : ' '}] **${t.key}** ${t.title}: priority ${t.priority}${t.requirementIds.length ? `; requirements: ${t.requirementIds.join(', ')}` : ''}${t.dependsOn.length ? `; depends on: ${t.dependsOn.map((d) => d.key).join(', ')}` : ''}`);
        for (const c of t.acceptanceCriteria) md.push(`  - criterion: ${c}`);
        if (t.completionEvidence) md.push(`  - confirmation: ${t.completionEvidence}`);
      }
      md.push('');
    }
    return { fileName: `tasks-${stamp}.md`, contentType: 'text/markdown; charset=utf-8', body: md.join('\n') };
  }
}
