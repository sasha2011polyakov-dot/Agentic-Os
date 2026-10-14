import type { SystemRuntime } from '../systems/runtime.ts';
import type { GraphService } from '../graph/graph.ts';
import { isoDate } from '../util/time.ts';
import { parseJson } from '../util/json.ts';

export interface IntegrityIssue {
  kind: 'broken-link' | 'orphan' | 'duplicate' | 'missing-property' | 'stale' | 'dependency-cycle' | 'frontmatter-error' | 'graph-mismatch' | 'database';
  severity: 'info' | 'warning' | 'error';
  message: string;
  docIds: string[];
  details?: unknown;
}

export interface IntegrityReport {
  generatedAt: string;
  counts: Record<IntegrityIssue['kind'], number>;
  issues: IntegrityIssue[];
}

/** Deterministic knowledge-base health check (no model calls): recommendation R4. */
export function integrityReport(rt: SystemRuntime, graph: GraphService): IntegrityReport {
  const db = rt.db;
  const issues: IntegrityIssue[] = [];
  // broken links (vault documents only: project documentation may legitimately reference external material)
  const broken = db.all<{ src_doc_id: string; target_raw: string; line: number; title: string; rel_path: string }>(
    `SELECT l.src_doc_id, l.target_raw, l.line, d.title, d.rel_path FROM doc_links l JOIN documents d ON d.id = l.src_doc_id JOIN sources s ON s.id = d.source_id
     WHERE l.resolved_doc_id IS NULL AND l.target_key <> '' AND s.kind = 'vault' ORDER BY d.title_lower LIMIT 1000`,
  );
  const attachmentLike = /\.(png|jpe?g|gif|webp|svg|pdf|bmp|ico|avif)$/i;
  for (const b of broken) {
    if (attachmentLike.test(b.target_raw)) continue;
    issues.push({ kind: 'broken-link', severity: 'warning', message: `"${b.title}" links to a document that does not exist: "${b.target_raw}" (line ${b.line + 1}).`, docIds: [b.src_doc_id], details: { target: b.target_raw, line: b.line, path: b.rel_path } });
  }
  const { isolated } = graph.orphans();
  for (const n of isolated.slice(0, 500)) {
    if (n.sourceId !== rt.primaryVaultId()) continue;
    issues.push({ kind: 'orphan', severity: 'info', message: `"${n.label}" is not linked to any document.`, docIds: [n.refId ?? n.id.slice(4)] });
  }
  for (const d of db.all<{ hash: string; ids: string; titles: string; c: number }>("SELECT hash, group_concat(id, '|') AS ids, group_concat(title, ' | ') AS titles, COUNT(*) AS c FROM documents GROUP BY hash HAVING c > 1 LIMIT 200")) {
    issues.push({ kind: 'duplicate', severity: 'warning', message: `${d.c} documents have identical content: ${d.titles}.`, docIds: d.ids.split('|') });
  }
  const required = rt.settings.get<Record<string, string[]>>('docs.requiredProperties');
  for (const [type, keys] of Object.entries(required)) {
    const docs = db.all<{ id: string; title: string; frontmatter: string }>('SELECT id, title, frontmatter FROM documents WHERE doc_type = ?', type);
    for (const doc of docs) {
      const fm = parseJson<Record<string, unknown>>(doc.frontmatter, {});
      const missing = keys.filter((k) => fm[k] === undefined || fm[k] === null || fm[k] === '');
      if (missing.length) issues.push({ kind: 'missing-property', severity: 'warning', message: `"${doc.title}" (${type}): properties not filled in: ${missing.join(', ')}.`, docIds: [doc.id], details: { missing } });
    }
  }
  const today = isoDate();
  for (const s of db.all<{ id: string; title: string; review_after: string }>("SELECT id, title, review_after FROM documents WHERE review_after IS NOT NULL AND review_after <> '' AND review_after < ?", today)) {
    issues.push({ kind: 'stale', severity: 'info', message: `"${s.title}" needs a freshness review (due: ${s.review_after}).`, docIds: [s.id] });
  }
  for (const cycle of graph.cycles()) {
    const labels = graph.nodesByIds(cycle).map((n) => n.label);
    issues.push({ kind: 'dependency-cycle', severity: 'error', message: `Circular dependency: ${labels.join(' → ')} → ${labels[0]}.`, docIds: cycle.filter((id) => id.startsWith('doc:')).map((id) => id.slice(4)), details: { nodes: cycle } });
  }
  for (const p of graph.integrity()) issues.push({ kind: 'graph-mismatch', severity: 'warning', message: `Graph: ${p}. Run "Rebuild graph".`, docIds: [] });
  for (const p of rt.integrity()) issues.push({ kind: 'database', severity: 'error', message: `Database: ${p}`, docIds: [] });
  const counts = Object.fromEntries(['broken-link', 'orphan', 'duplicate', 'missing-property', 'stale', 'dependency-cycle', 'frontmatter-error', 'graph-mismatch', 'database'].map((k) => [k, issues.filter((i) => i.kind === k).length])) as IntegrityReport['counts'];
  return { generatedAt: new Date().toISOString(), counts, issues };
}
