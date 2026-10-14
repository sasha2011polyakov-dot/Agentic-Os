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
  'project-explorer': 'Explores connected projects: structure, code, tests, existing solutions (read only).',
  researcher: 'Searches the knowledge base and documents of the system and collects evidence with quotes.',
  'web-researcher': 'Finds and reads external sources (if web access is allowed); quotes are checked by code.',
  'solution-architect': 'Compares solution options and justifies the choice.',
  implementer: 'Prepares file changes (a change set applied to a work copy), creates documents, runs allowed checks.',
  verifier: 'Checks the result against the acceptance criteria.',
  documenter: 'Prepares a document with the results (saved in the knowledge base of the system).',
  'security-reviewer': 'Reviews proposed changes for security risks.',
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
      errors.push(`Step "${s.title}": the identifier ${s.id} must look like S1, S2…`);
      continue;
    }
    if (seen.has(s.id)) {
      errors.push(`Duplicate step identifier ${s.id}.`);
      continue;
    }
    seen.add(s.id);
    if (!ctx.availableRoles.has(s.role) && !ctx.completed.has(s.id)) {
      errors.push(`${s.id}: the role "${s.role}" is unavailable (the agent is not installed or is disabled).`);
      continue;
    }
    if (ctx.mode === 'plan' && s.role === 'implementer') {
      errors.push(`${s.id}: in "Research and plan" mode, file changes cannot be planned: describe them as a future step in notes.`);
      continue;
    }
    steps.push({ ...s, depends_on: [...new Set((s.depends_on ?? []).filter((d) => d !== s.id))] });
  }
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    const missing = s.depends_on.filter((d) => !ids.has(d));
    if (missing.length) {
      warnings.push(`${s.id}: dependencies ${missing.join(', ')} were not found and were removed.`);
      s.depends_on = s.depends_on.filter((d) => ids.has(d));
    }
  }
  for (const cyc of dependencyCycles(new Map(steps.map((s) => [s.id, s.depends_on])))) errors.push(`Circular step dependency: ${cyc.join(' → ')}.`);
  if (ctx.mode === 'execute' && !steps.some((s) => s.role === 'verifier')) {
    const n = Math.max(0, ...steps.map((s) => Number(s.id.slice(1)) || 0)) + 1;
    steps.push({ id: `S${n}`, title: 'Verify the result', goal: 'Check the result against the acceptance criteria', role: 'verifier', inputs: [], expected_output: 'Status of each criterion with evidence', depends_on: steps.map((s) => s.id), tools: [], done_criteria: ['Every criterion assessed'], verification: 'deterministic checks and the verifier agent', risk: 'low', keep_existing: false });
    warnings.push('A final verification step was added to the plan.');
  }
  if (!steps.length && ctx.mode === 'execute') errors.push('The plan has no steps.');
  return { steps, errors, warnings };
}

/** Steps whose execution touches nothing outside the mission (used to explain approvals). */
export function riskyPlanReasons(steps: PlanStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) if (s.risk === 'high') out.push(`${s.id} "${s.title}": high risk`);
  return out;
}
