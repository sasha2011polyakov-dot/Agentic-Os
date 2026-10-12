import { basename, extname } from 'node:path';

export type FileKind = 'markdown' | 'text' | 'code' | 'json' | 'yaml' | 'toml' | 'csv' | 'html' | 'image' | 'pdf' | 'office' | 'binary' | 'other';

const EXT_KIND: Record<string, FileKind> = {
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.txt': 'text', '.rst': 'text', '.adoc': 'text', '.org': 'text', '.tex': 'text',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.yml': 'yaml', '.yaml': 'yaml',
  '.toml': 'toml',
  '.csv': 'csv', '.tsv': 'csv',
  '.html': 'html', '.htm': 'html', '.xhtml': 'html',
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image', '.svg': 'image', '.bmp': 'image', '.ico': 'image', '.avif': 'image',
  '.pdf': 'pdf',
  '.docx': 'office', '.doc': 'office', '.xlsx': 'office', '.xls': 'office', '.pptx': 'office', '.odt': 'office',
};

const CODE_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.cs': 'csharp', '.fs': 'fsharp', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.hh': 'cpp',
  '.rb': 'ruby', '.php': 'php', '.swift': 'swift', '.m': 'objc', '.dart': 'dart', '.lua': 'lua', '.r': 'r',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.ps1': 'powershell',
  '.sql': 'sql', '.graphql': 'graphql', '.proto': 'protobuf',
  '.vue': 'vue', '.svelte': 'svelte', '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.gradle': 'gradle', '.tf': 'terraform', '.xml': 'xml', '.ini': 'ini', '.cfg': 'ini', '.conf': 'ini',
};

const NAMED_FILES: Record<string, { kind: FileKind; language?: string }> = {
  dockerfile: { kind: 'code', language: 'dockerfile' },
  makefile: { kind: 'code', language: 'make' },
  readme: { kind: 'text' },
  license: { kind: 'text' },
  changelog: { kind: 'text' },
  contributing: { kind: 'text' },
  '.gitignore': { kind: 'text' },
  '.editorconfig': { kind: 'text' },
  '.env.example': { kind: 'text' },
};

export function classifyFile(relPath: string): { kind: FileKind; language?: string } {
  const name = basename(relPath).toLowerCase();
  const named = NAMED_FILES[name];
  if (named) return named;
  const ext = extname(name);
  const lang = CODE_LANG[ext];
  if (lang) return { kind: 'code', language: lang };
  const kind = EXT_KIND[ext];
  if (kind) return { kind };
  return { kind: 'other' };
}

/** Kinds whose content we parse into documents. */
export function isTextKind(kind: FileKind): boolean {
  return kind === 'markdown' || kind === 'text' || kind === 'code' || kind === 'json' || kind === 'yaml' || kind === 'toml' || kind === 'csv' || kind === 'html';
}

export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export const ATTACHMENT_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif',
  // SVG can carry scripts: served as text/plain so it never executes in the app origin.
  '.svg': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};
