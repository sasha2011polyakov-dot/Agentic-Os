import { parseFrontmatter, splitFrontmatter } from './frontmatter.ts';

export type LinkKind = 'wikilink' | 'markdown' | 'embed' | 'frontmatter';

export interface ParsedLink {
  kind: LinkKind;
  /** Graph relation; 'references' for plain links, typed for frontmatter keys like depends_on. */
  relation: string;
  raw: string;
  /** Link destination without #heading / #^block, decoded, as written (no extension stripping). */
  target: string;
  heading: string | null;
  blockId: string | null;
  alias: string | null;
  external: boolean;
  /** 0-based line and column in the full document text. */
  line: number;
  col: number;
  /** Character offsets of the whole link in the full text (for rewriting on rename). */
  start: number;
  end: number;
  /** Offsets of just the target part inside the full text (frontmatter links: -1). */
  targetStart: number;
  targetEnd: number;
}

export interface ParsedHeading {
  level: number;
  text: string;
  line: number;
}

export interface ParsedTask {
  line: number;
  text: string;
  done: boolean;
}

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  frontmatterError: string | null;
  bodyStartLine: number;
  title: string | null;
  headings: ParsedHeading[];
  links: ParsedLink[];
  tags: { tag: string; display: string }[];
  tasks: ParsedTask[];
  blockIds: string[];
  aliases: string[];
  wordCount: number;
  /** Body text for full-text search (frontmatter removed, markup kept minimal). */
  searchText: string;
}

/** Frontmatter keys that express typed relations (value: "[[Doc]]", "Doc" or a list of them). */
export const RELATION_KEYS: Record<string, string> = {
  depends_on: 'depends_on',
  dependencies: 'depends_on',
  implements: 'implements',
  verifies: 'verifies',
  tests: 'verifies',
  supersedes: 'supersedes',
  replaces: 'supersedes',
  conflicts_with: 'conflicts_with',
  part_of: 'part_of',
  parent: 'part_of',
  blocks: 'blocks',
  derived_from: 'derived_from',
  based_on: 'derived_from',
  source: 'uses_source',
  sources: 'uses_source',
  related: 'references',
  see_also: 'references',
};

/**
 * Replaces code (fenced + inline), %%comments%% and <!-- comments --> with spaces of equal length so
 * that link/tag regexes never match inside them while every offset and line number stays valid.
 */
export function maskNonContent(text: string): string {
  const chars = text.split('');
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  // fenced code blocks
  const lines = text.split('\n');
  let offset = 0;
  let fence: { marker: string; start: number } | null = null;
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1]![0] === fence.marker[0] && m[1]!.length >= fence.marker.length && line.trim() === m[1]) {
        blank(fence.start, offset + line.length);
        fence = null;
      }
    } else if (m) {
      fence = { marker: m[1]!, start: offset };
    }
    offset += line.length + 1;
  }
  if (fence) blank(fence.start, text.length);
  let masked = chars.join('');
  // inline code spans (same-length backtick runs)
  masked = masked.replace(/(`+)([^`\n]|[^`\n][\s\S]*?[^`\n])\1(?!`)/g, (m) => ' '.repeat(m.length));
  // Obsidian comments and HTML comments (may span lines)
  masked = masked.replace(/%%[\s\S]*?%%/g, (m) => m.replace(/[^\n]/g, ' '));
  masked = masked.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  return masked;
}

function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function position(starts: number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, col: offset - starts[lo]! };
}

function splitTargetSuffix(dest: string): { target: string; heading: string | null; blockId: string | null } {
  const hash = dest.indexOf('#');
  if (hash === -1) return { target: dest, heading: null, blockId: null };
  const target = dest.slice(0, hash);
  const rest = dest.slice(hash + 1);
  if (rest.startsWith('^')) return { target, heading: null, blockId: rest.slice(1) || null };
  // nested headings "H1#H2": keep the last one (most specific)
  const parts = rest.split('#').filter(Boolean);
  return { target, heading: parts.length ? parts[parts.length - 1]! : null, blockId: null };
}

const EXTERNAL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;
// Letters, digits, _ - / and common Unicode; must contain at least one non-digit (Obsidian rule).
const TAG_RE = /(^|[\s(,;:!?"'«»])#([\p{L}\p{N}_\-/\p{Extended_Pictographic}]+)/gu;

export function normalizeTag(tag: string): string {
  return tag.replace(/^#/, '').replace(/\/+$/, '').toLowerCase();
}

function isValidTag(tag: string): boolean {
  return tag.length > 0 && /[^\d/]/u.test(tag) && !/^\//.test(tag);
}

export function parseMarkdown(text: string, fileName?: string): ParsedMarkdown {
  const fm = splitFrontmatter(text);
  const { data, error } = parseFrontmatter(fm.raw);
  const full = text.startsWith('﻿') ? text.slice(1) : text;
  const starts = lineStarts(full);
  // Offset where the body begins in `full`
  const bodyOffset = fm.bodyStartLine === 0 ? 0 : (starts[fm.bodyStartLine] ?? full.length);
  const masked = maskNonContent(full);
  const bodyMasked = masked.slice(bodyOffset);

  const links: ParsedLink[] = [];
  // wikilinks and embeds
  const wiki = /(!?)\[\[([^[\]\n]+?)\]\]/g;
  for (let m: RegExpExecArray | null; (m = wiki.exec(bodyMasked)); ) {
    const isEmbed = m[1] === '!';
    const inner = m[2]!;
    const pipe = inner.indexOf('|');
    const dest = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const alias = pipe === -1 ? null : inner.slice(pipe + 1).trim() || null;
    const { target, heading, blockId } = splitTargetSuffix(dest);
    const start = bodyOffset + m.index;
    const innerStart = start + m[1]!.length + 2;
    const leading = (pipe === -1 ? inner : inner.slice(0, pipe)).length - (pipe === -1 ? inner : inner.slice(0, pipe)).trimStart().length;
    const pos = position(starts, start);
    links.push({
      kind: isEmbed ? 'embed' : 'wikilink',
      relation: 'references',
      raw: full.slice(start, start + m[0].length),
      target: target.trim(),
      heading,
      blockId,
      alias,
      external: false,
      line: pos.line,
      col: pos.col,
      start,
      end: start + m[0].length,
      targetStart: innerStart + leading,
      targetEnd: innerStart + leading + target.trim().length,
    });
  }
  // markdown links / images: [text](dest "title")
  const md = /(!?)\[((?:[^\]\n]|\\\])*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;
  for (let m: RegExpExecArray | null; (m = md.exec(bodyMasked)); ) {
    let dest = m[3]!;
    const angled = dest.startsWith('<');
    if (angled) dest = dest.slice(1, -1);
    const start = bodyOffset + m.index;
    const pos = position(starts, start);
    const external = EXTERNAL_SCHEME.test(dest) || dest.startsWith('//');
    let decoded = dest;
    try {
      decoded = decodeURIComponent(dest);
    } catch {
      // keep raw
    }
    const { target, heading, blockId } = external ? { target: dest, heading: null, blockId: null } : splitTargetSuffix(decoded);
    if (!external && target === '' && !heading && !blockId) continue;
    const parenIdx = m[0].indexOf('](') + 2;
    let ws = 0;
    while (/\s/.test(m[0][parenIdx + ws] ?? '')) ws++;
    const destOffsetInMatch = parenIdx + ws + (angled ? 1 : 0);
    links.push({
      kind: m[1] === '!' ? 'embed' : 'markdown',
      relation: 'references',
      raw: full.slice(start, start + m[0].length),
      target,
      heading,
      blockId,
      alias: m[2] || null,
      external,
      line: pos.line,
      col: pos.col,
      start,
      end: start + m[0].length,
      targetStart: start + destOffsetInMatch,
      targetEnd: start + destOffsetInMatch + dest.length,
    });
  }
  // typed relations and links inside frontmatter values
  for (const [key, value] of Object.entries(data)) {
    const relation = RELATION_KEYS[key.toLowerCase()];
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v !== 'string' || !v.trim()) continue;
      const wl = /^\s*\[\[([^[\]]+)\]\]\s*$/.exec(v);
      if (!relation && !wl) continue;
      const inner = wl ? wl[1]! : v.trim();
      const pipe = inner.indexOf('|');
      const { target, heading, blockId } = splitTargetSuffix(pipe === -1 ? inner : inner.slice(0, pipe));
      if (EXTERNAL_SCHEME.test(target)) continue;
      links.push({
        kind: 'frontmatter',
        relation: relation ?? 'references',
        raw: v,
        target: target.trim(),
        heading,
        blockId,
        alias: pipe === -1 ? null : inner.slice(pipe + 1),
        external: false,
        line: 0,
        col: 0,
        start: -1,
        end: -1,
        targetStart: -1,
        targetEnd: -1,
      });
    }
  }
  links.sort((a, b) => (a.start === -1 ? 1 : b.start === -1 ? -1 : a.start - b.start));

  // headings, tasks, block ids, tags — line based on the masked body
  const headings: ParsedHeading[] = [];
  const tasks: ParsedTask[] = [];
  const blockIds: string[] = [];
  const bodyLines = bodyMasked.split('\n');
  const originalBodyLines = full.slice(bodyOffset).split('\n');
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i]!;
    const orig = originalBodyLines[i] ?? line;
    const lineNo = fm.bodyStartLine + i;
    const h = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    if (h) headings.push({ level: h[1]!.length, text: stripInline(h[2]!), line: lineNo });
    const t = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/.exec(orig);
    if (t && line.trim() !== '') tasks.push({ line: lineNo, text: t[2]!.trim(), done: t[1] !== ' ' });
    const b = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line);
    if (b) blockIds.push(b[1]!);
  }

  const tagMap = new Map<string, string>();
  for (let m: RegExpExecArray | null; (m = TAG_RE.exec(bodyMasked)); ) {
    // skip headings ("# Title") — they need a space, so never match; skip URL fragments like page#section
    const display = m[2]!.replace(/\/+$/, '');
    if (!isValidTag(display)) continue;
    const key = normalizeTag(display);
    if (!tagMap.has(key)) tagMap.set(key, display);
  }
  const fmTags = data.tags ?? data.tag;
  const fmTagList = Array.isArray(fmTags) ? fmTags : typeof fmTags === 'string' ? fmTags.split(/[,\s]+/) : [];
  for (const t of fmTagList) {
    if (typeof t !== 'string') continue;
    const display = t.replace(/^#/, '').trim();
    if (!isValidTag(display)) continue;
    const key = normalizeTag(display);
    if (!tagMap.has(key)) tagMap.set(key, display);
  }

  const aliasesRaw = data.aliases ?? data.alias;
  const aliases = (Array.isArray(aliasesRaw) ? aliasesRaw : typeof aliasesRaw === 'string' ? [aliasesRaw] : [])
    .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    .map((a) => a.trim());

  const fmTitle = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
  const h1 = headings.find((h) => h.level === 1)?.text ?? null;
  const fallback = fileName ? fileName.replace(/\.[^.]+$/, '') : null;
  const searchText = full.slice(bodyOffset);
  const words = searchText.replace(/[#*_>`[\]()!|-]/g, ' ').split(/\s+/).filter(Boolean);

  return {
    frontmatter: data,
    frontmatterError: error,
    bodyStartLine: fm.bodyStartLine,
    title: fmTitle ?? h1 ?? fallback,
    headings,
    links,
    tags: [...tagMap].map(([tag, display]) => ({ tag, display })),
    tasks,
    blockIds,
    aliases,
    wordCount: words.length,
    searchText,
  };
}

function stripInline(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~=]/g, '')
    .trim();
}
