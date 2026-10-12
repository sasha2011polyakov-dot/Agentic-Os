import type { SystemRuntime } from '../systems/runtime.ts';
import type { RunScope } from '../agents/permissions.ts';

/**
 * Deterministic workflow steps implemented in code (validators, renderers, savers). Packages cannot add
 * functions: only the platform registers them, so a workflow definition can never introduce executable code.
 */
export interface FunctionContext {
  rt: SystemRuntime;
  runId: string;
  stepId: string;
  nodeId: string;
  iteration: number;
  scope: RunScope & { containsConfidential?: boolean };
  runInput: Record<string, unknown>;
  signal: AbortSignal;
  log(message: string, data?: unknown): void;
}

export interface WorkflowFunction {
  name: string;
  label: string;
  description: string;
  /** Writes to the vault / tracker: must be idempotent per run (recovery may re-run it). */
  sideEffects?: boolean;
  run(args: Record<string, unknown>, ctx: FunctionContext): Promise<unknown> | unknown;
}

const registry = new Map<string, WorkflowFunction>();

export function registerFunctions(fns: WorkflowFunction[]): void {
  for (const f of fns) registry.set(f.name, f);
}

export function workflowFunction(name: string): WorkflowFunction | undefined {
  return registry.get(name);
}

export function workflowFunctions(): WorkflowFunction[] {
  return [...registry.values()];
}
