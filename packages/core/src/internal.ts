// Service-level API for the server and desktop shell (not a stable public API).
export { services, type SystemServices } from './wiring.ts';
export { integrityReport, type IntegrityReport, type IntegrityIssue } from './vault/integrity.ts';
export { NativeDialog, listDirectories } from './sources/dialog.ts';
export { RELATIONS, type GraphQuery, type GraphResult, type GraphNode, type GraphEdge } from './graph/graph.ts';
export { MARK_START, MARK_END, reciprocalRankFusion } from './search/search.ts';
export { BUILTIN_TEMPLATES } from './vault/templates.ts';
export { appAI, type AppAI } from './ai/app-ai.ts';
export { PROVIDER_PRESETS } from './ai/registry.ts';
export { TASK_TYPES, type TaskType, type ProviderKind, type Locality } from './ai/types.ts';
export type { ModelPolicy } from './ai/router.ts';
export { PERMISSIONS, type PermissionId, type GrantScope, type RunScope } from './agents/permissions.ts';
export type { AgentScope } from './agents/catalog.ts';
export type { AgentDefinitionInput } from './agents/service.ts';
export { KNOWN_TOOLS } from './agents/package.ts';
export { TOOLS } from './tools/registry.ts';
export { runCheck, validateChecks, type CheckDefinition, type CheckResult } from './missions/checks.ts';
export type { ChangeSetStatus, ChangeSetView } from './changes/change-sets.ts';
export { TASK_STATUSES, type TaskStatus, type TaskPriority, type TaskView } from './tasks/tasks.ts';
export type { RunStatus, RunView, StepView, WorkflowSummary, PreflightReport, ApprovalDecision } from './workflows/engine.ts';
export type { WorkflowDefinition, WorkflowNode, WorkflowLimits } from './workflows/definition.ts';
export { BUILTIN_WORKFLOWS } from './workflows/builtin.ts';
import { workflowFunctions } from './workflows/functions.ts';
/** Deterministic functions available to workflow definitions (for the editor palette). */
export function workflowFunctionList(): { name: string; label: string; description: string; sideEffects: boolean }[] {
  return workflowFunctions().map((f) => ({ name: f.name, label: f.label, description: f.description, sideEffects: !!f.sideEffects }));
}
export { ACCESS_MODES, analyzeRisks, categorize, type AccessMode, type RiskItem } from './security/policy.ts';
export { describeRepository, assertSafeGitArgs } from './sources/git.ts';
export type { SecurityEntry } from './security/log.ts';
