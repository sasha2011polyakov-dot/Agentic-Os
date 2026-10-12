import { basename } from 'node:path';
import { parseMarkdown, type ParsedLink, type ParsedHeading, type ParsedTask } from '../markdown/parse.ts';
import type { FileKind } from '../fs/file-kinds.ts';
import { htmlToText } from '../research/extract.ts';

export interface OutlineSymbol {
  kind: 'class' | 'function' | 'interface' | 'type' | 'const' | 'struct' | 'enum' | 'trait' | 'method' | 'module' | 'section' | 'key';
  name: string;
  line: number;
}

/** Common shape every parser returns; the indexer only depends on this. */
export interface ParsedDocument {
  title: string;
  frontmatter: Record<string, unknown>;
  frontmatterError: string | null;
  aliases: string[];
  headings: ParsedHeading[];
  links: ParsedLink[];
  tags: { tag: string; display: string }[];
  tasks: ParsedTask[];
  blockIds: string[];
  outline: OutlineSymbol[];
  wordCount: number;
  searchText: string;
  docType: string | null;
  warnings: string[];
}

function baseTitle(relPath: string): string {
  return basename(relPath).replace(/\.[^.]+$/, '') || basename(relPath);
}

function plain(relPath: string, text: string, extra: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    title: baseTitle(relPath),
    frontmatter: {},
    frontmatterError: null,
    aliases: [],
    headings: [],
    links: [],
    tags: [],
    tasks: [],
    blockIds: [],
    outline: [],
    wordCount: text.split(/\s+/).filter(Boolean).length,
    searchText: text,
    docType: null,
    warnings: [],
    ...extra,
  };
}

const CODE_PATTERNS: Record<string, { re: RegExp; kind: OutlineSymbol['kind'] }[]> = {
  typescript: [
    { re: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
    { re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/, kind: 'type' },
    { re: /^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, kind: 'enum' },
    { re: /^\s*export\s+const\s+([A-Za-z_$][\w$]*)/, kind: 'const' },
    { re: /^\s*(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
  ],
  python: [
    { re: /^class\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s+(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: 'method' },
  ],
  go: [
    { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^type\s+([A-Za-z_]\w*)\s+struct/, kind: 'struct' },
    { re: /^type\s+([A-Za-z_]\w*)\s+interface/, kind: 'interface' },
  ],
  rust: [
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: 'function' },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+([A-Za-z_]\w*)/, kind: 'struct' },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+([A-Za-z_]\w*)/, kind: 'enum' },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?trait\s+([A-Za-z_]\w*)/, kind: 'trait' },
    { re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)/, kind: 'module' },
  ],
  java: [
    { re: /^\s*(?:public|protected|private)?\s*(?:abstract\s+|final\s+|static\s+)*(?:class|record)\s+([A-Za-z_]\w*)/, kind: 'class' },
    { re: /^\s*(?:public|protected|private)?\s*interface\s+([A-Za-z_]\w*)/, kind: 'interface' },
    { re: /^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[\w<>[\],\s]+\s+([a-zA-Z_]\w*)\s*\(/, kind: 'method' },
  ],
};
CODE_PATTERNS.javascript = CODE_PATTERNS.typescript!;
CODE_PATTERNS.kotlin = [
  { re: /^\s*(?:data\s+|sealed\s+|abstract\s+|open\s+)*class\s+([A-Za-z_]\w*)/, kind: 'class' },
  { re: /^\s*(?:private\s+|public\s+|internal\s+)?(?:suspend\s+)?fun\s+(?:<[^>]+>\s*)?([A-Za-z_]\w*)/, kind: 'function' },
];
CODE_PATTERNS.csharp = CODE_PATTERNS.java!;

/** Regex-based symbol outline. Limitation (documented): no nesting awareness, macros or generated code. */
export function codeOutline(text: string, language: string | undefined): OutlineSymbol[] {
  const patterns = language ? CODE_PATTERNS[language] : undefined;
  if (!patterns) return [];
  const out: OutlineSymbol[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < 500; i++) {
    for (const p of patterns) {
      const m = p.re.exec(lines[i]!);
      if (m?.[1]) {
        out.push({ kind: p.kind, name: m[1], line: i });
        break;
      }
    }
  }
  return out;
}

function topLevelKeys(obj: unknown): OutlineSymbol[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
  return Object.keys(obj as object)
    .slice(0, 200)
    .map((k) => ({ kind: 'key' as const, name: k, line: 0 }));
}

/** Requirement-like IDs mentioned in code/text (e.g. REQ-001, REQ-AUTH-12) — used for traceability edges. */
export function findRequirementIds(text: string): string[] {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\b(REQ(?:-[A-Z0-9]+)*-\d{1,5})\b/g)) ids.add(m[1]!);
  return [...ids];
}

export function parseFile(relPath: string, kind: FileKind, text: string, language?: string): ParsedDocument {
  switch (kind) {
    case 'markdown': {
      const md = parseMarkdown(text, basename(relPath));
      const fmType = typeof md.frontmatter.type === 'string' ? md.frontmatter.type.trim().toLowerCase() : null;
      return {
        title: md.title ?? baseTitle(relPath),
        frontmatter: md.frontmatter,
        frontmatterError: md.frontmatterError,
        aliases: md.aliases,
        headings: md.headings,
        links: md.links,
        tags: md.tags,
        tasks: md.tasks,
        blockIds: md.blockIds,
        outline: md.headings.map((h) => ({ kind: 'section' as const, name: h.text, line: h.line })),
        wordCount: md.wordCount,
        searchText: md.searchText,
        docType: fmType ?? inferDocType(relPath),
        warnings: md.frontmatterError ? [`Ошибка в свойствах (YAML): ${md.frontmatterError}`] : [],
      };
    }
    case 'code':
      return plain(relPath, text, { outline: codeOutline(text, language), docType: inferDocType(relPath) === 'test' ? 'test' : 'code' });
    case 'json': {
      let outline: OutlineSymbol[] = [];
      const warnings: string[] = [];
      try {
        outline = topLevelKeys(JSON.parse(text.replace(/^﻿/, '')));
      } catch {
        if (!relPath.endsWith('.jsonc') && !relPath.endsWith('.json5')) warnings.push('JSON не разобран: файл проиндексирован как текст.');
      }
      return plain(relPath, text, { outline, docType: inferDocType(relPath) ?? 'config', warnings });
    }
    case 'yaml':
    case 'toml': {
      const keys = [...text.matchAll(/^([A-Za-z_][\w.-]*)\s*[:=]/gm)].slice(0, 200).map((m) => ({ kind: 'key' as const, name: m[1]!, line: 0 }));
      const sections = kind === 'toml' ? [...text.matchAll(/^\[([^\]]+)\]/gm)].map((m) => ({ kind: 'section' as const, name: m[1]!, line: 0 })) : [];
      return plain(relPath, text, { outline: [...sections, ...keys], docType: 'config' });
    }
    case 'csv': {
      const header = text.split(/\r?\n/, 1)[0] ?? '';
      const sep = header.includes('\t') ? '\t' : header.includes(';') && !header.includes(',') ? ';' : ',';
      return plain(relPath, text, { outline: header.split(sep).slice(0, 100).map((c) => ({ kind: 'key' as const, name: c.trim().replace(/^"|"$/g, ''), line: 0 })), docType: 'data' });
    }
    case 'html': {
      const { text: extracted, title } = htmlToText(text);
      return plain(relPath, extracted, { title: title ?? baseTitle(relPath), docType: 'web' });
    }
    default:
      return plain(relPath, text, { docType: inferDocType(relPath) });
  }
}

/** Heuristic document type from the path when no `type:` property is present. */
export function inferDocType(relPath: string): string | null {
  const p = relPath.toLowerCase();
  const name = basename(p);
  if (/^readme(\.|$)/.test(name)) return 'readme';
  if (/(^|\/)(adr|decisions?)\//.test(p)) return 'decision';
  if (/(^|\/)(requirements?|reqs?)\//.test(p)) return 'requirement';
  if (/(^|\/)(specs?|тз)\//.test(p)) return 'spec';
  if (/(^|\/)daily\//.test(p) && /\d{4}-\d{2}-\d{2}/.test(name)) return 'daily';
  if (/(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(name) || /_test\.[a-z]+$/.test(name)) return 'test';
  if (/(^|\/)docs?\//.test(p)) return 'document';
  return null;
}
