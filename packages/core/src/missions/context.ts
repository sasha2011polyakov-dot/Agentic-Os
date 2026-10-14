import type { SystemRuntime } from '../systems/runtime.ts';
import type { SystemManager } from '../systems/manager.ts';
import { services } from '../wiring.ts';
import { appAI } from '../ai/app-ai.ts';
import { compareSources, verifyQuote } from '../research/grounding.ts';
import type { SolutionOption, PlanStep } from './types.ts';

/** Structured outputs of the built-in mission agents (validated by their package schemas before they get here). */
export interface ExplorerOutput {
  findings: { id: string; text: string; evidence: unknown[] }[];
  relevant_files: { source_id: string; path: string; why: string }[];
  existing_solutions: { description: string; location: string; fit: 'full' | 'partial' | 'none' }[];
  architecture_notes: string[];
  unread: string[];
  limitations: string[];
}

export interface EvidenceItem {
  id: string;
  fact: string;
  kind: 'fact' | 'assumption';
  source: { type: 'document' | 'project_file'; ref: string; title: string };
  quote: string;
  relevance: 'high' | 'medium' | 'low';
  confidence: number;
  needs_verification: boolean;
}

export interface ResearcherOutput {
  evidence: EvidenceItem[];
  gaps: string[];
}

export interface WebOutput {
  sources: { url: string; title: string; published_at: string | null; why_selected: string; is_primary: boolean }[];
  claims: { id: string; statement: string; quote: string; source_url: string; confidence: number; kind: 'fact' | 'opinion' | 'unclear' }[];
  conflicts: { description: string; claim_ids: string[] }[];
  coverage: number;
  gaps: string[];
}

export interface ArchitectOutput {
  options: SolutionOption[];
  selected: string;
  rationale: string;
  tradeoffs: string[];
  needs_user_approval: boolean;
  approval_reason: string | null;
}

export interface PlannerOutput {
  steps: PlanStep[];
  notes: string[];
}

export interface ImplementerOutput {
  summary: string;
  actions: { type: string; target: string; description: string }[];
  artifacts: { type: string; ref: string; description: string }[];
  problems: string[];
  unverified: string[];
  next_steps: string[];
}

export interface SecurityOutput {
  risks: { severity: 'critical' | 'high' | 'medium' | 'low'; description: string; location: string; recommendation: string }[];
  verdict: 'ok' | 'concerns' | 'block';
}

export interface DocumenterOutput {
  title: string;
  markdown: string;
  target_folder: string;
}

export interface ReviewerOutput {
  verdict: 'pass' | 'needs_changes';
  distortions: string[];
  defects: { severity: 'critical' | 'major' | 'minor'; description: string; recommendation: string }[];
  notes: string;
}

export interface AdvisorOutput {
  answer: string;
  references: string[];
  suggested_actions: { action: 'add_requirement' | 'change_strategy' | 'research_option' | 'deny_tool' | 'retry_step' | 'none'; detail: string }[];
}

export type GroundedEvidence = EvidenceItem & { verified: boolean; verification: string; systemId: string | null };
export type GroundedClaim = WebOutput['claims'][number] & { quote_status: 'verified' | 'not_found_in_source' | 'source_missing' };

export interface CrossSystemHit {
  systemId: string;
  systemName: string;
  docId: string;
  title: string;
  path: string;
  snippet: string;
}

/**
 * Checks evidence quotes against the actual sources (home system first, then the systems explicitly selected for the
 * mission). Pure code: a model cannot confirm its own invention. Each verified item keeps the system it came from.
 */
export async function groundEvidence(rt: SystemRuntime, systems: SystemManager, extraSystems: string[], readable: Set<string> | null, evidence: EvidenceItem[]): Promise<GroundedEvidence[]> {
  const cache = new Map<string, { text: string; sourceId: string; systemId: string } | null>();
  const load = async (type: string, ref: string): Promise<{ text: string; sourceId: string; systemId: string } | null> => {
    const key = `${type}|${ref}`;
    if (cache.has(key)) return cache.get(key)!;
    let found: { text: string; sourceId: string; systemId: string } | null = null;
    const runtimes: SystemRuntime[] = [rt];
    for (const id of extraSystems) {
      try {
        runtimes.push(await systems.runtime(id));
      } catch {
        // an unavailable system simply cannot confirm anything
      }
    }
    for (const r of runtimes) {
      try {
        if (type === 'document') {
          const d = r.db.get<{ id: string; source_id: string }>('SELECT id, source_id FROM documents WHERE id = ?', ref);
          if (d) found = { text: (await services(r).docs.get(d.id)).content, sourceId: d.source_id, systemId: r.systemId };
        } else {
          const idx = ref.indexOf(':');
          if (idx > 0) {
            const sourceId = ref.slice(0, idx);
            const path = ref.slice(idx + 1);
            const f = r.db.get<{ status: string }>('SELECT status FROM files WHERE source_id = ? AND rel_path = ?', sourceId, path);
            if (f?.status === 'indexed') found = { text: (await services(r).sources.readFile(sourceId, path)).text, sourceId, systemId: r.systemId };
          }
        }
      } catch {
        found = null;
      }
      if (found) break;
    }
    cache.set(key, found);
    return found;
  };
  const out: GroundedEvidence[] = [];
  for (const e of evidence) {
    if (e.kind === 'assumption' || !e.quote || !e.source) {
      out.push({ ...e, kind: 'assumption', verified: false, verification: e.kind === 'assumption' ? 'допущение' : 'нет цитаты или источника', systemId: null });
      continue;
    }
    const src = await load(e.source.type, e.source.ref);
    if (!src) {
      out.push({ ...e, verified: false, verification: 'источник не найден', systemId: null });
      continue;
    }
    if (src.systemId === rt.systemId && readable && !readable.has(src.sourceId)) {
      out.push({ ...e, verified: false, verification: 'источник вне области поручения', systemId: src.systemId });
      continue;
    }
    const q = verifyQuote(e.quote, src.text);
    out.push({ ...e, kind: q.found ? e.kind : 'assumption', verified: q.found, verification: q.found ? `цитата найдена (${q.method})` : 'цитата не найдена в источнике — утверждение считается допущением', systemId: src.systemId });
  }
  return out;
}

/** Web claims: quotes are compared with the stored text of pages that were actually fetched during the mission. */
export function groundClaims(rt: SystemRuntime, claims: WebOutput['claims']): { claims: GroundedClaim[]; verified: number; domains: number } {
  const texts = appAI(rt.app).web.storedTexts(rt, claims.map((c) => c.source_url));
  const res = compareSources(claims.map((c) => ({ statement: c.statement, quote: c.quote, sourceUrl: c.source_url })), texts);
  const grounded = claims.map((c, i) => ({ ...c, quote_status: res.checks[i]!.quoteStatus }));
  const host = (u: string) => {
    try {
      return new URL(u).hostname.replace(/^www\./, '');
    } catch {
      return u;
    }
  };
  return { claims: grounded, verified: res.verified, domains: new Set(res.sourcesUsed.map(host)).size };
}

/** Deterministic keyword search in the other systems selected for the mission; results keep their system of origin. */
export async function crossSystemSearch(systems: SystemManager, systemIds: string[], query: string, limit = 8): Promise<{ hits: CrossSystemHit[]; problems: string[] }> {
  const hits: CrossSystemHit[] = [];
  const problems: string[] = [];
  const terms = query
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 4)
    .slice(0, 6);
  for (const id of systemIds) {
    let name = id;
    try {
      name = systems.get(id).name;
      const rt = await systems.runtime(id);
      const seen = new Set<string>();
      for (const q of terms.length ? terms : [query]) {
        const res = services(rt).search.search(q, { limit });
        for (const h of res.hits) {
          if (seen.has(h.docId)) continue;
          seen.add(h.docId);
          hits.push({ systemId: id, systemName: name, docId: h.docId, title: h.title, path: h.relPath, snippet: (h.snippet ?? '').replace(/\u0002|\u0003/g, '').slice(0, 300) });
        }
        if (seen.size >= limit) break;
      }
    } catch (e) {
      problems.push(`Система «${name}» недоступна: ${(e as Error).message}`);
    }
  }
  return { hits, problems };
}

/** Short, bounded representation of a step result for the next agents (relevant context, not everything). */
export function compactOutput(role: string, output: unknown, max = 4000): unknown {
  if (!output || typeof output !== 'object') return output;
  const o = output as Record<string, unknown>;
  let v: unknown;
  switch (role) {
    case 'project-explorer':
      v = { findings: o.findings, relevant_files: o.relevant_files, existing_solutions: o.existing_solutions, architecture_notes: o.architecture_notes, limitations: o.limitations };
      break;
    case 'researcher':
      v = { evidence: ((o.evidence as GroundedEvidence[] | undefined) ?? []).map((e) => ({ id: e.id, fact: e.fact, verified: e.verified ?? false, source: e.source, systemId: e.systemId ?? null })), gaps: o.gaps };
      break;
    case 'web-researcher':
      v = { claims: ((o.claims as GroundedClaim[] | undefined) ?? []).map((c) => ({ id: c.id, statement: c.statement, source_url: c.source_url, quote_status: c.quote_status ?? 'unchecked' })), gaps: o.gaps, conflicts: o.conflicts };
      break;
    case 'implementer':
      v = { summary: o.summary, actions: o.actions, problems: o.problems, unverified: o.unverified };
      break;
    default:
      v = o;
  }
  const s = JSON.stringify(v);
  if (s.length <= max) return v;
  return { truncated: true, excerpt: s.slice(0, max) };
}
