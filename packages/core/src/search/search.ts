import type { Db, SqlValue } from '../db/db.ts';
import { AppError } from '../util/errors.ts';
import { ftsTerm, isEmptyQuery, parseQuery, positiveTextTerms, type QueryNode } from './query.ts';

export interface SearchOptions {
  limit?: number;
  offset?: number;
  sourceIds?: string[];
  types?: string[];
  tags?: string[];
  sort?: 'relevance' | 'updated' | 'title';
}

export interface SearchHit {
  docId: string;
  sourceId: string;
  sourceName: string;
  relPath: string;
  title: string;
  docType: string | null;
  status: string | null;
  tags: string[];
  updatedAt: string | null;
  snippet: string | null;
  score: number;
  highlightTerms: string[];
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  query: string;
  explain: string;
  tookMs: number;
}

/** Snippet highlight markers (control chars: never valid in Markdown, safe to turn into <mark> after escaping). */
export const MARK_START = '\u0002';
export const MARK_END = '\u0003';

function compile(node: QueryNode, params: SqlValue[]): string {
  switch (node.kind) {
    case 'and':
      return node.items.length ? `(${node.items.map((n) => compile(n, params)).join(' AND ')})` : '1';
    case 'or':
      return node.items.length ? `(${node.items.map((n) => compile(n, params)).join(' OR ')})` : '1';
    case 'not':
      return `NOT ${compile(node.item, params)}`;
    case 'text': {
      const term = ftsTerm(node.value, node.phrase);
      if (!term) return '1';
      const expr = node.field === 'body' ? `body : ${term}` : node.field === 'title' ? `{title aliases} : ${term}` : term;
      params.push(expr);
      return 'd.n IN (SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?)';
    }
    case 'prop': {
      if (node.cmp === 'exists') {
        params.push(node.key);
        return 'EXISTS (SELECT 1 FROM doc_properties p WHERE p.doc_id = d.id AND p.key = ?)';
      }
      if (node.cmp === 'null') {
        params.push(node.key);
        return 'EXISTS (SELECT 1 FROM doc_properties p WHERE p.doc_id = d.id AND p.key = ? AND p.value_text IS NULL)';
      }
      const v = node.value ?? '';
      const num = Number(v);
      if (node.cmp !== '=') {
        params.push(node.key);
        if (v !== '' && Number.isFinite(num)) {
          params.push(num);
          return `EXISTS (SELECT 1 FROM doc_properties p WHERE p.doc_id = d.id AND p.key = ? AND p.value_num ${node.cmp} ?)`;
        }
        params.push(v);
        return `EXISTS (SELECT 1 FROM doc_properties p WHERE p.doc_id = d.id AND p.key = ? AND p.value_text ${node.cmp} ?)`;
      }
      const alternatives = v.split(/\s+OR\s+/).map((x) => x.trim()).filter(Boolean);
      params.push(node.key, ...alternatives.map((a) => a.toLowerCase()));
      return `EXISTS (SELECT 1 FROM doc_properties p WHERE p.doc_id = d.id AND p.key = ? AND ulower(p.value_text) IN (${alternatives.map(() => '?').join(',')}))`;
    }
    case 'op': {
      const v = node.value.trim();
      const like = `%${v.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      switch (node.op) {
        case 'file':
          params.push(like);
          return "d.basename_lower LIKE ? ESCAPE '\\'";
        case 'path':
          params.push(like);
          return "ulower(d.rel_path) LIKE ? ESCAPE '\\'";
        case 'tag': {
          const t = v.toLowerCase().replace(/^#/, '');
          params.push(t, `${t}/%`);
          return 'EXISTS (SELECT 1 FROM doc_tags g WHERE g.doc_id = d.id AND (g.tag = ? OR g.tag LIKE ?))';
        }
        case 'type':
          params.push(v.toLowerCase());
          return 'ulower(d.doc_type) = ?';
        case 'status':
          params.push(v.toLowerCase());
          return 'ulower(d.status) = ?';
        case 'project':
        case 'source':
          params.push(v.toLowerCase(), v);
          return 'd.source_id IN (SELECT id FROM sources WHERE ulower(name) = ? OR id = ?)';
        case 'linksto':
          params.push(v.toLowerCase(), v.toLowerCase());
          return 'EXISTS (SELECT 1 FROM doc_links l JOIN documents t ON t.id = l.resolved_doc_id WHERE l.src_doc_id = d.id AND (t.title_lower = ? OR t.basename_lower = ?))';
        case 'linkedfrom':
          params.push(v.toLowerCase(), v.toLowerCase());
          return 'EXISTS (SELECT 1 FROM doc_links l JOIN documents s ON s.id = l.src_doc_id WHERE l.resolved_doc_id = d.id AND (s.title_lower = ? OR s.basename_lower = ?))';
        case 'task':
        case 'task-todo':
        case 'task-done': {
          const done = node.op === 'task-done' ? ' AND c.done = 1' : node.op === 'task-todo' ? ' AND c.done = 0' : '';
          params.push(v ? like : '%');
          return `EXISTS (SELECT 1 FROM doc_checkboxes c WHERE c.doc_id = d.id AND ulower(c.text) LIKE ? ESCAPE '\\'${done})`;
        }
        case 'updated':
        case 'created': {
          const col = node.op === 'updated' ? 'd.updated_at' : 'd.created_at';
          const m = /^([<>]=?)?(.+)$/.exec(v);
          const cmp = m?.[1] ?? '>=';
          params.push(m?.[2] ?? v);
          return `${col} ${cmp} ?`;
        }
        default:
          return '1';
      }
    }
  }
}

function explain(node: QueryNode): string {
  switch (node.kind) {
    case 'and':
      return node.items.map(explain).join(' И ');
    case 'or':
      return `(${node.items.map(explain).join(' ИЛИ ')})`;
    case 'not':
      return `НЕ ${explain(node.item)}`;
    case 'text':
      return `${node.field === 'title' ? 'в названии' : node.field === 'body' ? 'в тексте' : ''} ${node.phrase ? `фраза «${node.value}»` : `слово «${node.value}»`}`.trim();
    case 'prop':
      return node.cmp === 'exists' ? `есть свойство ${node.key}` : node.cmp === 'null' ? `свойство ${node.key} пустое` : `свойство ${node.key} ${node.cmp} ${node.value}`;
    case 'op':
      return `${node.op}: ${node.value}`;
  }
}

/** Full-text + structured search over ONE system's index. */
export class SearchService {
  constructor(private readonly db: Db) {}

  search(query: string, opts: SearchOptions = {}): SearchResult {
    const started = Date.now();
    const node = parseQuery(query);
    const params: SqlValue[] = [];
    const where: string[] = [];
    if (!isEmptyQuery(node)) where.push(compile(node, params));
    if (opts.sourceIds?.length) {
      where.push(`d.source_id IN (${opts.sourceIds.map(() => '?').join(',')})`);
      params.push(...opts.sourceIds);
    }
    if (opts.types?.length) {
      where.push(`d.doc_type IN (${opts.types.map(() => '?').join(',')})`);
      params.push(...opts.types);
    }
    if (opts.tags?.length) {
      where.push(`EXISTS (SELECT 1 FROM doc_tags g WHERE g.doc_id = d.id AND g.tag IN (${opts.tags.map(() => '?').join(',')}))`);
      params.push(...opts.tags.map((t) => t.toLowerCase().replace(/^#/, '')));
    }
    const terms = positiveTextTerms(node).filter((t) => t.value.trim());
    const rankExpr = terms.map((t) => (t.field === 'body' ? `body : ${ftsTerm(t.value, t.phrase)}` : t.field === 'title' ? `{title aliases} : ${ftsTerm(t.value, t.phrase)}` : ftsTerm(t.value, t.phrase))).filter(Boolean).join(' OR ');
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(opts.limit ?? 50, 500);
    const offset = opts.offset ?? 0;
    try {
      const total = this.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM documents d ${whereSql}`, ...params)!.c;
      let rows: { id: string; source_id: string; source_name: string; rel_path: string; title: string; doc_type: string | null; status: string | null; updated_at: string | null; snip: string | null; score: number }[];
      if (rankExpr && (opts.sort ?? 'relevance') === 'relevance') {
        // bm25 weights: title 8, aliases 6, headings 3, body 1, path 2, tags 4
        rows = this.db.all(
          `SELECT d.id, d.source_id, s.name AS source_name, d.rel_path, d.title, d.doc_type, d.status, d.updated_at,
                  snippet(documents_fts, 3, '${MARK_START}', '${MARK_END}', '…', 18) AS snip,
                  bm25(documents_fts, 8.0, 6.0, 3.0, 1.0, 2.0, 4.0) AS score
             FROM documents d JOIN sources s ON s.id = d.source_id
             LEFT JOIN documents_fts ON documents_fts.rowid = d.n AND documents_fts MATCH ?
             ${whereSql}
             ORDER BY (score IS NULL), score, d.title_lower LIMIT ? OFFSET ?`,
          rankExpr,
          ...params,
          limit,
          offset,
        );
      } else {
        const order = opts.sort === 'title' ? 'd.title_lower' : 'd.updated_at DESC';
        rows = this.db.all(
          `SELECT d.id, d.source_id, s.name AS source_name, d.rel_path, d.title, d.doc_type, d.status, d.updated_at, NULL AS snip, 0 AS score
             FROM documents d JOIN sources s ON s.id = d.source_id ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`,
          ...params,
          limit,
          offset,
        );
      }
      const hits: SearchHit[] = rows.map((r) => ({
        docId: r.id,
        sourceId: r.source_id,
        sourceName: r.source_name,
        relPath: r.rel_path,
        title: r.title,
        docType: r.doc_type,
        status: r.status,
        tags: this.db.all<{ tag: string }>('SELECT tag FROM doc_tags WHERE doc_id = ? ORDER BY tag LIMIT 12', r.id).map((t) => t.tag),
        updatedAt: r.updated_at,
        snippet: r.snip,
        score: r.score === null ? 0 : -r.score,
        highlightTerms: terms.map((t) => t.value),
      }));
      return { hits, total, query, explain: explain(node), tookMs: Date.now() - started };
    } catch (e) {
      throw new AppError('VALIDATION_FAILED', 'Не удалось разобрать поисковый запрос.', { hint: 'Проверьте парность кавычек и скобок.', details: { error: e instanceof Error ? e.message : String(e) } });
    }
  }
}

/** Reciprocal Rank Fusion (Cormack et al., 2009): combines rankings without calibrating scores. */
export function reciprocalRankFusion<T>(lists: T[][], key: (item: T) => string, k = 60): { item: T; score: number }[] {
  const scores = new Map<string, { item: T; score: number }>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      const id = key(item);
      const entry = scores.get(id) ?? { item, score: 0 };
      entry.score += 1 / (k + rank + 1);
      scores.set(id, entry);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score);
}
