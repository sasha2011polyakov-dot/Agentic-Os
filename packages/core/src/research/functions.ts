import type { WorkflowFunction } from '../workflows/functions.ts';
import { services } from '../wiring.ts';
import { appAI } from '../ai/app-ai.ts';
import { compareSources } from './grounding.ts';
import { sanitizeFileName } from '../vault/documents.ts';
import { docNodeId } from '../graph/graph.ts';
import { newId } from '../util/ids.ts';
import { shortHash } from '../util/hash.ts';
import { nowIso } from '../util/time.ts';

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

interface Claim {
  id: string;
  statement: string;
  quote: string;
  source_url: string;
  confidence?: number;
  kind?: string;
  quote_status?: string;
}

interface Source {
  url: string;
  title?: string;
  published_at?: string | null;
  why_selected?: string;
  is_primary?: boolean;
}

export const RESEARCH_FUNCTIONS: WorkflowFunction[] = [
  {
    name: 'research.local',
    label: 'Search the knowledge base',
    description: 'What is already known about the question in the documents of the system (before going to the internet).',
    run(args, ctx) {
      const q = String(args.question ?? '').slice(0, 300);
      if (!q.trim()) return { findings: [] };
      const allowed = ctx.scope.sourceIds.length ? [...new Set([...ctx.scope.sourceIds, ctx.rt.primaryVaultId()])] : undefined;
      // plain words only: operators in a natural-language question must not change the query meaning
      const words = q.replace(/[^\p{L}\p{N}\s-]+/gu, ' ').split(/\s+/).filter((w) => w.length > 3).slice(0, 8);
      const res = services(ctx.rt).search.search(words.join(' OR ') || q, { limit: Number(args.limit ?? 8), ...(allowed ? { sourceIds: allowed } : {}) });
      return { findings: res.hits.map((h) => ({ docId: h.docId, title: h.title, snippet: (h.snippet ?? '').replace(/\u0002|\u0003/g, '').slice(0, 400) })) };
    },
  },
  {
    name: 'research.ground_claims',
    label: 'Verify source quotes',
    description: 'Checks in code the quotes of the claims against the saved texts of the downloaded pages and counts independent sources.',
    run(args, ctx) {
      const claims = arr<Claim>(args.claims);
      const texts = appAI(ctx.rt.app).web.storedTexts(ctx.rt, claims.map((c) => c.source_url));
      const res = compareSources(claims.map((c) => ({ statement: c.statement, quote: c.quote, sourceUrl: c.source_url })), texts);
      const grounded = claims.map((c, i) => ({ ...c, quote_status: res.checks[i]!.quoteStatus }));
      const verified = grounded.filter((c) => c.quote_status === 'verified');
      const hostOf = (u: string) => {
        try {
          return new URL(u).hostname.replace(/^www\./, '');
        } catch {
          return u;
        }
      };
      return {
        claims: grounded,
        verifiedClaims: verified,
        stats: { claims: claims.length, verified: verified.length, unverified: claims.length - verified.length, sources: res.sourcesUsed.length, independentDomains: new Set(res.sourcesUsed.map(hostOf)).size },
      };
    },
  },
  {
    name: 'research.save',
    label: 'Save the report',
    description: 'Saves the research report with sources, dates and the quote verification status; adds facts and links to the sources.',
    sideEffects: true,
    async run(args, ctx) {
      const s = services(ctx.rt);
      const existing = ctx.rt.db.get<{ doc_id: string }>("SELECT p.doc_id FROM doc_properties p JOIN documents d ON d.id = p.doc_id WHERE p.key = 'workflow_run' AND p.value_text = ? AND d.doc_type = 'research'", ctx.runId);
      const report = (args.report ?? {}) as { title?: string; summary?: string; markdown_body?: string; findings?: { statement: string; claim_ids: string[] }[]; limitations?: string[]; open_questions?: string[] };
      const claims = arr<Claim>(args.claims);
      const sources = arr<Source>(args.sources);
      const question = String(args.question ?? '');
      let docId: string;
      let path: string;
      if (existing) {
        docId = existing.doc_id;
        path = ctx.rt.db.get<{ rel_path: string }>('SELECT rel_path FROM documents WHERE id = ?', docId)!.rel_path;
      } else {
        const retrieved = new Map(ctx.rt.db.all<{ url: string; retrieved_at: string; published_at: string | null; title: string | null }>('SELECT url, retrieved_at, published_at, title FROM web_sources').map((r) => [r.url, r]));
        const verifiedCount = claims.filter((c) => c.quote_status === 'verified').length;
        const lines = [
          '---',
          'type: research',
          'status: draft',
          `question: ${JSON.stringify(question)}`,
          `created: ${nowIso().slice(0, 10)}`,
          `review_after: ${new Date(Date.now() + 90 * 86400_000).toISOString().slice(0, 10)}`,
          `workflow_run: ${ctx.runId}`,
          `sources: ${sources.length}`,
          `verified_claims: ${verifiedCount}`,
          '---',
          '',
          `# ${report.title || question}`,
          '',
          report.summary ? `> ${report.summary}` : '',
          '',
          report.markdown_body ?? '',
          '',
          '## Claims and quote verification',
          '',
          '| ID | Claim | Source | Quote |',
          '|---|---|---|---|',
          ...claims.map((c) => `| ${c.id} | ${c.statement.replace(/\|/g, '\\|').replace(/\n/g, ' ')} | ${c.source_url} | ${c.quote_status === 'verified' ? '✔ found' : c.quote_status === 'source_missing' ? '✖ source not downloaded' : '✖ not found'} |`),
          '',
          '## Sources',
          '',
          ...sources.map((src) => {
            const r = retrieved.get(src.url);
            return `- [${(src.title || r?.title || src.url).replace(/[[\]]/g, '')}](${src.url})${src.is_primary ? ' (primary source)' : ''}; published: ${src.published_at ?? r?.published_at ?? 'unknown'}; retrieved: ${r?.retrieved_at?.slice(0, 10) ?? 'not downloaded'}`;
          }),
          '',
        ];
        if (report.limitations?.length) lines.push('## Limitations', '', ...report.limitations.map((l) => `- ${l}`), '');
        if (report.open_questions?.length) lines.push('## Open questions', '', ...report.open_questions.map((q) => `- ${q}`), '');
        const title = report.title || question || 'Research';
        const d = await s.docs.create({ title, folder: ctx.rt.settings.get<string>('docs.researchFolder') || 'Research', fileName: sanitizeFileName(title), content: lines.join('\n'), actor: `workflow:${ctx.runId}` });
        docId = d.id;
        path = d.relPath;
      }
      // facts (verified claims only) and graph links to sources — both idempotent
      let facts = 0;
      for (const c of claims.filter((x) => x.quote_status === 'verified')) {
        const exists = ctx.rt.db.get('SELECT id FROM facts WHERE run_id = ? AND statement = ? AND source_ref = ?', ctx.runId, c.statement, c.source_url);
        if (exists) continue;
        ctx.rt.db.run(
          "INSERT INTO facts(id, statement, subject, source_kind, source_ref, source_label, quote, quote_status, status, confidence, run_id, created_at, verified_at, review_after) VALUES (?, ?, ?, 'web', ?, ?, ?, 'verified', 'verified', ?, ?, ?, ?, ?)",
          newId('fact'),
          c.statement,
          question.slice(0, 200),
          c.source_url,
          sources.find((x) => x.url === c.source_url)?.title ?? null,
          c.quote,
          c.confidence ?? null,
          ctx.runId,
          nowIso(),
          nowIso(),
          new Date(Date.now() + 90 * 86400_000).toISOString(),
        );
        facts++;
      }
      const g = s.graph;
      for (const src of sources) {
        const row = ctx.rt.db.get<{ id: string; title: string | null; retrieved_at: string }>('SELECT id, title, retrieved_at FROM web_sources WHERE url = ? OR canonical_url = ?', src.url, src.url);
        const nodeId = `web:${shortHash(src.url)}`;
        g.upsertNode({ id: nodeId, type: 'source', label: src.title || row?.title || src.url, refId: row?.id ?? null, props: { url: src.url, retrievedAt: row?.retrieved_at ?? null } });
        if (g.getNode(docNodeId(docId))) g.addEdge({ src: docNodeId(docId), dst: nodeId, relation: 'uses_source', origin: 'system', createdBy: `workflow:${ctx.runId}`, evidence: `run ${ctx.runId}` });
      }
      ctx.rt.emit('graph.changed', { docId });
      return { docId, path, facts, sources: sources.length };
    },
  },
];
