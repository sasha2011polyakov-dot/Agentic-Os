import { Ajv, type ErrorObject, type ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';

// ajv-formats ships CJS with a default export; normalize for ESM interop.
const addFormats = ((addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport) as (ajv: Ajv) => Ajv;

const OPTIONS = { allErrors: true, strict: false, allowUnionTypes: true } as const;

/** JSON Schema 2020-12 validator (default dialect of agent packages). */
export function createAjv(): Ajv {
  const ajv = new Ajv2020(OPTIONS) as unknown as Ajv;
  addFormats(ajv);
  return ajv;
}

function createDraft07(): Ajv {
  const ajv = new Ajv(OPTIONS);
  addFormats(ajv);
  return ajv;
}

const shared2020 = createAjv();
const shared07 = createDraft07();
const cache = new WeakMap<object, ValidateFunction>();

/** Packages may declare draft-07 or 2020-12 via $schema; schemas without $schema are treated as 2020-12. */
export function validator(schema: Record<string, unknown>): ValidateFunction {
  let v = cache.get(schema);
  if (!v) {
    const dialect = typeof schema.$schema === 'string' ? schema.$schema : '';
    v = /draft-0[4-7]/.test(dialect) ? shared07.compile(schema) : shared2020.compile(schema);
    cache.set(schema, v);
  }
  return v;
}

export function formatErrors(errors: ErrorObject[] | null | undefined, max = 12): string[] {
  return (errors ?? []).slice(0, max).map((e) => {
    const where = e.instancePath || '(root)';
    if (e.keyword === 'required') return `${where}: the required field "${(e.params as { missingProperty: string }).missingProperty}" is missing`;
    if (e.keyword === 'enum') return `${where}: allowed values are ${(e.params as { allowedValues: unknown[] }).allowedValues.join(', ')}`;
    if (e.keyword === 'additionalProperties') return `${where}: unexpected field "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    return `${where}: ${e.message ?? e.keyword}`;
  });
}
