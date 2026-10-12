export type PropertyType = 'text' | 'list' | 'number' | 'checkbox' | 'date' | 'datetime' | 'tags' | 'object';

export interface PropertyValue {
  key: string;
  ord: number;
  type: PropertyType;
  text: string | null;
  num: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

export function inferType(key: string, value: unknown): PropertyType {
  if (key === 'tags' || key === 'tag') return 'tags';
  if (Array.isArray(value)) return 'list';
  if (typeof value === 'boolean') return 'checkbox';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'string') {
    if (DATE_RE.test(value)) return 'date';
    if (DATETIME_RE.test(value)) return 'datetime';
    return 'text';
  }
  if (value && typeof value === 'object') return 'object';
  return 'text';
}

/** Flattens frontmatter into rows for the doc_properties table (lists → one row per item). */
export function flattenProperties(data: Record<string, unknown>): PropertyValue[] {
  const out: PropertyValue[] = [];
  for (const [key, value] of Object.entries(data)) {
    const type = inferType(key, value);
    if (value === null || value === undefined) {
      out.push({ key, ord: 0, type, text: null, num: null });
      continue;
    }
    const items = Array.isArray(value) ? value : [value];
    items.forEach((item, ord) => {
      if (item === null || item === undefined) {
        out.push({ key, ord, type, text: null, num: null });
      } else if (typeof item === 'number') {
        out.push({ key, ord, type, text: String(item), num: item });
      } else if (typeof item === 'boolean') {
        out.push({ key, ord, type, text: item ? 'true' : 'false', num: item ? 1 : 0 });
      } else if (typeof item === 'object') {
        out.push({ key, ord, type, text: JSON.stringify(item), num: null });
      } else {
        const text = String(item).replace(/^#/, key === 'tags' ? '' : '#').replace(/^\[\[(.+)\]\]$/, '$1');
        const num = Number(text);
        out.push({ key, ord, type, text, num: text.trim() !== '' && Number.isFinite(num) ? num : null });
      }
    });
  }
  return out;
}
