/**
 * Search query language (subset of Obsidian search, see docs/research/product-landscape.md §2.5):
 *   words (AND), "exact phrase", OR, -negation, (groups),
 *   operators: content: title: file: path: tag: type: status: project: source: linksto: linkedfrom:
 *              task: task-todo: task-done: updated: created:
 *   properties: [prop] [prop:value] [prop:null] [prop:>5] [prop:<2026-01-01]
 */
export type QueryNode =
  | { kind: 'and'; items: QueryNode[] }
  | { kind: 'or'; items: QueryNode[] }
  | { kind: 'not'; item: QueryNode }
  | { kind: 'text'; value: string; phrase: boolean; field: 'all' | 'body' | 'title' }
  | { kind: 'op'; op: string; value: string }
  | { kind: 'prop'; key: string; value: string | null; cmp: '=' | '>' | '<' | 'exists' | 'null' };

type Token =
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'or' }
  | { t: 'neg' }
  | { t: 'phrase'; v: string }
  | { t: 'word'; v: string }
  | { t: 'op'; op: string; v: string }
  | { t: 'prop'; v: string };

export const OPERATORS = ['content', 'title', 'file', 'path', 'tag', 'type', 'status', 'project', 'source', 'linksto', 'linkedfrom', 'task', 'task-todo', 'task-done', 'updated', 'created'];

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const readPhrase = (): string => {
    // assumes input[i] === '"'
    i++;
    let out = '';
    while (i < input.length && input[i] !== '"') {
      if (input[i] === '\\' && input[i + 1] === '"') {
        out += '"';
        i += 2;
        continue;
      }
      out += input[i++];
    }
    i++; // closing quote
    return out;
  };
  while (i < input.length) {
    const c = input[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (c === '-' && i + 1 < input.length && !/\s/.test(input[i + 1]!)) {
      tokens.push({ t: 'neg' });
      i++;
      continue;
    }
    if (c === '"') {
      tokens.push({ t: 'phrase', v: readPhrase() });
      continue;
    }
    if (c === '[') {
      const end = input.indexOf(']', i);
      const v = input.slice(i + 1, end === -1 ? input.length : end);
      tokens.push({ t: 'prop', v });
      i = end === -1 ? input.length : end + 1;
      continue;
    }
    let j = i;
    while (j < input.length && !/[\s()"]/.test(input[j]!)) j++;
    const word = input.slice(i, j);
    i = j;
    const colon = word.indexOf(':');
    if (colon > 0) {
      const op = word.slice(0, colon).toLowerCase();
      if (OPERATORS.includes(op)) {
        let v = word.slice(colon + 1);
        if (!v && input[i] === '"') v = readPhrase();
        tokens.push({ t: 'op', op, v });
        continue;
      }
    }
    if (word === 'OR') tokens.push({ t: 'or' });
    else if (word) tokens.push({ t: 'word', v: word });
  }
  return tokens;
}

export function parseQuery(input: string): QueryNode {
  const tokens = tokenize(input);
  let pos = 0;
  const parseOr = (): QueryNode => {
    const items: QueryNode[] = [parseAnd()];
    while (tokens[pos]?.t === 'or') {
      pos++;
      items.push(parseAnd());
    }
    return items.length === 1 ? items[0]! : { kind: 'or', items };
  };
  const parseAnd = (): QueryNode => {
    const items: QueryNode[] = [];
    while (pos < tokens.length && tokens[pos]!.t !== 'or' && tokens[pos]!.t !== 'rparen') {
      const n = parseUnary();
      if (n) items.push(n);
    }
    return items.length === 1 ? items[0]! : { kind: 'and', items };
  };
  const parseUnary = (): QueryNode | null => {
    const tok = tokens[pos];
    if (!tok) return null;
    if (tok.t === 'neg') {
      pos++;
      const inner = parseUnary();
      return inner ? { kind: 'not', item: inner } : null;
    }
    pos++;
    switch (tok.t) {
      case 'lparen': {
        const inner = parseOr();
        if (tokens[pos]?.t === 'rparen') pos++;
        return inner;
      }
      case 'phrase':
        return tok.v.trim() ? { kind: 'text', value: tok.v, phrase: true, field: 'all' } : null;
      case 'word':
        return { kind: 'text', value: tok.v, phrase: false, field: 'all' };
      case 'op':
        if (tok.op === 'content' || tok.op === 'title') return tok.v ? { kind: 'text', value: tok.v, phrase: tok.v.includes(' '), field: tok.op === 'content' ? 'body' : 'title' } : null;
        return { kind: 'op', op: tok.op, value: tok.v };
      case 'prop': {
        const colon = tok.v.indexOf(':');
        if (colon === -1) return { kind: 'prop', key: tok.v.trim(), value: null, cmp: 'exists' };
        const key = tok.v.slice(0, colon).trim();
        let value = tok.v.slice(colon + 1).trim().replace(/^"|"$/g, '');
        if (value === 'null') return { kind: 'prop', key, value: null, cmp: 'null' };
        let cmp: '=' | '>' | '<' = '=';
        if (value.startsWith('>') || value.startsWith('<')) {
          cmp = value[0] as '>' | '<';
          value = value.slice(1).trim();
        }
        return { kind: 'prop', key, value, cmp };
      }
      default:
        return null;
    }
  };
  const root = parseOr();
  return root;
}

/** Escapes a term for FTS5: always a quoted string; words get a prefix star (so "session" also matches "sessions"). */
export function ftsTerm(value: string, phrase: boolean): string {
  const clean = value.replace(/"/g, ' ').trim();
  if (!clean) return '';
  if (phrase) return `"${clean}"`;
  return clean.length >= 3 ? `"${clean}"*` : `"${clean}"`;
}

/** Positive text terms in AND position — used for ranking (bm25) and snippets. */
export function positiveTextTerms(node: QueryNode): { value: string; phrase: boolean; field: 'all' | 'body' | 'title' }[] {
  if (node.kind === 'text') return [node];
  if (node.kind === 'and') return node.items.flatMap(positiveTextTerms);
  if (node.kind === 'or') {
    const all = node.items.flatMap(positiveTextTerms);
    return all;
  }
  return [];
}

export function isEmptyQuery(node: QueryNode): boolean {
  return (node.kind === 'and' || node.kind === 'or') && node.items.length === 0;
}
