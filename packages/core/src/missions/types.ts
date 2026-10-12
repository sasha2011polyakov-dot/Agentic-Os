import type { MissionPhase, MissionStatus } from './state.ts';

/** Where a mission may act (28.14). The home system is always the one the mission belongs to. */
export interface MissionScope {
  kind: 'system' | 'projects' | 'systems' | 'public';
  /** Projects / vault of the home system the mission may read. Empty = whole system (kind=system). */
  sourceIds: string[];
  /** Documents the user pointed at explicitly. */
  docIds: string[];
  /** Other systems explicitly selected for reading (kind=systems). Results keep their system of origin. */
  systemIds: string[];
  allowWeb: boolean;
}

export interface MissionAttachment {
  kind: 'document' | 'project' | 'url' | 'text' | 'file';
  ref: string;
  title: string;
  /** For pasted text and uploaded text files: the content (bounded). */
  text?: string;
}

export interface MissionPolicy {
  /** Plan confirmation before execution: always, only for risky plans (default), or never. */
  approvePlan: 'always' | 'risky' | 'never';
  /** Tools the user forbade for this mission. */
  deniedTools: string[];
  /** Checks the user pre-approved (otherwise they are approved together with the plan). */
  preapprovedChecks: { sourceId: string; name: string }[];
  /** Bounded fix loop (28.5 stage 8). */
  maxFixRounds: number;
  /** Save a report into the system: auto (useful results only), always, never. */
  saveReport: 'auto' | 'always' | 'never';
}

export interface MissionLimits {
  maxModelCalls: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
  maxParallel: number;
  stepTimeoutMs: number;
}

export const DEFAULT_POLICY: MissionPolicy = { approvePlan: 'risky', deniedTools: [], preapprovedChecks: [], maxFixRounds: 2, saveReport: 'auto' };
export const DEFAULT_MISSION_LIMITS: MissionLimits = { maxModelCalls: 150, maxTokens: 1_000_000, maxCostUsd: null, maxParallel: 2, stepTimeoutMs: 600_000 };

/** Internal structured spec produced by the mission analyst (stage 1). */
export interface NormalizedTask {
  title: string;
  task_type: 'research' | 'design' | 'implementation' | 'bugfix' | 'improvement' | 'documentation' | 'spec' | 'analysis' | 'other';
  desired_outcome: string;
  problem: string;
  requirements: { id: string; text: string; source: 'request' | 'attachment' | 'inferred' | 'user' }[];
  constraints: string[];
  assumptions: string[];
  acceptance_criteria: { id: string; text: string; verification: CriterionVerification }[];
  risks: { text: string; level: 'low' | 'medium' | 'high' }[];
  questions: { text: string; blocking: boolean; default_assumption: string | null }[];
  complexity: 'simple' | 'moderate' | 'complex';
  needs: { project_exploration: boolean; local_research: boolean; web_research: boolean; alternatives: boolean; implementation: boolean; independent_review: boolean };
  summary_for_user: string;
}

export type CriterionVerification = 'artifact_exists' | 'check_command' | 'review' | 'source_verification' | 'manual';
export type CriterionStatus = 'pending' | 'met' | 'partially_met' | 'not_met' | 'unverifiable' | 'not_applicable';

export interface Criterion {
  id: string;
  text: string;
  verification: CriterionVerification;
  status: CriterionStatus;
  evidence: string;
  notes: string;
  /** Who set the final status: verifier agent, deterministic guard, or the user (manual criteria). */
  decidedBy: 'verifier' | 'guard' | 'user' | null;
  source: 'analyst' | 'user';
}

export type PlanRole = 'project-explorer' | 'researcher' | 'web-researcher' | 'solution-architect' | 'implementer' | 'verifier' | 'documenter' | 'security-reviewer';

export interface PlanStep {
  id: string;
  title: string;
  goal: string;
  role: PlanRole;
  inputs: string[];
  expected_output: string;
  depends_on: string[];
  tools: string[];
  done_criteria: string[];
  verification: string;
  risk: 'low' | 'medium' | 'high';
  keep_existing: boolean;
}

export interface SolutionOption {
  id: string;
  name: string;
  kind: 'reuse' | 'configure' | 'integrate_library' | 'extend' | 'new_component' | 'combined';
  description: string;
  covers_requirements: string[];
  pros: string[];
  cons: string[];
  risks: string[];
  scores: Record<string, number>;
  evidence: string[];
}

export interface Strategy {
  selected: string;
  option: SolutionOption | null;
  rationale: string;
  tradeoffs: string[];
  selectedBy: 'architect' | 'user' | 'implicit';
}

export type ApprovalKind = 'setup_agents' | 'model' | 'questions' | 'strategy' | 'plan' | 'apply_changes' | 'error' | 'budget' | 'conflict';

export interface PendingApproval {
  id: string;
  kind: ApprovalKind;
  title: string;
  message: string;
  data: Record<string, unknown>;
  /** Phase to continue with after the decision. */
  resumePhase: MissionPhase;
  createdAt: string;
}

export interface MissionDecision {
  decision: 'approve' | 'reject' | 'revise' | 'apply' | 'skip' | 'retry';
  comment?: string;
  answers?: { question: string; answer: string }[];
  approvedChecks?: { sourceId: string; name: string }[];
  optionId?: string;
}

export interface MissionStepView {
  id: string;
  seq: number;
  phase: MissionPhase;
  planStep: string | null;
  role: string;
  agentId: string | null;
  title: string;
  status: 'pending' | 'running' | 'waiting_for_approval' | 'completed' | 'failed' | 'cancelled' | 'skipped';
  dependsOn: string[];
  input?: unknown;
  output?: unknown;
  error: { code: string; message: string; hint?: string } | null;
  attempts: number;
  sideEffects: { tool: string; target: string }[];
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CheckRecord {
  id: string;
  round: number;
  kind: 'command' | 'criterion' | 'validator';
  name: string;
  sourceId: string | null;
  status: string;
  exitCode: number | null;
  durationMs: number | null;
  output: string | null;
  evidence: unknown;
  createdAt: string;
}

export interface Artifact {
  type: 'document' | 'change_set' | 'agent_draft' | 'workflow_draft' | 'report';
  ref: string;
  title: string;
  status: string;
  systemId: string;
  path?: string;
}

export interface MissionSummary {
  required: string;
  studied: string[];
  approach: string;
  done: string[];
  files: { path: string; source: string; op: string; status: string }[];
  documents: { title: string; path: string; docId: string }[];
  checksRun: { name: string; status: string; detail: string }[];
  checksNotRun: { name: string; reason: string }[];
  limitations: string[];
  resultsLocation: string[];
  nextSteps: string[];
  criteria: { id: string; text: string; status: CriterionStatus; evidence: string }[];
  finalStatus: MissionStatus;
  statusReason: string;
}

export interface MissionView {
  id: string;
  key: string;
  title: string;
  originalRequest: string;
  attachments: MissionAttachment[];
  normalized: NormalizedTask | null;
  revision: number;
  systemId: string;
  mode: 'plan' | 'execute';
  status: MissionStatus;
  statusLabel: string;
  statusReason: string | null;
  phase: MissionPhase;
  phaseLabel: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  scope: MissionScope;
  policy: MissionPolicy;
  limits: MissionLimits;
  assumptions: string[];
  constraints: string[];
  extraRequirements: { id: string; text: string; kind: string; addedAt: string }[];
  criteria: Criterion[];
  context: unknown;
  research: unknown;
  options: SolutionOption[];
  strategy: Strategy | null;
  plan: PlanStep[];
  planStale: boolean;
  steps: MissionStepView[];
  pending: PendingApproval | null;
  checks: CheckRecord[];
  approvedChecks: { sourceId: string; name: string }[];
  artifacts: Artifact[];
  sourceReferences: { kind: string; ref: string; title: string; systemId: string; verified: boolean | null }[];
  limitations: string[];
  fixRounds: number;
  review: unknown;
  summary: MissionSummary | null;
  reportDocId: string | null;
  totals: Record<string, number>;
  error: { code: string; message: string; hint?: string } | null;
  progress: { phases: { phase: MissionPhase; label: string; state: 'done' | 'current' | 'pending' | 'skipped' }[]; steps: { done: number; total: number } };
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
}
