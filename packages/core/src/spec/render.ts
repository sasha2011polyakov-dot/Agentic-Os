import type { Evidence, Finding, Requirement, SpecTask } from './validators.ts';

export interface WriterOutput {
  title: string;
  summary: string;
  sections: { key: string; heading: string; content: string }[];
  assumptions: string[];
  open_questions: string[];
  omitted_sections: { key: string; reason: string }[];
}

export interface ContradictionIssue {
  id: string;
  type: string;
  severity: string;
  description: string;
  refs: string[];
  options?: string[];
  recommendation?: string;
  question?: string | null;
}

export interface SpecData {
  title: string;
  goal: string;
  writer: WriterOutput;
  requirements: Requirement[];
  tasks: SpecTask[];
  evidence: Evidence[];
  issues: ContradictionIssue[];
  resolutions: { issue: string; decision: string }[];
  findings: Finding[];
  metrics: Record<string, number>;
  review?: { verdict: string; summary: string; scores?: Record<string, number> } | null;
  runId: string;
  status: 'draft' | 'approved';
}

export interface RenderLinks {
  /** requirement id → wikilink target (document title) */
  requirementDocs?: Map<string, string>;
  /** spec task id → tracker key */
  taskKeys?: Map<string, string>;
}

const SECTION_ORDER = ['goal', 'context', 'problem', 'scope', 'glossary', 'current_state', 'scenarios', 'io', 'architecture_constraints', 'non_functional_notes', 'dependencies', 'testing', 'risks'];
const TYPE_LABEL: Record<string, string> = { functional: 'functional', non_functional: 'non-functional', constraint: 'constraint', business_rule: 'business rule' };
const STATUS_LABEL: Record<string, string> = { confirmed: 'confirmed', needs_clarification: 'needs clarification', assumption: 'assumption' };
const PRIORITY_LABEL: Record<string, string> = { must: 'must', should: 'should', could: 'could' };

function cell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function yamlString(s: string): string {
  return JSON.stringify(s);
}

function short(s: string, n = 60): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Deterministic Markdown of a specification: narrative from the writer, everything checkable from validated data. */
export function renderSpec(d: SpecData, links: RenderLinks = {}): string {
  const reqRef = (id: string) => (links.requirementDocs?.get(id) ? `[[${links.requirementDocs.get(id)}|${id}]]` : id);
  const taskRef = (id: string) => links.taskKeys?.get(id) ?? id;
  const ev = new Map(d.evidence.map((e) => [e.id, e]));
  const out: string[] = [];
  out.push('---', 'type: spec', `status: ${d.status}`, `title: ${yamlString(d.title)}`, `created: ${new Date().toISOString().slice(0, 10)}`, `workflow_run: ${d.runId}`, `requirements: ${d.requirements.length}`, `tasks: ${d.tasks.length}`, '---', '');
  out.push(`# ${d.title}`, '');
  if (d.writer.summary) out.push(`> ${d.writer.summary.replace(/\n/g, '\n> ')}`, '');
  if (d.status === 'draft') out.push('> [!note] Draft: the user has not approved this document yet.', '');

  const order = (k: string) => {
    const i = SECTION_ORDER.indexOf(k);
    return i === -1 ? SECTION_ORDER.length : i;
  };
  const sections = [...d.writer.sections].sort((a, b) => order(a.key) - order(b.key));
  for (const s of sections) out.push(`## ${s.heading || s.key}`, '', s.content.trim(), '');

  out.push('## Requirements', '');
  if (!d.requirements.length) out.push('_No requirements were formulated._', '');
  else {
    out.push('| ID | Requirement | Type | Priority | Status | Sources |', '|---|---|---|---|---|---|');
    for (const r of d.requirements) out.push(`| ${reqRef(r.id)} | ${cell(short(r.statement, 120))} | ${TYPE_LABEL[r.type] ?? r.type} | ${PRIORITY_LABEL[r.priority] ?? r.priority} | ${STATUS_LABEL[r.status] ?? r.status} | ${(r.sources ?? []).join(', ') || '—'} |`);
    out.push('');
    for (const r of d.requirements) {
      out.push(`### ${r.id}. ${short(r.statement, 90)}`, '', r.statement, '');
      if (r.rationale) out.push(`**Rationale.** ${r.rationale}`, '');
      out.push('**Acceptance criteria:**', ...(r.acceptance_criteria?.length ? r.acceptance_criteria.map((c) => `- [ ] ${c}`) : ['- _not set_']), '');
      if (r.depends_on?.length) out.push(`**Depends on:** ${r.depends_on.map(reqRef).join(', ')}`, '');
      if (r.clarifications?.length) out.push('**Needs clarification:**', ...r.clarifications.map((c) => `- ${c}`), '');
    }
  }

  out.push('## Task decomposition', '');
  if (!d.tasks.length) out.push('_No tasks were formed._', '');
  for (const t of d.tasks) {
    out.push(`### ${taskRef(t.id)}. ${t.title}`, '', t.description, '');
    out.push(`- **Priority:** ${t.priority}`);
    out.push(`- **Requirements:** ${(t.requirement_ids ?? []).map(reqRef).join(', ') || '—'}`);
    if (t.depends_on?.length) out.push(`- **Depends on:** ${t.depends_on.map(taskRef).join(', ')}`);
    if (t.affected_modules?.length) out.push(`- **Affects:** ${t.affected_modules.join(', ')}`);
    if (t.goal) out.push(`- **Goal:** ${t.goal}`);
    out.push('- **Acceptance criteria:**', ...(t.acceptance_criteria?.length ? t.acceptance_criteria.map((c) => `  - [ ] ${c}`) : ['  - _not set_']));
    if (t.unknowns?.length) out.push('- **Unknowns:**', ...t.unknowns.map((u) => `  - ${u}`));
    out.push('');
  }

  out.push('## Traceability matrix', '', '| Requirement | Tasks | Evidence |', '|---|---|---|');
  for (const r of d.requirements) {
    const tasks = d.tasks.filter((t) => (t.requirement_ids ?? []).includes(r.id)).map((t) => taskRef(t.id));
    out.push(`| ${reqRef(r.id)} | ${tasks.join(', ') || '**none**'} | ${(r.sources ?? []).join(', ') || '—'} |`);
  }
  out.push('');

  out.push('## Evidence', '');
  if (!d.evidence.length) out.push('_No evidence was collected._', '');
  else {
    out.push('| ID | Claim | Source | Quote |', '|---|---|---|---|');
    for (const e of d.evidence) {
      const src = e.source ? `${e.source.title ?? e.source.ref}${e.source.type === 'document' ? ` (${e.source.ref})` : ''}` : '—';
      const q = e.kind === 'assumption' ? 'assumption' : e.quote_verified ? `✔ "${cell(short(e.quote ?? '', 80))}"` : `✖ not found in the source`;
      out.push(`| ${e.id} | ${cell(short(e.fact, 120))} | ${cell(src)} | ${q} |`);
    }
    out.push('');
  }

  if (d.issues.length) {
    out.push('## Contradictions and decisions', '');
    for (const i of d.issues) {
      const res = d.resolutions.find((r) => r.issue === i.id);
      out.push(`- **${i.id}** (${i.severity}, ${i.type}): ${i.description}${i.refs?.length ? ` (${i.refs.join(', ')})` : ''}${res ? `\n  - User decision: ${res.decision}` : i.recommendation ? `\n  - Recommendation: ${i.recommendation}` : ''}`);
    }
    out.push('');
  }
  if (d.writer.assumptions?.length) out.push('## Assumptions', '', ...d.writer.assumptions.map((a) => `- ${a}`), '');
  if (d.writer.open_questions?.length) out.push('## Open questions', '', ...d.writer.open_questions.map((q) => `- ${q}`), '');

  out.push('## Automatic checks', '');
  const m = d.metrics;
  out.push(
    `- Requirements: ${m.requirements ?? d.requirements.length} (must: ${m.must ?? '—'}), tasks: ${m.tasks ?? d.tasks.length}`,
    `- With acceptance criteria: ${m.withCriteriaPct ?? '—'}%; backed by a verified quote: ${m.withVerifiedSourcePct ?? '—'}%`,
    `- Coverage of requirements by tasks: ${m.coveragePct ?? '—'}% (must: ${m.mustCoveragePct ?? '—'}%)`,
    `- Evidence: ${d.evidence.length}, quotes confirmed: ${d.evidence.filter((e) => e.quote_verified).length}`,
  );
  if (d.review) out.push(`- Review: ${d.review.verdict === 'pass' ? 'passed' : 'has comments'}: ${d.review.summary}`);
  out.push('');
  if (d.findings.length) {
    out.push('| Severity | Problem |', '|---|---|');
    for (const f of d.findings) out.push(`| ${f.severity} | ${cell(f.description)} |`);
    out.push('');
  } else out.push('The validators found no problems.', '');
  if (d.writer.omitted_sections?.length) out.push('## Sections not included', '', ...d.writer.omitted_sections.map((o) => `- ${o.key}: ${o.reason}`), '');
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/** Replaces local ids (REQ-001, T-001) with system-wide ones everywhere in the data, in one pass. */
export function renumber<T>(value: T, map: Map<string, string>): T {
  if (!map.size) return value;
  const re = new RegExp(`\\b(${[...map.keys()].map((k) => k.replace(/[-]/g, '\\-')).join('|')})\\b`, 'g');
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(re, (m) => map.get(m) ?? m);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

export function requirementDocMarkdown(r: Requirement, ctx: { specTitle: string; reqDocs: Map<string, string>; evidence: Map<string, Evidence>; tasks: { key: string; title: string }[]; runId: string }): string {
  const deps = (r.depends_on ?? []).map((d) => ctx.reqDocs.get(d)).filter(Boolean).map((t) => `"[[${t}]]"`);
  const sources = (r.sources ?? []).map((s) => ctx.evidence.get(s)).filter((e): e is Evidence => !!e && e.source?.type === 'document' && !!e.source.title).map((e) => `"[[${e.source!.title}]]"`);
  const fm = ['---', `id: ${r.id}`, 'type: requirement', `status: ${r.status === 'confirmed' ? 'draft' : r.status}`, `priority: ${r.priority}`, `kind: ${r.type}`, `part_of: "[[${ctx.specTitle}]]"`];
  if (deps.length) fm.push(`depends_on: [${deps.join(', ')}]`);
  if (sources.length) fm.push(`derived_from: [${[...new Set(sources)].join(', ')}]`);
  fm.push(`workflow_run: ${ctx.runId}`, '---', '');
  const body = [`# ${r.id}. ${short(r.statement, 90)}`, '', r.statement, ''];
  if (r.rationale) body.push(`**Rationale.** ${r.rationale}`, '');
  body.push('## Acceptance criteria', '', ...(r.acceptance_criteria?.length ? r.acceptance_criteria.map((c) => `- [ ] ${c}`) : ['- _not set_']), '');
  if (r.sources?.length) {
    body.push('## Evidence', '');
    for (const s of r.sources) {
      const e = ctx.evidence.get(s);
      if (!e) continue;
      body.push(`- ${s}: ${e.fact}${e.quote ? `: "${e.quote}"${e.quote_verified ? '' : ' (the quote was not found in the source)'}` : ''}${e.source ? ` (${e.source.title ?? e.source.ref})` : ''}`);
    }
    body.push('');
  }
  if (ctx.tasks.length) body.push('## Tasks', '', ...ctx.tasks.map((t) => `- ${t.key} ${t.title}`), '');
  body.push(`Part of the specification [[${ctx.specTitle}]].`, '');
  return `${fm.join('\n')}${body.join('\n')}`;
}

export { short as shortText };
