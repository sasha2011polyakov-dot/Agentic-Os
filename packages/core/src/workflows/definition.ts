import { AppError } from '../util/errors.ts';
import { validator, formatErrors } from '../agents/schema.ts';
import { referencedPaths, type Condition, type Mapping } from './expr.ts';

export type NodeType = 'agent' | 'function' | 'approval' | 'loop';

interface NodeBase {
  id: string;
  type: NodeType;
  title: string;
  description?: string;
  dependsOn?: string[];
  /** Node runs only when the condition holds; otherwise it is "skipped" (with the reason recorded). */
  when?: Condition;
  /** Failure of an optional node does not fail the run; dependents see it as skipped. */
  optional?: boolean;
  /** UI position in the editor. */
  position?: { x: number; y: number };
}

export interface AgentNode extends NodeBase {
  type: 'agent';
  agent: string;
  input: Mapping;
  /** Additional instruction for this step (e.g. reviewer feedback). */
  note?: Mapping;
  /** Context documents to pass as untrusted material: mapping resolving to [{source, content, priority?}]. */
  context?: Mapping;
  retries?: number;
  timeoutMs?: number;
}

export interface FunctionNode extends NodeBase {
  type: 'function';
  fn: string;
  input: Mapping;
}

export interface ApprovalNode extends NodeBase {
  type: 'approval';
  /** What the user sees: resolved mapping (questions, documents, metrics). */
  prompt: Mapping;
  /** Questions the user must answer (resolved to [{id?, question, why?}]). */
  questions?: Mapping;
  /** reject cancels the run (default) or continues with decision "reject". */
  onReject?: 'cancel' | 'continue';
  /** Whether "send for revision with a comment" is offered (decision "revise"). */
  allowRevise?: boolean;
}

export interface LoopNode extends NodeBase {
  type: 'loop';
  body: string[];
  /** Stop when this holds after an iteration. */
  until: Condition;
  maxIterations: number | Mapping;
  /** Grants one more iteration past maxIterations (e.g. the user asked for a revision). Hard cap +5. */
  extendWhen?: Condition;
}

export type WorkflowNode = AgentNode | FunctionNode | ApprovalNode | LoopNode;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: number;
  category?: string;
  /** JSON Schema of the start form. */
  inputSchema: Record<string, unknown>;
  nodes: WorkflowNode[];
  /** Run result (resolved after completion). */
  output?: Mapping;
  /** Agents the workflow needs installed and enabled. */
  requires?: string[];
  limits?: Partial<WorkflowLimits>;
}

export interface WorkflowLimits {
  maxModelCalls: number | null;
  maxTokens: number | null;
  maxCostUsd: number | null;
  maxReviewIterations: number;
  stepTimeoutMs: number;
  maxParallel: number;
}

export const DEFAULT_LIMITS: WorkflowLimits = { maxModelCalls: 60, maxTokens: 400_000, maxCostUsd: null, maxReviewIterations: 2, stepTimeoutMs: 300_000, maxParallel: 2 };

const ID = '^[a-z][a-z0-9_]{0,40}$';

const DEFINITION_SCHEMA = {
  type: 'object',
  required: ['id', 'name', 'version', 'inputSchema', 'nodes'],
  properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9-]{1,63}$' },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 2000 },
    version: { type: 'integer', minimum: 1 },
    category: { type: 'string' },
    inputSchema: { type: 'object' },
    requires: { type: 'array', items: { type: 'string' } },
    limits: { type: 'object' },
    nodes: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        required: ['id', 'type', 'title'],
        properties: {
          id: { type: 'string', pattern: ID },
          type: { enum: ['agent', 'function', 'approval', 'loop'] },
          title: { type: 'string', minLength: 1, maxLength: 200 },
          dependsOn: { type: 'array', items: { type: 'string' } },
          optional: { type: 'boolean' },
          agent: { type: 'string' },
          fn: { type: 'string' },
          body: { type: 'array', items: { type: 'string' } },
          retries: { type: 'integer', minimum: 0, maximum: 5 },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 3_600_000 },
          onReject: { enum: ['cancel', 'continue'] },
          allowRevise: { type: 'boolean' },
        },
      },
    },
  },
};

export interface DefinitionCheck {
  ok: boolean;
  errors: { nodeId: string | null; message: string }[];
  warnings: { nodeId: string | null; message: string }[];
}

/** Structural validation of a definition (also used live by the visual editor). */
export function checkDefinition(def: unknown, known: { agents: Set<string>; functions: Set<string> }): DefinitionCheck {
  const errors: DefinitionCheck['errors'] = [];
  const warnings: DefinitionCheck['warnings'] = [];
  const v = validator(DEFINITION_SCHEMA);
  if (!v(def)) {
    for (const m of formatErrors(v.errors)) errors.push({ nodeId: null, message: m });
    return { ok: false, errors, warnings };
  }
  const d = def as WorkflowDefinition;
  const ids = new Set<string>();
  for (const n of d.nodes) {
    if (ids.has(n.id)) errors.push({ nodeId: n.id, message: `Повторяющийся идентификатор узла «${n.id}».` });
    ids.add(n.id);
  }
  const loopOf = new Map<string, string>();
  for (const n of d.nodes) {
    if (n.type !== 'loop') continue;
    if (!n.body?.length) errors.push({ nodeId: n.id, message: 'Цикл без узлов.' });
    if (!n.until) errors.push({ nodeId: n.id, message: 'У цикла нет условия завершения.' });
    if (n.maxIterations === undefined) errors.push({ nodeId: n.id, message: 'У цикла нет ограничения числа итераций.' });
    for (const b of n.body ?? []) {
      if (!ids.has(b)) errors.push({ nodeId: n.id, message: `Цикл ссылается на неизвестный узел «${b}».` });
      if (loopOf.has(b)) errors.push({ nodeId: b, message: 'Узел не может входить в два цикла.' });
      loopOf.set(b, n.id);
    }
  }
  for (const n of d.nodes) {
    if (n.type === 'loop' && loopOf.has(n.id)) errors.push({ nodeId: n.id, message: 'Вложенные циклы не поддерживаются.' });
    if (n.type === 'agent') {
      if (!n.agent) errors.push({ nodeId: n.id, message: 'Не выбран агент.' });
      else if (!known.agents.has(n.agent)) warnings.push({ nodeId: n.id, message: `Агент «${n.agent}» не найден в каталоге.` });
    }
    if (n.type === 'function' && !known.functions.has(n.fn)) errors.push({ nodeId: n.id, message: `Неизвестная функция «${n.fn}».` });
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) errors.push({ nodeId: n.id, message: `Зависимость от неизвестного узла «${dep}».` });
      else if (loopOf.get(dep) && loopOf.get(dep) !== loopOf.get(n.id)) errors.push({ nodeId: n.id, message: `Узел вне цикла не может зависеть от узла «${dep}» внутри цикла — укажите зависимость от самого цикла.` });
    }
    for (const p of referencedPaths([(n as AgentNode).input, n.when, (n as ApprovalNode).prompt, (n as LoopNode).until])) {
      const m = /^nodes\.([a-z0-9_]+)/.exec(p);
      if (m && !ids.has(m[1]!)) errors.push({ nodeId: n.id, message: `Ссылка на неизвестный узел «${m[1]}» в выражении ${p}.` });
    }
  }
  // dependency cycles (loops are expressed with loop nodes, never with back-edges)
  const deps = new Map(d.nodes.map((n) => [n.id, n.dependsOn ?? []]));
  const state = new Map<string, number>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 2) return;
    if (state.get(id) === 1) {
      errors.push({ nodeId: id, message: `Циклическая зависимость: ${[...path, id].join(' → ')}. Для повторов используйте узел «Цикл».` });
      return;
    }
    state.set(id, 1);
    for (const dep of deps.get(id) ?? []) if (deps.has(dep)) visit(dep, [...path, id]);
    state.set(id, 2);
  };
  for (const n of d.nodes) visit(n.id, []);
  if (!d.nodes.some((n) => n.type === 'agent' || n.type === 'function')) warnings.push({ nodeId: null, message: 'В процессе нет ни одного действия.' });
  return { ok: errors.length === 0, errors, warnings };
}

export function assertDefinition(def: unknown, known: { agents: Set<string>; functions: Set<string> }): WorkflowDefinition {
  const r = checkDefinition(def, known);
  if (!r.ok) throw new AppError('WORKFLOW_INVALID', r.errors.map((e) => (e.nodeId ? `${e.nodeId}: ${e.message}` : e.message)).join('; '), { details: r });
  return def as WorkflowDefinition;
}

/** Topological order (dependencies first); definitions are validated to be acyclic. */
export function topoOrder(def: WorkflowDefinition): WorkflowNode[] {
  const byId = new Map(def.nodes.map((n) => [n.id, n]));
  const done = new Set<string>();
  const out: WorkflowNode[] = [];
  const visit = (n: WorkflowNode) => {
    if (done.has(n.id)) return;
    done.add(n.id);
    for (const d of n.dependsOn ?? []) {
      const dn = byId.get(d);
      if (dn) visit(dn);
    }
    out.push(n);
  };
  for (const n of def.nodes) visit(n);
  return out;
}
