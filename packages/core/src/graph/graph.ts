import type { Db } from '../db/db.ts';
import { AppError } from '../util/errors.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';

export type NodeType =
  | 'document' | 'note' | 'project' | 'repository' | 'requirement' | 'spec' | 'task' | 'agent' | 'workflow'
  | 'decision' | 'source' | 'result' | 'research' | 'unresolved' | 'tag' | 'external';

export type Relation =
  | 'references' | 'belongs_to' | 'derived_from' | 'depends_on' | 'implements' | 'verifies' | 'created_by'
  | 'uses_source' | 'supersedes' | 'conflicts_with' | 'part_of' | 'blocks' | 'tagged' | 'produced';

export const RELATIONS: { id: Relation; label: string }[] = [
  { id: 'references', label: 'Ссылается на' },
  { id: 'belongs_to', label: 'Принадлежит проекту' },
  { id: 'derived_from', label: 'Создано на основании' },
  { id: 'depends_on', label: 'Зависит от' },
  { id: 'implements', label: 'Реализует требование' },
  { id: 'verifies', label: 'Проверяет' },
  { id: 'created_by', label: 'Создано агентом' },
  { id: 'uses_source', label: 'Использует источник' },
  { id: 'supersedes', label: 'Заменяет предыдущую версию' },
  { id: 'conflicts_with', label: 'Конфликтует с' },
  { id: 'part_of', label: 'Является частью' },
  { id: 'blocks', label: 'Блокирует выполнение' },
  { id: 'tagged', label: 'Отмечено тегом' },
  { id: 'produced', label: 'Результат выполнения' },
];

export type EdgeOrigin = 'explicit' | 'extracted' | 'ai_suggested' | 'system';
export type EdgeStatus = 'active' | 'suggested' | 'confirmed' | 'rejected';

export interface GraphNode {
  id: string;
  type: NodeType;
  label: string;
  refId: string | null;
  sourceId: string | null;
  props: Record<string, unknown>;
  degree?: number;
  inDegree?: number;
}

export interface GraphEdge {
  id: string;
  src: string;
  dst: string;
  relation: string;
  origin: EdgeOrigin;
  status: EdgeStatus;
  confidence: number | null;
  evidence: string | null;
  createdBy: string | null;
}

export interface EdgeInput {
  src: string;
  dst: string;
  relation: string;
  origin: EdgeOrigin;
  status?: EdgeStatus;
  confidence?: number | null;
  evidence?: string | null;
  createdBy?: string | null;
}

export interface GraphQuery {
  types?: string[];
  relations?: string[];
  sourceIds?: string[];
  tags?: string[];
  origins?: string[];
  search?: string;
  updatedFrom?: string;
  updatedTo?: string;
  includeSuggested?: boolean;
  includeUnresolved?: boolean;
  includeTags?: boolean;
  limit?: number;
}

export interface GraphResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: number;
  truncated: boolean;
}

interface NodeRow {
  id: string;
  type: string;
  label: string;
  ref_id: string | null;
  source_id: string | null;
  props: string;
}

interface EdgeRow {
  id: string;
  src: string;
  dst: string;
  relation: string;
  origin: EdgeOrigin;
  status: EdgeStatus;
  confidence: number | null;
  evidence: string | null;
  created_by: string | null;
}

const toNode = (r: NodeRow): GraphNode => ({ id: r.id, type: r.type as NodeType, label: r.label, refId: r.ref_id, sourceId: r.source_id, props: parseJson(r.props, {}) });
const toEdge = (r: EdgeRow): GraphEdge => ({ id: r.id, src: r.src, dst: r.dst, relation: r.relation, origin: r.origin, status: r.status, confidence: r.confidence, evidence: r.evidence, createdBy: r.created_by });

/** Maps a document type (frontmatter `type:` or inferred) to a graph node type. */
export function nodeTypeForDoc(docType: string | null, sourceKind: 'vault' | 'project'): NodeType {
  switch ((docType ?? '').toLowerCase()) {
    case 'requirement':
    case 'req':
    case 'требование':
      return 'requirement';
    case 'spec':
    case 'technical-spec':
    case 'tz':
    case 'тз':
      return 'spec';
    case 'decision':
    case 'adr':
    case 'architecture-decision':
    case 'решение':
      return 'decision';
    case 'research':
    case 'исследование':
      return 'research';
    case 'task':
      return 'task';
    case 'agent-report':
    case 'report':
      return 'result';
    case 'note':
    case 'daily':
    case 'meeting':
      return 'note';
    default:
      return sourceKind === 'vault' ? 'note' : 'document';
  }
}

export const docNodeId = (docId: string) => `doc:${docId}`;
export const unresolvedNodeId = (key: string) => `unresolved:${key}`;
export const projectNodeId = (sourceId: string) => `project:${sourceId}`;

/** Knowledge graph of ONE system. Edges carry explicit relation, provenance (origin) and status. */
export class GraphService {
  constructor(private readonly db: Db) {}

  upsertNode(n: { id: string; type: NodeType; label: string; refId?: string | null; sourceId?: string | null; props?: Record<string, unknown>; derivedKey?: string | null }): void {
    const now = nowIso();
    this.db.run(
      `INSERT INTO graph_nodes(id, type, label, ref_id, source_id, props, derived_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, label = excluded.label, ref_id = excluded.ref_id, source_id = excluded.source_id,
         props = excluded.props, derived_key = excluded.derived_key, updated_at = excluded.updated_at`,
      n.id,
      n.type,
      n.label,
      n.refId ?? null,
      n.sourceId ?? null,
      JSON.stringify(n.props ?? {}),
      n.derivedKey ?? null,
      now,
      now,
    );
  }

  removeNode(id: string): void {
    this.db.run('DELETE FROM graph_nodes WHERE id = ?', id);
  }

  getNode(id: string): GraphNode | null {
    const r = this.db.get<NodeRow>('SELECT id, type, label, ref_id, source_id, props FROM graph_nodes WHERE id = ?', id);
    return r ? toNode(r) : null;
  }

  /** Replaces every edge owned by derivedKey (e.g. all edges extracted from one document) atomically. */
  setDerivedEdges(derivedKey: string, edges: EdgeInput[]): void {
    this.db.transaction(() => {
      this.db.run("DELETE FROM graph_edges WHERE derived_key = ? AND origin IN ('explicit','extracted')", derivedKey);
      for (const e of edges) this.insertEdge(e, derivedKey);
    });
  }

  addEdge(e: EdgeInput, derivedKey: string | null = null): string {
    if (e.src === e.dst) throw new AppError('VALIDATION_FAILED', 'Связь узла с самим собой не допускается.');
    for (const n of [e.src, e.dst]) if (!this.getNode(n)) throw new AppError('NOT_FOUND', `Узел графа не найден: ${n}`);
    return this.insertEdge(e, derivedKey);
  }

  private insertEdge(e: EdgeInput, derivedKey: string | null): string {
    const id = newId('e');
    const now = nowIso();
    this.db.run(
      `INSERT INTO graph_edges(id, src, dst, relation, origin, status, confidence, evidence, created_by, derived_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(src, dst, relation, origin) DO UPDATE SET derived_key = excluded.derived_key, evidence = COALESCE(excluded.evidence, graph_edges.evidence),
         confidence = COALESCE(excluded.confidence, graph_edges.confidence), updated_at = excluded.updated_at`,
      id,
      e.src,
      e.dst,
      e.relation,
      e.origin,
      e.status ?? (e.origin === 'ai_suggested' ? 'suggested' : 'active'),
      e.confidence ?? null,
      e.evidence ?? null,
      e.createdBy ?? null,
      derivedKey,
      now,
      now,
    );
    return this.db.get<{ id: string }>('SELECT id FROM graph_edges WHERE src = ? AND dst = ? AND relation = ? AND origin = ?', e.src, e.dst, e.relation, e.origin)!.id;
  }

  removeEdge(id: string): void {
    this.db.run('DELETE FROM graph_edges WHERE id = ?', id);
  }

  /** Confirms or rejects an AI-suggested edge. Rejected suggestions are kept so they are not re-proposed. */
  reviewSuggestion(edgeId: string, decision: 'confirmed' | 'rejected'): GraphEdge {
    const e = this.db.get<EdgeRow>('SELECT * FROM graph_edges WHERE id = ?', edgeId);
    if (!e) throw new AppError('NOT_FOUND', 'Связь не найдена.');
    if (e.origin !== 'ai_suggested') throw new AppError('VALIDATION_FAILED', 'Подтверждать можно только предложенные связи.');
    this.db.run('UPDATE graph_edges SET status = ?, updated_at = ? WHERE id = ?', decision, nowIso(), edgeId);
    return toEdge({ ...e, status: decision });
  }

  /** Deletes unresolved placeholder nodes that no edge points to anymore. */
  pruneUnresolved(): number {
    return this.db.run("DELETE FROM graph_nodes WHERE type = 'unresolved' AND id NOT IN (SELECT dst FROM graph_edges) AND id NOT IN (SELECT src FROM graph_edges)").changes;
  }

  edgesOf(nodeId: string): { outgoing: GraphEdge[]; incoming: GraphEdge[] } {
    return {
      outgoing: this.db.all<EdgeRow>("SELECT * FROM graph_edges WHERE src = ? AND status <> 'rejected'", nodeId).map(toEdge),
      incoming: this.db.all<EdgeRow>("SELECT * FROM graph_edges WHERE dst = ? AND status <> 'rejected'", nodeId).map(toEdge),
    };
  }

  // ---------- queries ----------

  private edgeFilterSql(q: GraphQuery, params: (string | number)[]): string {
    const where: string[] = ["e.status <> 'rejected'"];
    if (!q.includeSuggested) where.push("e.status <> 'suggested'");
    if (q.relations?.length) {
      where.push(`e.relation IN (${q.relations.map(() => '?').join(',')})`);
      params.push(...q.relations);
    }
    if (q.origins?.length) {
      where.push(`e.origin IN (${q.origins.map(() => '?').join(',')})`);
      params.push(...q.origins);
    }
    return where.join(' AND ');
  }

  private nodeFilter(q: GraphQuery): (n: GraphNode) => boolean {
    const types = q.types?.length ? new Set(q.types) : null;
    const sources = q.sourceIds?.length ? new Set(q.sourceIds) : null;
    const search = q.search?.trim().toLowerCase();
    return (n) => {
      if (!q.includeUnresolved && n.type === 'unresolved') return false;
      if (types && !types.has(n.type)) return false;
      if (sources && n.sourceId && !sources.has(n.sourceId)) return false;
      if (sources && !n.sourceId && n.type !== 'unresolved' && n.type !== 'tag') return false;
      if (q.updatedFrom || q.updatedTo) {
        const u = typeof n.props.updatedAt === 'string' ? n.props.updatedAt : null;
        if (!u) return false;
        if (q.updatedFrom && u < q.updatedFrom) return false;
        if (q.updatedTo && u > q.updatedTo) return false;
      }
      if (search && !n.label.toLowerCase().includes(search) && !String(n.props.path ?? '').toLowerCase().includes(search)) return false;
      return true;
    };
  }

  private tagFilteredDocs(tags: string[]): Set<string> {
    const rows = this.db.all<{ doc_id: string }>(`SELECT DISTINCT doc_id FROM doc_tags WHERE tag IN (${tags.map(() => '?').join(',')})`, ...tags.map((t) => t.toLowerCase().replace(/^#/, '')));
    return new Set(rows.map((r) => docNodeId(r.doc_id)));
  }

  /** Whole-system graph with filters. Large graphs are cut to the `limit` highest-degree nodes. */
  graph(q: GraphQuery = {}): GraphResult {
    const limit = Math.max(1, Math.min(q.limit ?? 1500, 20000));
    const nodes = this.db.all<NodeRow>('SELECT id, type, label, ref_id, source_id, props FROM graph_nodes').map(toNode);
    const filter = this.nodeFilter(q);
    const tagDocs = q.tags?.length ? this.tagFilteredDocs(q.tags) : null;
    const keep = new Map<string, GraphNode>();
    for (const n of nodes) {
      if (!filter(n)) continue;
      if (tagDocs && n.id.startsWith('doc:') && !tagDocs.has(n.id)) continue;
      if (tagDocs && !n.id.startsWith('doc:') && n.type !== 'unresolved') continue;
      keep.set(n.id, n);
    }
    const params: (string | number)[] = [];
    const edgeWhere = this.edgeFilterSql(q, params);
    let edges = this.db.all<EdgeRow>(`SELECT e.* FROM graph_edges e WHERE ${edgeWhere}`, ...params).map(toEdge).filter((e) => keep.has(e.src) && keep.has(e.dst));
    if (q.includeTags) {
      const tagRows = this.db.all<{ doc_id: string; tag: string; display: string }>('SELECT doc_id, tag, display FROM doc_tags');
      for (const t of tagRows) {
        const dn = docNodeId(t.doc_id);
        if (!keep.has(dn)) continue;
        const tid = `tag:${t.tag}`;
        if (!keep.has(tid)) keep.set(tid, { id: tid, type: 'tag', label: `#${t.display}`, refId: t.tag, sourceId: null, props: {} });
        edges.push({ id: `tagged:${t.doc_id}:${t.tag}`, src: dn, dst: tid, relation: 'tagged', origin: 'extracted', status: 'active', confidence: null, evidence: null, createdBy: null });
      }
    }
    const degree = new Map<string, number>();
    const inDegree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
      degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
      inDegree.set(e.dst, (inDegree.get(e.dst) ?? 0) + 1);
    }
    let list = [...keep.values()].map((n) => ({ ...n, degree: degree.get(n.id) ?? 0, inDegree: inDegree.get(n.id) ?? 0 }));
    const total = list.length;
    let truncated = false;
    if (list.length > limit) {
      list.sort((a, b) => b.degree - a.degree || a.label.localeCompare(b.label));
      list = list.slice(0, limit);
      truncated = true;
      const ids = new Set(list.map((n) => n.id));
      edges = edges.filter((e) => ids.has(e.src) && ids.has(e.dst));
    }
    return { nodes: list, edges, total, truncated };
  }

  /** Neighbourhood of a node up to `depth` hops (both directions). */
  local(nodeId: string, depth = 1, q: GraphQuery = {}): GraphResult {
    if (!this.getNode(nodeId)) throw new AppError('NOT_FOUND', 'Узел графа не найден.');
    const maxDepth = Math.max(1, Math.min(depth, 4));
    const params: (string | number)[] = [];
    const edgeWhere = this.edgeFilterSql(q, params);
    const filter = this.nodeFilter({ ...q, includeUnresolved: q.includeUnresolved ?? true, search: undefined });
    const seen = new Set<string>([nodeId]);
    const edges = new Map<string, GraphEdge>();
    let frontier = [nodeId];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const placeholders = frontier.map(() => '?').join(',');
      const rows = this.db
        .all<EdgeRow>(`SELECT e.* FROM graph_edges e WHERE ${edgeWhere} AND (e.src IN (${placeholders}) OR e.dst IN (${placeholders}))`, ...params, ...frontier, ...frontier)
        .map(toEdge);
      const next: string[] = [];
      for (const e of rows) {
        edges.set(e.id, e);
        for (const n of [e.src, e.dst]) {
          if (!seen.has(n)) {
            seen.add(n);
            next.push(n);
          }
        }
      }
      frontier = next;
      if (seen.size > (q.limit ?? 800)) break;
    }
    const nodes = this.nodesByIds([...seen]).filter((n) => n.id === nodeId || filter(n));
    const ids = new Set(nodes.map((n) => n.id));
    const edgeList = [...edges.values()].filter((e) => ids.has(e.src) && ids.has(e.dst));
    const degree = new Map<string, number>();
    for (const e of edgeList) {
      degree.set(e.src, (degree.get(e.src) ?? 0) + 1);
      degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1);
    }
    return { nodes: nodes.map((n) => ({ ...n, degree: degree.get(n.id) ?? 0 })), edges: edgeList, total: nodes.length, truncated: seen.size > (q.limit ?? 800) };
  }

  nodesByIds(ids: string[]): GraphNode[] {
    const out: GraphNode[] = [];
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      out.push(...this.db.all<NodeRow>(`SELECT id, type, label, ref_id, source_id, props FROM graph_nodes WHERE id IN (${chunk.map(() => '?').join(',')})`, ...chunk).map(toNode));
    }
    return out;
  }

  /** Shortest undirected path between two nodes (BFS), or null. */
  path(from: string, to: string, maxDepth = 6): string[] | null {
    if (from === to) return [from];
    const prev = new Map<string, string>([[from, from]]);
    let frontier = [from];
    for (let d = 0; d < maxDepth && frontier.length; d++) {
      const next: string[] = [];
      const ph = frontier.map(() => '?').join(',');
      const rows = this.db.all<{ src: string; dst: string }>(`SELECT src, dst FROM graph_edges WHERE status NOT IN ('rejected','suggested') AND (src IN (${ph}) OR dst IN (${ph}))`, ...frontier, ...frontier);
      for (const r of rows) {
        for (const [a, b] of [[r.src, r.dst], [r.dst, r.src]] as const) {
          if (prev.has(a) && !prev.has(b)) {
            prev.set(b, a);
            if (b === to) {
              const path = [to];
              let cur = to;
              while (cur !== from) {
                cur = prev.get(cur)!;
                path.unshift(cur);
              }
              return path;
            }
            next.push(b);
          }
        }
      }
      frontier = next;
    }
    return null;
  }

  /** Directed cycles over dependency-like relations (Tarjan SCC; components of size > 1 or self loops). */
  cycles(relations: string[] = ['depends_on', 'blocks', 'part_of']): string[][] {
    const rows = this.db.all<{ src: string; dst: string }>(`SELECT src, dst FROM graph_edges WHERE status NOT IN ('rejected','suggested') AND relation IN (${relations.map(() => '?').join(',')})`, ...relations);
    return findCycles(rows.map((r) => [r.src, r.dst] as [string, string]));
  }

  /** Documents without any link in or out; documents nobody links to. */
  orphans(): { isolated: GraphNode[]; noIncoming: GraphNode[] } {
    const isolated = this.db
      .all<NodeRow>("SELECT id, type, label, ref_id, source_id, props FROM graph_nodes n WHERE id LIKE 'doc:%' AND NOT EXISTS (SELECT 1 FROM graph_edges e WHERE (e.src = n.id OR e.dst = n.id) AND e.status NOT IN ('rejected','suggested'))")
      .map(toNode);
    const noIncoming = this.db
      .all<NodeRow>("SELECT id, type, label, ref_id, source_id, props FROM graph_nodes n WHERE id LIKE 'doc:%' AND NOT EXISTS (SELECT 1 FROM graph_edges e WHERE e.dst = n.id AND e.relation <> 'belongs_to' AND e.status NOT IN ('rejected','suggested'))")
      .map(toNode);
    return { isolated, noIncoming };
  }

  suggestions(limit = 100): (GraphEdge & { srcLabel: string; dstLabel: string })[] {
    return this.db
      .all<EdgeRow & { src_label: string; dst_label: string }>(
        "SELECT e.*, s.label AS src_label, d.label AS dst_label FROM graph_edges e JOIN graph_nodes s ON s.id = e.src JOIN graph_nodes d ON d.id = e.dst WHERE e.status = 'suggested' ORDER BY e.confidence DESC LIMIT ?",
        limit,
      )
      .map((r) => ({ ...toEdge(r), srcLabel: r.src_label, dstLabel: r.dst_label }));
  }

  stats(): { nodes: number; edges: number; byType: Record<string, number>; byRelation: Record<string, number>; suggested: number } {
    const byType: Record<string, number> = {};
    for (const r of this.db.all<{ type: string; c: number }>('SELECT type, COUNT(*) AS c FROM graph_nodes GROUP BY type')) byType[r.type] = r.c;
    const byRelation: Record<string, number> = {};
    for (const r of this.db.all<{ relation: string; c: number }>("SELECT relation, COUNT(*) AS c FROM graph_edges WHERE status <> 'rejected' GROUP BY relation")) byRelation[r.relation] = r.c;
    return {
      nodes: this.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM graph_nodes')!.c,
      edges: this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM graph_edges WHERE status <> 'rejected'")!.c,
      byType,
      byRelation,
      suggested: this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM graph_edges WHERE status = 'suggested'")!.c,
    };
  }

  /** Consistency between documents and their graph nodes. */
  integrity(): string[] {
    const problems: string[] = [];
    const missingNodes = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM documents d WHERE NOT EXISTS (SELECT 1 FROM graph_nodes n WHERE n.id = 'doc:' || d.id)")!.c;
    if (missingNodes) problems.push(`${missingNodes} документ(ов) без узла графа`);
    const danglingNodes = this.db.get<{ c: number }>("SELECT COUNT(*) AS c FROM graph_nodes n WHERE n.id LIKE 'doc:%' AND NOT EXISTS (SELECT 1 FROM documents d WHERE 'doc:' || d.id = n.id)")!.c;
    if (danglingNodes) problems.push(`${danglingNodes} узел(ов) графа без документа`);
    return problems;
  }

  /** Removes doc nodes whose document no longer exists (repair after crashes). */
  removeDanglingDocNodes(): number {
    return this.db.run("DELETE FROM graph_nodes WHERE id LIKE 'doc:%' AND NOT EXISTS (SELECT 1 FROM documents d WHERE 'doc:' || d.id = graph_nodes.id)").changes;
  }
}

/** Tarjan's strongly connected components; returns components that form cycles. */
export function findCycles(edges: [string, string][]): string[][] {
  const adj = new Map<string, string[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const selfLoops = new Set(edges.filter(([a, b]) => a === b).map(([a]) => a));
  // iterative DFS to avoid stack overflow on long chains
  for (const start of adj.keys()) {
    if (idx.has(start)) continue;
    const work: { v: string; i: number }[] = [{ v: start, i: 0 }];
    idx.set(start, index);
    low.set(start, index);
    index++;
    stack.push(start);
    onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1]!;
      const neighbours = adj.get(frame.v)!;
      if (frame.i < neighbours.length) {
        const w = neighbours[frame.i++]!;
        if (!idx.has(w)) {
          idx.set(w, index);
          low.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, idx.get(w)!));
        }
      } else {
        work.pop();
        if (work.length) {
          const parent = work[work.length - 1]!.v;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
        }
        if (low.get(frame.v) === idx.get(frame.v)) {
          const comp: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
          } while (w !== frame.v);
          if (comp.length > 1 || selfLoops.has(comp[0]!)) out.push(comp.reverse());
        }
      }
    }
  }
  return out;
}
