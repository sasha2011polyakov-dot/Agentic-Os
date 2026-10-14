import { dependencyCycles } from '../spec/validators.ts';
import type { PlanRole, PlanStep } from './types.ts';

/** Agent that performs each plan role. Roles are fixed by the platform; agents are installed packages. */
export const ROLE_AGENTS: Record<PlanRole, string> = {
  'project-explorer': 'project-explorer',
  researcher: 'researcher',
  'web-researcher': 'web-researcher',
  'solution-architect': 'solution-architect',
  implementer: 'implementer',
  verifier: 'verifier',
  documenter: 'documenter',
  'security-reviewer': 'security-reviewer',
};

export const ROLE_DESCRIPTIONS: Record<PlanRole, string> = {
  'project-explorer': 'Изучает подключённые проекты: структуру, код, тесты, существующие решения (только чтение).',
  researcher: 'Ищет сведения в базе знаний системы и документах, собирает свидетельства с цитатами.',
  'web-researcher': 'Ищет и читает внешние источники (если веб-доступ разрешён), цитаты проверяются программно.',
  'solution-architect': 'Сравнивает варианты решения и обосновывает выбор.',
  implementer: 'Готовит изменения файлов (набор изменений, применяется к рабочей копии), создаёт документы, запускает разрешённые проверки.',
  verifier: 'Проверяет результат по критериям готовности.',
  documenter: 'Готовит документ с результатами (сохраняется в базе знаний системы).',
  'security-reviewer': 'Проверяет предлагаемые изменения на риски безопасности.',
};

/** Agents a mission may use (installed and enabled on explicit user request). */
export const MISSION_AGENTS = ['mission-analyst', 'project-explorer', 'researcher', 'web-researcher', 'solution-architect', 'mission-planner', 'implementer', 'verifier', 'security-reviewer', 'documenter', 'independent-reviewer', 'mission-advisor'];

export interface PlanCheck {
  steps: PlanStep[];
  errors: string[];
  warnings: string[];
}

/**
 * Deterministic plan validation: unique ids, existing dependencies, no cycles, only available roles, no file changes
 * in plan mode, and a final verification step. Fixable problems are fixed (with a warning); the rest are errors that
 * go back to the planner as feedback.
 */
export function validatePlan(raw: PlanStep[], ctx: { mode: 'plan' | 'execute'; availableRoles: Set<string>; completed: Set<string> }): PlanCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  const steps: PlanStep[] = [];
  for (const s of raw) {
    if (!/^S\d+$/.test(s.id)) {
      errors.push(`Шаг «${s.title}»: идентификатор ${s.id} должен иметь вид S1, S2…`);
      continue;
    }
    if (seen.has(s.id)) {
      errors.push(`Повторяющийся идентификатор шага ${s.id}.`);
      continue;
    }
    seen.add(s.id);
    if (!ctx.availableRoles.has(s.role) && !ctx.completed.has(s.id)) {
      errors.push(`${s.id}: роль «${s.role}» недоступна (агент не установлен или выключен).`);
      continue;
    }
    if (ctx.mode === 'plan' && s.role === 'implementer') {
      errors.push(`${s.id}: в режиме «Исследовать и спланировать» нельзя планировать изменения файлов — опишите их как будущий шаг в notes.`);
      continue;
    }
    steps.push({ ...s, depends_on: [...new Set((s.depends_on ?? []).filter((d) => d !== s.id))] });
  }
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const missing = s.depends_on.filter((d) => !ids.has(d));
    if (missing.length) {
      warnings.push(`${s.id}: зависимости ${missing.join(', ')} не найдены и убраны.`);
      s.depends_on = s.depends_on.filter((d) => ids.has(d));
    }
  }
  for (const cyc of dependencyCycles(new Map(steps.map((s) => [s.id, s.depends_on])))) errors.push(`Циклическая зависимость шагов: ${cyc.join(' → ')}.`);
  if (ctx.mode === 'execute' && !steps.some((s) => s.role === 'verifier')) {
    const n = Math.max(0, ...steps.map((s) => Number(s.id.slice(1)) || 0)) + 1;
    steps.push({ id: `S${n}`, title: 'Проверка результата', goal: 'Проверить результат по критериям готовности', role: 'verifier', inputs: [], expected_output: 'Статус каждого критерия с доказательствами', depends_on: steps.map((s) => s.id), tools: [], done_criteria: ['Все критерии оценены'], verification: 'детерминированная проверка и проверяющий агент', risk: 'low', keep_existing: false });
    warnings.push('В план добавлен заключительный шаг проверки.');
  }
  if (!steps.length && ctx.mode === 'execute') errors.push('План не содержит шагов.');
  return { steps, errors, warnings };
}

/** Steps whose execution touches nothing outside the mission (used to explain approvals). */
export function riskyPlanReasons(steps: PlanStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) if (s.risk === 'high') out.push(`${s.id} «${s.title}»: высокий риск`);
  return out;
}
