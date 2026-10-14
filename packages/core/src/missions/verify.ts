import type { Artifact, CheckRecord, Criterion, CriterionStatus, MissionSummary, NormalizedTask, PlanStep, Strategy } from './types.ts';
import { MISSION_STATUS_LABELS, type MissionStatus } from './state.ts';

export interface VerifierOutput {
  criteria: { id: string; status: Exclude<CriterionStatus, 'pending'>; evidence: string; notes: string }[];
  problems: { severity: 'critical' | 'major' | 'minor'; description: string; step_id: string | null; fix_hint: string }[];
  regressions_suspected: string[];
  overall: 'pass' | 'partial' | 'fail';
}

export interface GuardContext {
  mode: 'plan' | 'execute';
  /** Command checks of the current round (approved and actually run). */
  checks: CheckRecord[];
  /** Checks that exist for the projects but were not run (not approved, blocked, no work copy…). */
  checksNotRun: { name: string; reason: string }[];
  artifacts: Artifact[];
  /** Web claims whose quote was verified in code, and the number of distinct domains behind them. */
  verifiedClaims: number;
  verifiedDomains: number;
  /** Verified quotes from local documents/project files. */
  verifiedEvidence: number;
  /** Proposed changes exist but were not applied anywhere (prepare mode / user skipped). */
  changesOnlyProposed: boolean;
}

/**
 * Deterministic guard over the verifier's assessment (28.16): an agent's "met" is not accepted without evidence;
 * failed or unrun checks, missing artifacts and unconfirmed sources lower the status. The original agent verdict is
 * kept in `notes` so the user sees both.
 */
export function guardCriteria(criteria: Criterion[], v: VerifierOutput | null, ctx: GuardContext): Criterion[] {
  const failedChecks = ctx.checks.filter((c) => c.kind === 'command' && c.status !== 'passed');
  const passedChecks = ctx.checks.filter((c) => c.kind === 'command' && c.status === 'passed');
  return criteria.map((c) => {
    if (c.decidedBy === 'user') return c; // manual confirmation by the user wins
    if (ctx.mode === 'plan') return { ...c, status: 'not_applicable', evidence: '', notes: '"Research and plan" mode: nothing was executed; the criterion applies to the future implementation.', decidedBy: 'guard' };
    const a = v?.criteria.find((x) => x.id === c.id);
    let status: CriterionStatus = a?.status ?? 'unverifiable';
    let evidence = (a?.evidence ?? '').trim();
    const notes: string[] = [];
    if (a?.notes) notes.push(a.notes);
    if (!a) notes.push('The verifier agent did not assess this criterion.');
    if ((status === 'met' || status === 'partially_met') && !evidence) {
      notes.push(`The agent's assessment "${status}" was rejected: no evidence.`);
      status = 'unverifiable';
    }
    switch (c.verification) {
      case 'check_command':
        if (failedChecks.length) {
          if (status === 'met' || status === 'partially_met') notes.push(`Checks failed: ${failedChecks.map((f) => f.name).join(', ')}.`);
          status = 'not_met';
          evidence = failedChecks.map((f) => `${f.name}: ${f.status}${f.exitCode !== null ? ` (exit code ${f.exitCode})` : ''}`).join('; ');
        } else if (!passedChecks.length) {
          if (status === 'met') notes.push('No check commands were run: completion cannot be confirmed.');
          if (status !== 'not_met' && status !== 'not_applicable') status = 'unverifiable';
          if (ctx.checksNotRun.length) notes.push(`Not run: ${ctx.checksNotRun.map((x) => `${x.name} (${x.reason})`).join('; ')}.`);
        } else if (status === 'met' || status === 'unverifiable') {
          status = 'met';
          evidence = evidence || passedChecks.map((p) => `${p.name}: passed`).join('; ');
        }
        break;
      case 'artifact_exists':
        if (!ctx.artifacts.some((x) => x.status !== 'missing')) {
          if (status === 'met' || status === 'partially_met') notes.push('Artifact not found: the assessment was lowered.');
          if (status !== 'not_applicable') status = 'not_met';
        }
        break;
      case 'source_verification':
        if (ctx.verifiedClaims + ctx.verifiedEvidence === 0 && (status === 'met' || status === 'partially_met')) {
          notes.push('No quote was confirmed in a source: the conclusion is not considered confirmed.');
          status = 'unverifiable';
        } else if (status === 'met' && ctx.verifiedClaims > 0 && ctx.verifiedDomains < 2 && ctx.verifiedEvidence === 0) {
          notes.push('The conclusion relies on a single independent source.');
          status = 'partially_met';
        }
        break;
      case 'manual':
        if (status === 'met' || status === 'partially_met') notes.push('Only the user can verify this criterion: mark it manually.');
        if (status !== 'not_met' && status !== 'not_applicable') status = 'unverifiable';
        break;
      default:
        break;
    }
    if (ctx.changesOnlyProposed && status === 'met' && (c.verification === 'check_command' || c.verification === 'artifact_exists')) {
      notes.push('Changes were prepared but applied neither to a work copy nor to the project.');
      status = 'partially_met';
    }
    return { ...c, status, evidence, notes: notes.join(' '), decidedBy: 'guard' };
  });
}

/**
 * Final status (28.16): "Completed" only when every applicable criterion is met and nothing planned failed;
 * "Partially completed" when something was achieved; "Failed" otherwise. Reasons are explicit.
 */
export function finalStatus(criteria: Criterion[], ctx: { mode: 'plan' | 'execute'; failedSteps: string[]; notExecuted: string[]; limitations: string[]; blocking: string[]; planProduced: boolean }): { status: MissionStatus; reason: string } {
  if (ctx.mode === 'plan') {
    if (!ctx.planProduced) return { status: 'failed', reason: 'No plan was produced.' };
    const reasons = ['The plan and research are ready; no changes were made ("Research and plan" mode).'];
    if (ctx.limitations.length) reasons.push(`Limitations: ${ctx.limitations.join('; ')}`);
    return { status: ctx.limitations.length ? 'partially_completed' : 'completed', reason: reasons.join(' ') };
  }
  const applicable = criteria.filter((c) => c.status !== 'not_applicable');
  const met = applicable.filter((c) => c.status === 'met');
  const some = applicable.filter((c) => c.status === 'met' || c.status === 'partially_met');
  const problems: string[] = [];
  const notMet = applicable.filter((c) => c.status !== 'met');
  if (notMet.length) problems.push(`criteria not met or not confirmed: ${notMet.map((c) => `${c.id} (${statusText(c.status)})`).join(', ')}`);
  if (ctx.failedSteps.length) problems.push(`stages failed: ${ctx.failedSteps.join(', ')}`);
  // 28.15: a stage that did not run for lack of a model, tool, agent or access is never "fully done"
  if (ctx.notExecuted.length) problems.push(`did not run: ${ctx.notExecuted.join('; ')}`);
  // failed checks, serious verifier findings, failed validators, a blocking review: success is not claimed (28.16)
  if (ctx.blocking.length) problems.push(`unresolved problems: ${ctx.blocking.join('; ')}`);
  if (applicable.length && met.length === applicable.length && !ctx.failedSteps.length && !ctx.notExecuted.length && !ctx.blocking.length) {
    return { status: 'completed', reason: `All applicable criteria are met (${met.length}).${ctx.limitations.length ? ` Notes: ${ctx.limitations.join('; ')}` : ''}` };
  }
  if (!applicable.length) return { status: 'partially_completed', reason: `No acceptance criteria were set: the result cannot be confirmed.${problems.length ? ` ${problems.join('; ')}.` : ''}` };
  if (some.length) return { status: 'partially_completed', reason: `Partially completed: ${problems.join('; ')}.` };
  return { status: 'failed', reason: `Failed: ${problems.join('; ')}.` };
}

export function statusText(s: CriterionStatus): string {
  return { pending: 'pending', met: 'met', partially_met: 'partially met', not_met: 'not met', unverifiable: 'could not be verified', not_applicable: 'not applicable' }[s];
}

export function buildSummary(args: {
  originalRequest: string;
  normalized: NormalizedTask | null;
  strategy: Strategy | null;
  plan: PlanStep[];
  stepsDone: { title: string; summary: string }[];
  studied: string[];
  files: MissionSummary['files'];
  documents: MissionSummary['documents'];
  checks: CheckRecord[];
  checksNotRun: { name: string; reason: string }[];
  limitations: string[];
  criteria: Criterion[];
  status: { status: MissionStatus; reason: string };
  resultsLocation: string[];
  nextSteps: string[];
}): MissionSummary {
  return {
    required: args.normalized ? `${args.normalized.desired_outcome}${args.normalized.problem ? ` (${args.normalized.problem})` : ''}` : args.originalRequest,
    studied: args.studied,
    approach: args.strategy ? `${args.strategy.option ? `${args.strategy.option.name}: ` : ''}${args.strategy.rationale}` : 'No strategy was chosen.',
    done: args.stepsDone.map((s) => `${s.title}: ${s.summary}`),
    files: args.files,
    documents: args.documents,
    checksRun: args.checks.filter((c) => c.kind === 'command').map((c) => ({ name: c.name, status: c.status, detail: c.exitCode !== null ? `exit code ${c.exitCode}` : c.status })),
    checksNotRun: args.checksNotRun,
    limitations: args.limitations,
    resultsLocation: args.resultsLocation,
    nextSteps: args.nextSteps,
    criteria: args.criteria.map((c) => ({ id: c.id, text: c.text, status: c.status, evidence: c.evidence })),
    finalStatus: args.status.status,
    statusReason: args.status.reason,
  };
}

function list(items: string[], empty: string): string[] {
  return items.length ? items.map((i) => `- ${i}`) : [`- ${empty}`];
}

/** One useful report per mission (not a pile of reports): what was asked, done, checked and what remains. */
export function summaryMarkdown(m: { key: string; title: string; originalRequest: string; mode: 'plan' | 'execute'; plan: PlanStep[]; options: { id: string; name: string; description: string; pros: string[]; cons: string[] }[]; strategy: Strategy | null; runId: string }, s: MissionSummary): string {
  const out: string[] = [
    '---',
    'type: report',
    `status: ${s.finalStatus}`,
    `mission: ${m.key}`,
    `created: ${new Date().toISOString().slice(0, 10)}`,
    `workflow_run: ${m.runId}`,
    '---',
    '',
    `# ${m.key}. ${m.title}`,
    '',
    `**Outcome:** ${MISSION_STATUS_LABELS[s.finalStatus]}. ${s.statusReason}`,
    '',
    '## What was required',
    '',
    `> ${m.originalRequest.replace(/\n/g, '\n> ')}`,
    '',
    s.required,
    '',
    '## What was studied',
    '',
    ...list(s.studied, 'no additional sources were studied'),
    '',
  ];
  if (m.options.length) {
    out.push('## Options considered', '');
    for (const o of m.options) out.push(`### ${o.id}. ${o.name}${m.strategy?.selected === o.id ? ' (selected)' : ''}`, '', o.description, '', ...(o.pros.length ? [`Pros: ${o.pros.join('; ')}`] : []), ...(o.cons.length ? [`Cons: ${o.cons.join('; ')}`] : []), '');
  }
  out.push('## Chosen approach', '', s.approach, '');
  if (m.plan.length) out.push('## Plan', '', ...m.plan.map((p) => `- **${p.id}** ${p.title}: ${p.goal}${p.depends_on.length ? ` (after ${p.depends_on.join(', ')})` : ''}`), '');
  if (m.mode === 'execute') {
    out.push('## What was done', '', ...list(s.done, 'no actions were taken'), '');
    out.push('## Files', '', ...list(s.files.map((f) => `${f.source}: ${f.path} (${f.op}, ${f.status})`), 'no file changes'), '');
  }
  out.push('## Documents', '', ...list(s.documents.map((d) => `[[${d.path.replace(/\.md$/, '')}|${d.title}]]`), 'no documents were created'), '');
  out.push('## Checks', '', ...list(s.checksRun.map((c) => `${c.name}: ${c.status} (${c.detail})`), 'no check commands were run'), '');
  if (s.checksNotRun.length) out.push('Not run:', '', ...s.checksNotRun.map((c) => `- ${c.name}: ${c.reason}`), '');
  out.push('## Acceptance criteria', '', '| Criterion | Status | Evidence |', '|---|---|---|', ...s.criteria.map((c) => `| ${c.id}. ${c.text.replace(/\|/g, '\\|')} | ${statusText(c.status)} | ${(c.evidence || '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), '');
  out.push('## Limitations', '', ...list(s.limitations, 'none'), '');
  out.push('## Where the results are', '', ...list(s.resultsLocation, '—'), '');
  out.push('## Next steps', '', ...list(s.nextSteps, 'no further action needed'), '');
  return out.join('\n');
}
