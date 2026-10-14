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
  draft: 'Draft',
  analyzing: 'Analyzing',
  researching: 'Researching',
  planning: 'Planning',
  awaiting_approval: 'Awaiting approval',
  ready: 'Ready to run',
  executing: 'Running',
  paused: 'Paused',
  needs_input: 'Needs your input',
  verifying: 'Verifying',
  needs_fix: 'Needs fixes',
  completed: 'Completed',
  partially_completed: 'Partially completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export const PHASE_LABELS: Record<MissionPhase, string> = {
  analysis: 'Task analysis',
  context: 'Context',
  research: 'Research',
  strategy: 'Solution choice',
  planning: 'Planning',
  execution: 'Execution',
  verification: 'Verification',
  fix: 'Fixes',
  review: 'Independent review',
  summary: 'Summary',
  done: 'Done',
};

export const TERMINAL_STATUSES: MissionStatus[] = ['completed', 'partially_completed', 'failed', 'cancelled'];
/** Statuses in which the engine is actively working (a driver may be running). */
export const WORKING_STATUSES: MissionStatus[] = ['analyzing', 'researching', 'planning', 'ready', 'executing', 'verifying', 'needs_fix'];

const ACTIVE: MissionStatus[] = ['analyzing', 'researching', 'planning', 'ready', 'executing', 'verifying', 'needs_fix'];

const TRANSITIONS: Record<MissionStatus, MissionStatus[]> = {
  draft: ['analyzing', 'needs_input', 'cancelled'],
  analyzing: ['researching', 'planning', 'needs_input', 'awaiting_approval', 'paused', 'failed', 'cancelled', 'analyzing'],
  researching: ['researching', 'planning', 'needs_input', 'awaiting_approval', 'paused', 'failed', 'cancelled'],
  planning: ['awaiting_approval', 'ready', 'executing', 'verifying', 'researching', 'completed', 'partially_completed', 'needs_input', 'paused', 'failed', 'cancelled', 'planning'],
  awaiting_approval: ['analyzing', 'researching', 'planning', 'ready', 'executing', 'verifying', 'needs_fix', 'needs_input', 'paused', 'cancelled', 'awaiting_approval'],
  ready: ['executing', 'paused', 'cancelled'],
  executing: ['awaiting_approval', 'verifying', 'needs_input', 'planning', 'researching', 'paused', 'failed', 'cancelled', 'executing'],
  verifying: ['needs_fix', 'completed', 'partially_completed', 'failed', 'needs_input', 'awaiting_approval', 'planning', 'researching', 'paused', 'cancelled', 'verifying'],
  needs_fix: ['executing', 'awaiting_approval', 'verifying', 'planning', 'researching', 'partially_completed', 'failed', 'needs_input', 'paused', 'cancelled'],
  paused: [...ACTIVE, 'awaiting_approval', 'needs_input', 'cancelled'],
  needs_input: [...ACTIVE, 'awaiting_approval', 'needs_input', 'paused', 'cancelled', 'failed'],
  // a finished mission can be continued explicitly (retry a stage, new requirement), never implicitly
  completed: ['analyzing', 'researching', 'planning', 'executing', 'verifying'],
  partially_completed: ['analyzing', 'researching', 'planning', 'executing', 'verifying', 'needs_fix'],
  failed: ['analyzing', 'researching', 'planning', 'executing', 'verifying', 'needs_fix', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: MissionStatus, to: MissionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: MissionStatus, to: MissionStatus): void {
  if (!canTransition(from, to)) throw new AppError('INVALID_STATE_TRANSITION', `The transition "${MISSION_STATUS_LABELS[from]}" → "${MISSION_STATUS_LABELS[to]}" is not allowed.`, { details: { from, to } });
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
