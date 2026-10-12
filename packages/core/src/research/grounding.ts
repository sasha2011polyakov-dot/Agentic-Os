/**
 * Citation grounding (recommendation R1): a claim's quote must literally occur in the fetched source text.
 * Pure code — no model involved — so a model cannot "verify" its own invention.
 */
export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[«»“”„"]/g, '"')
    .replace(/[‘’']/g, "'")
    .replace(/[‐‑‒–—−]/g, '-')
    .replace(/ /g, ' ')
    .replace(/[*_`#>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalizeForMatch(s)
    .split(/[^\p{L}\p{N}$%.,-]+/u)
    .filter(Boolean);
}

export interface QuoteCheck {
  found: boolean;
  method: 'exact' | 'fuzzy' | 'none';
  ratio: number;
}

/** Exact normalized substring; for long quotes, ≥90% token overlap within a sliding window is accepted. */
export function verifyQuote(quote: string, sourceText: string): QuoteCheck {
  const q = normalizeForMatch(quote);
  if (q.length < 8) return { found: false, method: 'none', ratio: 0 };
  const src = normalizeForMatch(sourceText);
  if (src.includes(q)) return { found: true, method: 'exact', ratio: 1 };
  const qt = tokens(quote);
  if (qt.length < 8) return { found: false, method: 'none', ratio: 0 };
  const st = tokens(sourceText);
  const window = qt.length;
  let best = 0;
  const need = new Map<string, number>();
  for (const t of qt) need.set(t, (need.get(t) ?? 0) + 1);
  for (let i = 0; i + window <= st.length; i++) {
    const have = new Map<string, number>();
    for (let j = i; j < i + window; j++) have.set(st[j]!, (have.get(st[j]!) ?? 0) + 1);
    let hit = 0;
    for (const [t, n] of need) hit += Math.min(n, have.get(t) ?? 0);
    const ratio = hit / qt.length;
    if (ratio > best) best = ratio;
    if (best >= 0.999) break;
  }
  return best >= 0.9 ? { found: true, method: 'fuzzy', ratio: best } : { found: false, method: 'none', ratio: best };
}

export interface ClaimInput {
  statement: string;
  quote: string;
  sourceUrl: string;
}

export interface ClaimCheck extends ClaimInput {
  quoteStatus: 'verified' | 'not_found_in_source' | 'source_missing';
  method: QuoteCheck['method'];
  ratio: number;
}

/** Verifies claims against already-fetched sources and groups agreeing/disagreeing statements by URL. */
export function compareSources(claims: ClaimInput[], sources: Map<string, string>): { checks: ClaimCheck[]; verified: number; unverified: number; sourcesUsed: string[] } {
  const checks: ClaimCheck[] = claims.map((c) => {
    const text = sources.get(c.sourceUrl) ?? sources.get(c.sourceUrl.replace(/\/$/, '')) ?? sources.get(`${c.sourceUrl}/`);
    if (text === undefined) return { ...c, quoteStatus: 'source_missing', method: 'none', ratio: 0 };
    const r = verifyQuote(c.quote, text);
    return { ...c, quoteStatus: r.found ? 'verified' : 'not_found_in_source', method: r.method, ratio: Math.round(r.ratio * 100) / 100 };
  });
  return {
    checks,
    verified: checks.filter((c) => c.quoteStatus === 'verified').length,
    unverified: checks.filter((c) => c.quoteStatus !== 'verified').length,
    sourcesUsed: [...new Set(checks.filter((c) => c.quoteStatus === 'verified').map((c) => c.sourceUrl))],
  };
}
