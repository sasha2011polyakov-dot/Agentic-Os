/**
 * Providers enforce different JSON Schema subsets in strict structured-output mode:
 *  - OpenAI strict: every object needs additionalProperties:false and ALL properties listed in `required`
 *    (optional fields are expressed as a union with null).
 *  - Anthropic: additionalProperties:false; minItems only 0/1; no numeric/string length constraints.
 * We send a relaxed, provider-compatible copy and ALWAYS validate the result locally with the full schema
 * (Ajv), so correctness never depends on the provider.
 */
const DROP_ALWAYS = new Set(['$schema', '$id', 'examples', 'default', 'title', '$comment']);
const DROP_ANTHROPIC = new Set(['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'maxItems', 'pattern', 'format', 'uniqueItems', 'minProperties', 'maxProperties']);
const DROP_OPENAI = new Set(['minLength', 'maxLength', 'uniqueItems', 'minProperties', 'maxProperties']);

export function toStrictSchema(schema: Record<string, unknown>, opts: { anthropic?: boolean } = {}): Record<string, unknown> {
  return convert(schema, opts) as Record<string, unknown>;
}

/**
 * Keywords whose value is a map from NAMES to schemas. Their keys are field or definition names, not keywords:
 * a field called "title", "format" or "default" must survive (dropping it removed required fields from the schema
 * sent to the provider, so the model never produced them and local validation then failed every time).
 */
const NAME_MAPS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

function convert(node: unknown, opts: { anthropic?: boolean }): unknown {
  if (Array.isArray(node)) return node.map((n) => convert(n, opts));
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (NAME_MAPS.has(k) && v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([name, sub]) => [name, convert(sub, opts)]));
      continue;
    }
    if (DROP_ALWAYS.has(k)) continue;
    if (opts.anthropic && DROP_ANTHROPIC.has(k)) continue;
    if (!opts.anthropic && DROP_OPENAI.has(k)) continue;
    if (k === 'minItems' && opts.anthropic) {
      out.minItems = Math.min(Number(v), 1);
      continue;
    }
    out[k] = convert(v, opts);
  }
  const isObject = out.type === 'object' || (Array.isArray(out.type) && (out.type as string[]).includes('object'));
  if (isObject && out.properties && typeof out.properties === 'object') {
    const props = out.properties as Record<string, unknown>;
    const required = new Set(Array.isArray(out.required) ? (out.required as string[]) : []);
    if (!opts.anthropic) {
      // OpenAI strict: every key required; optional ones become nullable
      for (const key of Object.keys(props)) {
        if (!required.has(key)) props[key] = makeNullable(props[key]);
      }
      out.required = Object.keys(props);
    }
    out.additionalProperties = false;
  } else if (isObject && !out.properties) {
    out.properties = {};
    out.additionalProperties = false;
    if (!opts.anthropic) out.required = [];
  }
  return out;
}

function makeNullable(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  const s = { ...(schema as Record<string, unknown>) };
  if (typeof s.type === 'string') s.type = [s.type, 'null'];
  else if (Array.isArray(s.type) && !s.type.includes('null')) s.type = [...s.type, 'null'];
  else if (!s.type && (s.anyOf || s.enum)) return { anyOf: [s, { type: 'null' }] };
  if (Array.isArray(s.enum) && !s.enum.includes(null)) s.enum = [...s.enum, null];
  return s;
}

/** Removes `null` values produced by strict mode for optional fields so local validation of the original schema passes. */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (v !== null) out[k] = stripNulls(v);
    return out;
  }
  return value;
}
