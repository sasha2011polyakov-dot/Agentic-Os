/**
 * Deterministic checks of the specification pipeline. These never call a model: they catch what LLMs are bad at
 * noticing about their own output (broken references, cycles, vague wording, coverage gaps, unverified quotes).
 */
export interface Evidence {
  id: string;
  fact: string;
  kind: 'fact' | 'assumption';
  source?: { type: string; ref: string; title?: string };
  quote?: string;
  quote_verified?: boolean;
  relevance?: string;
  confidence?: number;
}

export interface Requirement {
  id: string;
  statement: string;
  type: string;
  rationale?: string;
  sources: string[];
  priority: 'must' | 'should' | 'could';
  acceptance_criteria: string[];
  depends_on: string[];
  status: 'confirmed' | 'needs_clarification' | 'assumption';
  clarifications?: string[];
}

export interface SpecTask {
  id: string;
  title: string;
  description: string;
  goal?: string;
  rationale?: string;
  requirement_ids: string[];
  depends_on: string[];
  acceptance_criteria: string[];
  affected_modules?: string[];
  unknowns?: string[];
  parent_id?: string | null;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export type FindingType = 'duplicate_id' | 'broken_ref' | 'cycle' | 'vague' | 'missing_criteria' | 'unsupported' | 'unverified_source' | 'duplicate' | 'orphan_task' | 'uncovered' | 'assumption';

export interface Finding {
  type: FindingType;
  severity: 'critical' | 'major' | 'minor';
  description: string;
  refs: string[];
}

/** Words that make a requirement unverifiable unless a measurable criterion is attached. */
const VAGUE = [
  'fast', 'quick', 'easy', 'easily', 'simple', 'convenient', 'intuitive', 'user-friendly', 'user friendly', 'friendly', 'flexible', 'efficient',
  'optimal', 'modern', 'reliable', 'robust', 'seamless', 'high quality', 'high-quality', 'scalable', 'maximally', 'minimally', 'sufficient', 'adequate',
  'etc', 'and so on', 'as needed', 'if needed', 'if necessary', 'when necessary', 'if possible', 'where possible', 'as possible', 'some', 'several', 'various',
];
const MEASURABLE = /\d|%|\b(?:milli)?seconds?\b|\bminutes?\b|\bhours?\b|\bms\b|\bsec\b|\bmin\b|no more than|no less than|not more than|not less than|at most|at least|≤|≥|<|>/iu;

export function vagueTerms(text: string): string[] {
  const t = text.toLowerCase();
  return VAGUE.filter((w) => (w.length <= 4 ? new RegExp(`\\b${w}\\b`).test(t) : t.includes(w)));
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.max(1, a.size + b.size - inter);
}

/** Finds cycles in a dependency map; returns each cycle as a list of ids. */
export function dependencyCycles(edges: Map<string, string[]>): string[][] {
  const state = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    state.set(id, 1);
    stack.push(id);
    for (const d of edges.get(id) ?? []) {
      if (!edges.has(d)) continue;
      if (state.get(d) === 1) {
        const cyc = stack.slice(stack.indexOf(d));
        const key = [...cyc].sort().join(',');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push([...cyc, d]);
        }
      } else if (!state.get(d)) visit(d);
    }
    stack.pop();
    state.set(id, 2);
  };
  for (const id of edges.keys()) if (!state.get(id)) visit(id);
  return cycles;
}

export function validateRequirements(requirements: Requirement[], evidence: Evidence[]): { findings: Finding[]; metrics: Record<string, number> } {
  const findings: Finding[] = [];
  const ev = new Map(evidence.map((e) => [e.id, e]));
  const ids = new Map<string, number>();
  for (const r of requirements) ids.set(r.id, (ids.get(r.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) findings.push({ type: 'duplicate_id', severity: 'critical', description: `The identifier ${id} is used ${n} times.`, refs: [id] });
  for (const r of requirements) {
    for (const s of r.sources ?? []) if (!ev.has(s)) findings.push({ type: 'broken_ref', severity: 'major', description: `${r.id} refers to evidence ${s} that does not exist.`, refs: [r.id, s] });
    const known = (r.sources ?? []).filter((s) => ev.has(s));
    if (!known.length && r.status !== 'assumption') findings.push({ type: 'unsupported', severity: 'major', description: `${r.id} relies on no evidence but is not marked as an assumption.`, refs: [r.id] });
    if (known.length && known.every((s) => ev.get(s)!.kind === 'assumption' || ev.get(s)!.quote_verified === false)) {
      findings.push({ type: 'unverified_source', severity: r.priority === 'must' ? 'major' : 'minor', description: `${r.id} relies only on unverified quotes or assumptions (${known.join(', ')}).`, refs: [r.id, ...known] });
    }
    for (const d of r.depends_on ?? []) if (!ids.has(d)) findings.push({ type: 'broken_ref', severity: 'major', description: `${r.id} depends on a requirement ${d} that does not exist.`, refs: [r.id, d] });
    if (!r.acceptance_criteria?.length) findings.push({ type: 'missing_criteria', severity: 'major', description: `${r.id} has no acceptance criteria, so it cannot be verified.`, refs: [r.id] });
    const vague = vagueTerms(r.statement);
    if (vague.length && !MEASURABLE.test(`${r.statement} ${(r.acceptance_criteria ?? []).join(' ')}`)) {
      findings.push({ type: 'vague', severity: 'minor', description: `${r.id}: vague wording (${vague.join(', ')}) without a measurable criterion.`, refs: [r.id] });
    }
    if (r.status === 'assumption') findings.push({ type: 'assumption', severity: 'minor', description: `${r.id} is an assumption: confirm or remove it.`, refs: [r.id] });
  }
  for (const cyc of dependencyCycles(new Map(requirements.map((r) => [r.id, r.depends_on ?? []])))) {
    findings.push({ type: 'cycle', severity: 'critical', description: `Circular requirement dependency: ${cyc.join(' → ')}.`, refs: cyc.slice(0, -1) });
  }
  const sets = requirements.map((r) => words(r.statement));
  for (let i = 0; i < requirements.length; i++) {
    for (let j = i + 1; j < requirements.length; j++) {
      if (sets[i]!.size >= 3 && jaccard(sets[i]!, sets[j]!) >= 0.85) findings.push({ type: 'duplicate', severity: 'minor', description: `${requirements[i]!.id} and ${requirements[j]!.id} nearly duplicate each other.`, refs: [requirements[i]!.id, requirements[j]!.id] });
    }
  }
  const n = requirements.length || 1;
  const metrics = {
    requirements: requirements.length,
    must: requirements.filter((r) => r.priority === 'must').length,
    withCriteriaPct: Math.round((requirements.filter((r) => r.acceptance_criteria?.length).length / n) * 100),
    withVerifiedSourcePct: Math.round((requirements.filter((r) => (r.sources ?? []).some((s) => ev.get(s)?.quote_verified === true)).length / n) * 100),
    assumptions: requirements.filter((r) => r.status === 'assumption').length,
    needsClarification: requirements.filter((r) => r.status === 'needs_clarification').length,
  };
  return { findings, metrics };
}

export function validateTasks(tasks: SpecTask[], requirements: Requirement[]): { findings: Finding[]; metrics: Record<string, number>; coverage: { requirement: string; tasks: string[] }[] } {
  const findings: Finding[] = [];
  const reqIds = new Set(requirements.map((r) => r.id));
  const ids = new Map<string, number>();
  for (const t of tasks) ids.set(t.id, (ids.get(t.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) findings.push({ type: 'duplicate_id', severity: 'critical', description: `The task identifier ${id} is used ${n} times.`, refs: [id] });
  for (const t of tasks) {
    for (const r of t.requirement_ids ?? []) if (!reqIds.has(r)) findings.push({ type: 'broken_ref', severity: 'major', description: `${t.id} refers to a requirement ${r} that does not exist.`, refs: [t.id, r] });
    for (const d of t.depends_on ?? []) if (!ids.has(d)) findings.push({ type: 'broken_ref', severity: 'major', description: `${t.id} depends on a task ${d} that does not exist.`, refs: [t.id, d] });
    if (t.parent_id && !ids.has(t.parent_id)) findings.push({ type: 'broken_ref', severity: 'minor', description: `${t.id}: the parent task ${t.parent_id} was not found.`, refs: [t.id] });
    if (!(t.requirement_ids ?? []).some((r) => reqIds.has(r))) findings.push({ type: 'orphan_task', severity: 'minor', description: `${t.id} is not linked to any requirement.`, refs: [t.id] });
    if (!t.acceptance_criteria?.length) findings.push({ type: 'missing_criteria', severity: 'major', description: `${t.id} has no acceptance criteria.`, refs: [t.id] });
  }
  for (const cyc of dependencyCycles(new Map(tasks.map((t) => [t.id, t.depends_on ?? []])))) {
    findings.push({ type: 'cycle', severity: 'critical', description: `Circular task dependency: ${cyc.join(' → ')}.`, refs: cyc.slice(0, -1) });
  }
  const coverage = requirements.map((r) => ({ requirement: r.id, tasks: tasks.filter((t) => (t.requirement_ids ?? []).includes(r.id)).map((t) => t.id) }));
  for (const c of coverage) {
    const r = requirements.find((x) => x.id === c.requirement)!;
    if (!c.tasks.length) findings.push({ type: 'uncovered', severity: r.priority === 'must' ? 'major' : 'minor', description: `Requirement ${r.id} (${r.priority}) is not covered by any task.`, refs: [r.id] });
  }
  const n = requirements.length || 1;
  const metrics = {
    tasks: tasks.length,
    coveragePct: Math.round((coverage.filter((c) => c.tasks.length).length / n) * 100),
    mustCoveragePct: (() => {
      const must = coverage.filter((c) => requirements.find((r) => r.id === c.requirement)?.priority === 'must');
      return must.length ? Math.round((must.filter((c) => c.tasks.length).length / must.length) * 100) : 100;
    })(),
    orphanTasks: findings.filter((f) => f.type === 'orphan_task').length,
  };
  return { findings, metrics, coverage };
}

export function countBlocking(findings: Finding[]): number {
  return findings.filter((f) => f.severity === 'critical').length;
}
