import { parse as parseYaml, parseDocument, stringify } from 'yaml';

export interface FrontmatterSplit {
  /** Raw YAML (or JSON) between the --- fences, or null when the document has none. */
  raw: string | null;
  body: string;
  /** 0-based line index where the body starts in the original text. */
  bodyStartLine: number;
}

const FENCE = /^---[ \t]*\r?\n/;

export function splitFrontmatter(text: string): FrontmatterSplit {
  const src = text.startsWith('﻿') ? text.slice(1) : text;
  if (!FENCE.test(src)) return { raw: null, body: src, bodyStartLine: 0 };
  const lines = src.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (/^(---|\.\.\.)[ \t]*$/.test(lines[i]!)) {
      return { raw: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n'), bodyStartLine: i + 1 };
    }
  }
  // Unterminated fence: treat as body (Obsidian behaves the same).
  return { raw: null, body: src, bodyStartLine: 0 };
}

export interface ParsedFrontmatter {
  data: Record<string, unknown>;
  error: string | null;
}

/** YAML is a superset of JSON, so JSON frontmatter (supported by Obsidian) parses too. */
export function parseFrontmatter(raw: string | null): ParsedFrontmatter {
  if (raw === null || raw.trim() === '') return { data: {}, error: null };
  try {
    const value = parseYaml(raw, { prettyErrors: true, uniqueKeys: false });
    if (value === null || value === undefined) return { data: {}, error: null };
    if (typeof value !== 'object' || Array.isArray(value)) return { data: {}, error: 'Frontmatter must be a set of "key: value" pairs.' };
    return { data: normalizeValues(value as Record<string, unknown>), error: null };
  } catch (e) {
    return { data: {}, error: e instanceof Error ? e.message.split('\n')[0]! : String(e) };
  }
}

function normalizeValues(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = normalizeValue(v);
  return out;
}

function normalizeValue(v: unknown): unknown {
  if (v instanceof Date) {
    // YAML timestamps: keep date-only values as YYYY-MM-DD (Obsidian "Date" type)
    const iso = v.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('.000Z', 'Z');
  }
  if (Array.isArray(v)) return v.map(normalizeValue);
  if (v && typeof v === 'object') return normalizeValues(v as Record<string, unknown>);
  return v;
}

/**
 * Applies a patch to the frontmatter while preserving key order, comments and unrelated keys.
 * `undefined` values delete keys. Creates a frontmatter block if there is none.
 */
export function updateFrontmatter(text: string, patch: Record<string, unknown>): string {
  const split = splitFrontmatter(text);
  const doc = parseDocument(split.raw ?? '');
  if (doc.contents === null || doc.errors.length > 0) {
    const data = { ...parseFrontmatter(split.raw).data };
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete data[k];
      else data[k] = v;
    }
    return composeDocument(data, split.body);
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) doc.delete(k);
    else doc.set(k, v);
  }
  const yamlText = doc.toString({ lineWidth: 0 }).trimEnd();
  if (!yamlText || yamlText === '{}') return split.body.replace(/^\n+/, '');
  return `---\n${yamlText}\n---\n${split.body}`;
}

export function composeDocument(data: Record<string, unknown>, body: string): string {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (keys.length === 0) return body;
  const clean: Record<string, unknown> = {};
  for (const k of keys) clean[k] = data[k];
  return `---\n${stringify(clean, { lineWidth: 0 }).trimEnd()}\n---\n${body}`;
}
