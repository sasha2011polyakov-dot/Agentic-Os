import { posix } from 'node:path';
import type { Db } from '../db/db.ts';

/** Normalized lookup key for a link target: lowercase, forward slashes, no leading ./ or /, no .md extension. */
export function linkKey(target: string): string {
  return target
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\.(md|markdown)$/i, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** basename_lower stored on documents: file name without .md/.markdown, other extensions kept. */
export function basenameKey(relPath: string): string {
  return linkKey(posix.basename(relPath.replace(/\\/g, '/')));
}

export function pathKey(relPath: string): string {
  return linkKey(relPath);
}

interface Candidate {
  id: string;
  source_id: string;
  rel_path: string;
}

/**
 * Resolves wiki/markdown link targets to documents of one system, mimicking Obsidian:
 * explicit path (relative to the linking note, then vault-root, then partial suffix) → unique file name
 * (preferring same source, same folder, shortest path) → alias → frontmatter id → title.
 */
export class LinkResolver {
  constructor(private readonly db: Db) {}

  resolve(target: string, from: { sourceId: string; relPath: string }): string | null {
    const key = linkKey(target);
    if (!key) return null;
    if (key.includes('/')) {
      const fromDir = posix.dirname(from.relPath.replace(/\\/g, '/'));
      const relative = linkKey(posix.normalize(posix.join(fromDir, key)));
      for (const k of [relative, key]) {
        const hit = this.byPath(k, from.sourceId) ?? this.byPath(k, null);
        if (hit) return hit;
      }
      const suffix = this.db.all<Candidate>(
        "SELECT id, source_id, rel_path FROM documents WHERE ulower(rel_path) LIKE ? ESCAPE '\\' OR ulower(rel_path) LIKE ? ESCAPE '\\'",
        `%/${escapeLike(key)}.md`,
        `%/${escapeLike(key)}`,
      );
      return pick(suffix, from);
    }
    const byName = this.db.all<Candidate>('SELECT id, source_id, rel_path FROM documents WHERE basename_lower = ?', key);
    if (byName.length) return pick(byName, from);
    const byAlias = this.db.all<Candidate>('SELECT d.id, d.source_id, d.rel_path FROM doc_aliases a JOIN documents d ON d.id = a.doc_id WHERE a.alias_lower = ?', key);
    if (byAlias.length) return pick(byAlias, from);
    const byFmId = this.db.all<Candidate>('SELECT id, source_id, rel_path FROM documents WHERE ulower(fm_id) = ?', key);
    if (byFmId.length) return pick(byFmId, from);
    const byTitle = this.db.all<Candidate>('SELECT id, source_id, rel_path FROM documents WHERE title_lower = ?', key);
    return pick(byTitle, from);
  }

  private byPath(key: string, sourceId: string | null): string | null {
    const candidates = [`${key}.md`, `${key}.markdown`, key];
    const ph = candidates.map(() => '?').join(',');
    const row = sourceId
      ? this.db.get<{ id: string }>(`SELECT id FROM documents WHERE source_id = ? AND ulower(rel_path) IN (${ph}) LIMIT 1`, sourceId, ...candidates)
      : this.db.get<{ id: string }>(`SELECT id FROM documents WHERE ulower(rel_path) IN (${ph}) ORDER BY rel_path LIMIT 1`, ...candidates);
    return row?.id ?? null;
  }

  /** Is the target an attachment (image, pdf…) rather than a document? Such links never become "unresolved". */
  isAttachment(target: string, sourceId: string): boolean {
    const name = posix.basename(target.replace(/\\/g, '/')).toLowerCase();
    if (!/\.[a-z0-9]{2,5}$/.test(name) || /\.(md|markdown)$/.test(name)) return false;
    const row = this.db.get<{ c: number }>(
      "SELECT COUNT(*) AS c FROM files WHERE source_id = ? AND kind IN ('image','pdf','office','binary','other') AND (ulower(rel_path) = ? OR ulower(rel_path) LIKE ? ESCAPE '\\')",
      sourceId,
      name,
      `%/${escapeLike(name)}`,
    );
    return (row?.c ?? 0) > 0;
  }
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function pick(cands: Candidate[], from: { sourceId: string; relPath: string }): string | null {
  if (cands.length === 0) return null;
  if (cands.length === 1) return cands[0]!.id;
  const fromDir = posix.dirname(from.relPath);
  const score = (c: Candidate) => (c.source_id === from.sourceId ? 0 : 1000) + (posix.dirname(c.rel_path) === fromDir ? 0 : 100) + c.rel_path.split('/').length;
  return [...cands].sort((a, b) => score(a) - score(b) || a.rel_path.localeCompare(b.rel_path))[0]!.id;
}
