import { AppError } from '../util/errors.ts';

/** Lifecycle of a mission (section 28.11). Transitions are explicit and validated. */
export type MissionStatus =
  | 'draft'
  | 'analyzing'
  | 'researching'
  | 'planning'
  | 'awaiting_approval'
  | 'ready'
  | 'executing'
  | 'paused'
  | 'needs_input'
  | 'verifying'
  | 'needs_fix'
  | 'completed'
  | 'partially_completed'
  | 'failed'
  | 'cancelled';

export type MissionPhase = 'analysis' | 'context' | 'research' | 'strategy' | 'planning' | 'execution' | 'verification' | 'fix' | 'review' | 'summary' | 'done';

export const MISSION_STATUS_LABELS: Record<MissionStatus, string> = {
  draft: 'Черновик',
  analyzing: 'Анализ',
  researching: 'Исследование',
  planning: 'Планирование',
  awaiting_approval: 'Ожидание подтверждения',
  ready: 'Готова к выполнению',
  executing: 'Выполняется',
  paused: 'Приостановлена',
  needs_input: 'Требуется вмешательство',
  verifying: 'Проверяется',
  needs_fix: 'Требуется исправление',
  completed: 'Выполнена',
  partially_completed: 'Выполнена частично',
  failed: 'Не выполнена',
  cancelled: 'Отменена',
};

export const PHASE_LABELS: Record<MissionPhase, string> = {
  analysis: 'Анализ задачи',
  context: 'Изучение контекста',
  research: 'Исследование',
  strategy: 'Выбор решения',
  planning: 'Планирование',
  execution: 'Выполнение',
  verification: 'Проверка результата',
  fix: 'Исправление',
  review: 'Независимое ревью',
  summary: 'Итог',
  done: 'Завершено',
};

export const TERMINAL_STATUSES: MissionStatus[] = ['completed', 'partially_completed', 'failed', 'cancelled'];
/** Statuses in which the engine is actively working (a driver may be running). */
export const WORKING_STATUSES: MissionStatus[] = ['analyzing', 'researching', 'planning', 'ready', 'executing', 'verifying', 'needs_fix'];

const ACTIVE: MissionStatus[] = ['analyzing', 'researching', 'planning', 'ready', 'executing', 'verifying', 'needs_fix'];

const TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  draft: ['analyzing', 'needs_input', 'cancelled'],
  analyzing: ['researching', 'planning', 'needs_input', 'awaiting_approval', 'paused', 'failed', 'cancelled', 'analyzing'],
  researching: ['researching', 'planning', 'needs_input', 'awaiting_approval', 'paused', 'failed', 'cancelled'],
  planning: ['awaiting_approval', 'ready', 'executing', 'completed', 'partially_completed', 'needs_input', 'paused', 'failed', 'cancelled', 'planning'],
  awaiting_approval: ['analyzing', 'researching', 'planning', 'ready', 'executing', 'verifying', 'needs_fix', 'needs_input', 'paused', 'cancelled', 'awaiting_approval'],
  ready: ['executing', 'paused', 'cancelled'],
  executing: ['awaiting_approval', 'verifying', 'needs_input', 'planning', 'paused', 'failed', 'cancelled', 'executing'],
  verifying: ['needs_fix', 'completed', 'partially_completed', 'failed', 'needs_input', 'awaiting_approval', 'paused', 'cancelled', 'verifying'],
  needs_fix: ['executing', 'awaiting_approval', 'verifying', 'partially_completed', 'failed', 'needs_input', 'paused', 'cancelled'],
  paused: [...ACTIVE, 'awaiting_approval', 'needs_input', 'cancelled'],
  needs_input: [...ACTIVE, 'awaiting_approval', 'needs_input', 'paused', 'cancelled', 'failed'],
  // a finished mission can be continued explicitly (retry a stage, new requirement), never implicitly
  completed: ['analyzing', 'planning', 'executing', 'verifying'],
  partially_completed: ['analyzing', 'planning', 'executing', 'verifying', 'needs_fix'],
  failed: ['analyzing', 'researching', 'planning', 'executing', 'verifying', 'needs_fix', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransition(from, to)) throw new AppError('INVALID_STATE_TRANSITION', `Переход «${MISSION_STATUS_LABELS[from]}» → «${MISSION_STATUS_LABELS[to]}» недопустим.`, { details: { from, to } });
}

/** Working status shown while a phase is being executed. */
export function statusForPhase(phase: MissionPhase): MissionStatus {
  switch (phase) {
    case 'analysis':
      return 'analyzing';
    case 'context':
    case 'research':
    case 'strategy':
      return 'researching';
    case 'planning':
      return 'planning';
    case 'execution':
    case 'fix':
      return 'executing';
    case 'verification':
    case 'review':
    case 'summary':
      return 'verifying';
    case 'done':
      return 'completed';
  }
}

export function transitionTable(): Record<MissionStatus, MissionStatus[]> {
  return TRANSITIONS;
}
