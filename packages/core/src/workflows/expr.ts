import { getPath } from '../util/json.ts';

/**
 * A tiny, side-effect-free mapping/condition language for workflow definitions (no eval, no code):
 * values are JSON where objects with a "$" operator are resolved against the run context.
 *
 *   { "$path": "nodes.researcher.output.evidence", "default": [] }
 *   { "$concat": [ <mapping>, <mapping> ] }                       — arrays concatenated, scalars appended
 *   { "$pluck": "nodes.review.output.defects", "field": "description", "where": { "field": "stage", "in": ["spec"] } }
 *   { "$count": "nodes.x.output.items", "where": { "field": "severity", "equals": "critical" } }
 *   { "$template": "Goal: {{input.goal}}" }
 *   { "$literal": { "$path": "not resolved" } }
 *
 * Conditions:
 *   { "path": "...", "equals" | "notEquals" | "in" | "gte" | "lte": ..., "truthy" | "empty" | "notEmpty" | "exists": true }
 *   { "path": "...", "some": { "field": "blocking", "equals": true } }
 *   { "all": [...] } · { "any": [...] } · { "not": {...} }
 */
export type Mapping = unknown;

export interface ItemFilter {
  field: string;
  equals?: unknown;
  in?: unknown[];
  notEquals?: unknown;
}

export interface Condition {
  path?: string;
  equals?: unknown;
  notEquals?: unknown;
  in?: unknown[];
  gte?: number;
  lte?: number;
  truthy?: boolean;
  empty?: boolean;
  notEmpty?: boolean;
  exists?: boolean;
  some?: ItemFilter;
  all?: Condition[];
  any?: Condition[];
  not?: Condition;
}

const OPERATORS = ['$path', '$concat', '$pluck', '$count', '$template', '$literal'] as const;

function matchItem(item: unknown, f: ItemFilter | undefined): boolean {
  if (!f) return true;
  const v = getPath(item, f.field);
  if ('equals' in f && v !== f.equals) return false;
  if ('notEquals' in f && v === f.notEquals) return false;
  if (f.in && !f.in.includes(v)) return false;
  return true;
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function resolveMapping(m: Mapping, ctx: unknown): unknown {
  if (Array.isArray(m)) return m.map((x) => resolveMapping(x, ctx));
  if (!m || typeof m !== 'object') return m;
  const o = m as Record<string, unknown>;
  const op = OPERATORS.find((k) => k in o);
  if (op === '$literal') return o.$literal;
  if (op === '$path') {
    const v = getPath(ctx, String(o.$path));
    return v === undefined ? (o.default !== undefined ? resolveMapping(o.default, ctx) : undefined) : v;
  }
  if (op === '$concat') {
    const out: unknown[] = [];
    for (const part of asArray(o.$concat)) {
      const v = resolveMapping(part, ctx);
      if (Array.isArray(v)) out.push(...v);
      else if (v !== undefined && v !== null && v !== '') out.push(v);
    }
    return out;
  }
  if (op === '$pluck') {
    const items = asArray(getPath(ctx, String(o.$pluck))).filter((i) => matchItem(i, o.where as ItemFilter | undefined));
    return o.field ? items.map((i) => getPath(i, String(o.field))).filter((x) => x !== undefined) : items;
  }
  if (op === '$count') {
    return asArray(getPath(ctx, String(o.$count))).filter((i) => matchItem(i, o.where as ItemFilter | undefined)).length;
  }
  if (op === '$template') {
    return String(o.$template).replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m, p: string) => {
      const v = getPath(ctx, p);
      return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const r = resolveMapping(v, ctx);
    if (r !== undefined) out[k] = r;
  }
  return out;
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v as object).length === 0;
  return false;
}

export function evaluate(c: Condition | undefined, ctx: unknown): boolean {
  if (!c) return true;
  if (c.all) return c.all.every((x) => evaluate(x, ctx));
  if (c.any) return c.any.some((x) => evaluate(x, ctx));
  if (c.not) return !evaluate(c.not, ctx);
  const v = c.path !== undefined ? getPath(ctx, c.path) : undefined;
  if ('equals' in c && v !== c.equals) return false;
  if ('notEquals' in c && v === c.notEquals) return false;
  if (c.in && !c.in.includes(v)) return false;
  if (c.gte !== undefined && !(typeof v === 'number' && v >= c.gte)) return false;
  if (c.lte !== undefined && !(typeof v === 'number' && v <= c.lte)) return false;
  if (c.truthy !== undefined && !!v !== c.truthy) return false;
  if (c.empty !== undefined && isEmpty(v) !== c.empty) return false;
  if (c.notEmpty !== undefined && !isEmpty(v) !== c.notEmpty) return false;
  if (c.exists !== undefined && (v !== undefined) !== c.exists) return false;
  if (c.some && !asArray(v).some((i) => matchItem(i, c.some))) return false;
  return true;
}

/** All context paths referenced by a mapping or condition (used by the definition validator). */
export function referencedPaths(x: unknown, out: string[] = []): string[] {
  if (Array.isArray(x)) {
    for (const i of x) referencedPaths(i, out);
    return out;
  }
  if (!x || typeof x !== 'object') return out;
  const o = x as Record<string, unknown>;
  if ('$literal' in o) return out;
  for (const k of ['$path', '$pluck', '$count', 'path']) if (typeof o[k] === 'string') out.push(o[k] as string);
  if (typeof o.$template === 'string') for (const m of (o.$template as string).matchAll(/\{\{\s*([\w.$-]+)\s*\}\}/g)) out.push(m[1]!);
  for (const [k, v] of Object.entries(o)) if (k !== '$path' && k !== 'path') referencedPaths(v, out);
  return out;
}
