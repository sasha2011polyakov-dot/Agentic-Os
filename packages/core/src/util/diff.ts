/**
 * Line diff (Myers O(ND)) with unified-diff output. Used to show proposed change sets before they are
 * applied and to export them as a patch file.
 */
export type DiffOp = { kind: 'equal' | 'add' | 'remove'; line: string };

/** Beyond this many changed lines the diff is shown as a full replacement (bounds memory to a few MB). */
const MAX_EDIT_DISTANCE = 1500;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(a: string, b: string): DiffOp[] {
  const A = splitLines(a);
  const B = splitLines(b);
  // Trim common prefix/suffix: keeps the search small for typical edits.
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }
  const head: DiffOp[] = A.slice(0, start).map((line) => ({ kind: 'equal', line }));
  const tail: DiffOp[] = A.slice(endA).map((line) => ({ kind: 'equal', line }));
  const a2 = A.slice(start, endA);
  const b2 = B.slice(start, endB);
  return [...head, ...myers(a2, b2), ...tail];
}

function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ kind: 'add', line }));
  if (m === 0) return a.map((line) => ({ kind: 'remove', line }));
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = false;
  for (let d = 0; d <= max && !found; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = true;
        break;
      }
    }
  }
  if (!found) {
    // Too different to diff cheaply: show as full replacement.
    return [...a.map((line) => ({ kind: 'remove' as const, line })), ...b.map((line) => ({ kind: 'add' as const, line }))];
  }
  trace.push(v.slice());
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 2; d >= 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!)) prevK = k + 1;
    else prevK = k - 1;
    const prevX = d === 0 ? 0 : vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: 'equal', line: a[x - 1]! });
      x--;
      y--;
    }
    if (d === 0) break;
    if (x === prevX) ops.push({ kind: 'add', line: b[y - 1]! });
    else ops.push({ kind: 'remove', line: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: 'equal', line: a[x - 1]! });
    x--;
    y--;
  }
  return ops.reverse();
}

export interface DiffStats {
  added: number;
  removed: number;
}

export function diffStats(ops: DiffOp[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.kind === 'add') added++;
    else if (o.kind === 'remove') removed++;
  }
  return { added, removed };
}

/** Unified diff (git-compatible headers) for one file. */
export function unifiedDiff(oldText: string | null, newText: string | null, path: string, context = 3): string {
  const ops = diffLines(oldText ?? '', newText ?? '');
  const from = oldText === null ? '/dev/null' : `a/${path}`;
  const to = newText === null ? '/dev/null' : `b/${path}`;
  const out: string[] = [`--- ${from}`, `+++ ${to}`];
  // positions of changed ops
  const changed: number[] = [];
  ops.forEach((o, i) => {
    if (o.kind !== 'equal') changed.push(i);
  });
  if (!changed.length) return '';
  let i = 0;
  while (i < changed.length) {
    const startIdx = Math.max(0, changed[i]! - context);
    let endIdx = Math.min(ops.length - 1, changed[i]! + context);
    let j = i + 1;
    while (j < changed.length && changed[j]! - context <= endIdx + 1) {
      endIdx = Math.min(ops.length - 1, changed[j]! + context);
      j++;
    }
    // compute line numbers at startIdx
    let oldLine = 1;
    let newLine = 1;
    for (let k = 0; k < startIdx; k++) {
      const o = ops[k]!;
      if (o.kind !== 'add') oldLine++;
      if (o.kind !== 'remove') newLine++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let k = startIdx; k <= endIdx; k++) {
      const o = ops[k]!;
      if (o.kind === 'equal') {
        body.push(` ${o.line}`);
        oldCount++;
        newCount++;
      } else if (o.kind === 'remove') {
        body.push(`-${o.line}`);
        oldCount++;
      } else {
        body.push(`+${o.line}`);
        newCount++;
      }
    }
    const oldStart = oldCount === 0 ? oldLine - 1 : oldLine;
    const newStart = newCount === 0 ? newLine - 1 : newLine;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`, ...body);
    i = j;
  }
  return `${out.join('\n')}\n`;
}
