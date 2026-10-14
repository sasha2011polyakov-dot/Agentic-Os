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
    if (ctx.mode === 'plan') return { ...c, status: 'not_applicable', evidence: '', notes: 'Режим «Исследовать и спланировать»: выполнение не проводилось, критерий относится к будущей реализации.', decidedBy: 'guard' };
    const a = v?.criteria.find((x) => x.id === c.id);
    let status: CriterionStatus = a?.status ?? 'unverifiable';
    let evidence = (a?.evidence ?? '').trim();
    const notes: string[] = [];
    if (a?.notes) notes.push(a.notes);
    if (!a) notes.push('Проверяющий агент не оценил этот критерий.');
    if ((status === 'met' || status === 'partially_met') && !evidence) {
      notes.push(`Оценка агента «${status}» отклонена: нет доказательства.`);
      status = 'unverifiable';
    }
    switch (c.verification) {
      case 'check_command':
        if (failedChecks.length) {
          if (status === 'met' || status === 'partially_met') notes.push(`Проверки не пройдены: ${failedChecks.map((f) => f.name).join(', ')}.`);
          status = 'not_met';
          evidence = failedChecks.map((f) => `${f.name}: ${f.status}${f.exitCode !== null ? ` (код ${f.exitCode})` : ''}`).join('; ');
        } else if (!passedChecks.length) {
          if (status === 'met') notes.push('Команды проверки не запускались — подтвердить выполнение нельзя.');
          if (status !== 'not_met' && status !== 'not_applicable') status = 'unverifiable';
          if (ctx.checksNotRun.length) notes.push(`Не запущены: ${ctx.checksNotRun.map((x) => `${x.name} (${x.reason})`).join('; ')}.`);
        } else if (status === 'met' || status === 'unverifiable') {
          status = 'met';
          evidence = evidence || passedChecks.map((p) => `${p.name}: пройдена`).join('; ');
        }
        break;
      case 'artifact_exists':
        if (!ctx.artifacts.some((x) => x.status !== 'missing')) {
          if (status === 'met' || status === 'partially_met') notes.push('Артефакт не найден — оценка понижена.');
          if (status !== 'not_applicable') status = 'not_met';
        }
        break;
      case 'source_verification':
        if (ctx.verifiedClaims + ctx.verifiedEvidence === 0 && (status === 'met' || status === 'partially_met')) {
          notes.push('Нет ни одной цитаты, подтверждённой в источнике: вывод не считается подтверждённым.');
          status = 'unverifiable';
        } else if (status === 'met' && ctx.verifiedClaims > 0 && ctx.verifiedDomains < 2 && ctx.verifiedEvidence === 0) {
          notes.push('Вывод опирается на один независимый источник.');
          status = 'partially_met';
        }
        break;
      case 'manual':
        if (status === 'met' || status === 'partially_met') notes.push('Критерий проверяет только пользователь: отметьте его вручную.');
        if (status !== 'not_met' && status !== 'not_applicable') status = 'unverifiable';
        break;
      default:
        break;
    }
    if (ctx.changesOnlyProposed && status === 'met' && (c.verification === 'check_command' || c.verification === 'artifact_exists')) {
      notes.push('Изменения подготовлены, но не применены ни к рабочей копии, ни к проекту.');
      status = 'partially_met';
    }
    return { ...c, status, evidence, notes: notes.join(' '), decidedBy: 'guard' };
  });
}

/**
 * Final status (28.16): «Выполнена» only when every applicable criterion is met and nothing planned failed;
 * «Выполнена частично» when something was achieved; «Не выполнена» otherwise. Reasons are explicit.
 */
export function finalStatus(criteria: Criterion[], ctx: { mode: 'plan' | 'execute'; failedSteps: string[]; skippedSteps: string[]; limitations: string[]; reviewBlocking: string[]; planProduced: boolean }): { status: MissionStatus; reason: string } {
  if (ctx.mode === 'plan') {
    if (!ctx.planProduced) return { status: 'failed', reason: 'План не составлен.' };
    const reasons = ['План и исследование готовы; изменения не выполнялись (режим «Исследовать и спланировать»).'];
    if (ctx.limitations.length) reasons.push(`Ограничения: ${ctx.limitations.join('; ')}`);
    return { status: ctx.limitations.length ? 'partially_completed' : 'completed', reason: reasons.join(' ') };
  }
  const applicable = criteria.filter((c) => c.status !== 'not_applicable');
  const met = applicable.filter((c) => c.status === 'met');
  const some = applicable.filter((c) => c.status === 'met' || c.status === 'partially_met');
  const problems: string[] = [];
  const notMet = applicable.filter((c) => c.status !== 'met');
  if (notMet.length) problems.push(`критерии не выполнены или не подтверждены: ${notMet.map((c) => `${c.id} (${statusText(c.status)})`).join(', ')}`);
  if (ctx.failedSteps.length) problems.push(`не выполнены этапы: ${ctx.failedSteps.join(', ')}`);
  if (ctx.reviewBlocking.length) problems.push(`независимое ревью: ${ctx.reviewBlocking.join('; ')}`);
  if (applicable.length && met.length === applicable.length && !ctx.failedSteps.length && !ctx.reviewBlocking.length) {
    return { status: 'completed', reason: `Все применимые критерии выполнены (${met.length}).${ctx.limitations.length ? ` Замечания: ${ctx.limitations.join('; ')}` : ''}` };
  }
  if (!applicable.length) return { status: 'partially_completed', reason: 'Критерии готовности не заданы — подтвердить результат нельзя.' };
  if (some.length) return { status: 'partially_completed', reason: `Выполнено частично: ${problems.join('; ')}.` };
  return { status: 'failed', reason: `Не выполнено: ${problems.join('; ')}.` };
}

export function statusText(s: CriterionStatus): string {
  return { pending: 'ожидает проверки', met: 'выполнен', partially_met: 'выполнен частично', not_met: 'не выполнен', unverifiable: 'не удалось проверить', not_applicable: 'не применим' }[s];
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
    approach: args.strategy ? `${args.strategy.option ? `${args.strategy.option.name}: ` : ''}${args.strategy.rationale}` : 'Стратегия не выбиралась.',
    done: args.stepsDone.map((s) => `${s.title}: ${s.summary}`),
    files: args.files,
    documents: args.documents,
    checksRun: args.checks.filter((c) => c.kind === 'command').map((c) => ({ name: c.name, status: c.status, detail: c.exitCode !== null ? `код ${c.exitCode}` : c.status })),
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
    `**Итог:** ${MISSION_STATUS_LABELS[s.finalStatus]}. ${s.statusReason}`,
    '',
    '## Что требовалось',
    '',
    `> ${m.originalRequest.replace(/\n/g, '\n> ')}`,
    '',
    s.required,
    '',
    '## Что изучено',
    '',
    ...list(s.studied, 'дополнительные источники не изучались'),
    '',
  ];
  if (m.options.length) {
    out.push('## Рассмотренные варианты', '');
    for (const o of m.options) out.push(`### ${o.id}. ${o.name}${m.strategy?.selected === o.id ? ' — выбран' : ''}`, '', o.description, '', ...(o.pros.length ? [`Плюсы: ${o.pros.join('; ')}`] : []), ...(o.cons.length ? [`Минусы: ${o.cons.join('; ')}`] : []), '');
  }
  out.push('## Выбранный подход', '', s.approach, '');
  if (m.plan.length) out.push('## План', '', ...m.plan.map((p) => `- **${p.id}** ${p.title} — ${p.goal}${p.depends_on.length ? ` (после ${p.depends_on.join(', ')})` : ''}`), '');
  if (m.mode === 'execute') {
    out.push('## Что сделано', '', ...list(s.done, 'действия не выполнялись'), '');
    out.push('## Файлы', '', ...list(s.files.map((f) => `${f.source}: ${f.path} — ${f.op}, ${f.status}`), 'изменений файлов нет'), '');
  }
  out.push('## Документы', '', ...list(s.documents.map((d) => `[[${d.path.replace(/\.md$/, '')}|${d.title}]]`), 'документы не создавались'), '');
  out.push('## Проверки', '', ...list(s.checksRun.map((c) => `${c.name}: ${c.status} (${c.detail})`), 'команды проверки не запускались'), '');
  if (s.checksNotRun.length) out.push('Не выполнены:', '', ...s.checksNotRun.map((c) => `- ${c.name}: ${c.reason}`), '');
  out.push('## Критерии готовности', '', '| Критерий | Статус | Доказательство |', '|---|---|---|', ...s.criteria.map((c) => `| ${c.id}. ${c.text.replace(/\|/g, '\\|')} | ${statusText(c.status)} | ${(c.evidence || '—').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`), '');
  out.push('## Ограничения', '', ...list(s.limitations, 'нет'), '');
  out.push('## Где результаты', '', ...list(s.resultsLocation, '—'), '');
  out.push('## Что дальше', '', ...list(s.nextSteps, 'дополнительных действий не требуется'), '');
  return out.join('\n');
}
