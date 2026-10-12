import { sha256 } from '../util/hash.ts';
import type { ParsedDocument } from '../parsers/index.ts';

export interface Chunk {
  ord: number;
  headingPath: string;
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
}

const MAX = 1500;
const WINDOW = 1200;
const OVERLAP = 150;

/**
 * Splits a document into retrieval chunks: Markdown by sections (heading path kept for context), long
 * sections and other files by line windows of ~1200 chars with overlap. Hashes let unchanged chunks keep
 * their embeddings across edits.
 */
export function chunkDocument(text: string, parsed: ParsedDocument, isMarkdown: boolean, bodyStartLine = 0): Chunk[] {
  const lines = text.split('\n');
  const sections: { headingPath: string; start: number; end: number }[] = [];
  if (isMarkdown && parsed.headings.length) {
    const path: string[] = [];
    let start = bodyStartLine;
    let current = '';
    for (const h of parsed.headings) {
      if (h.line > start) sections.push({ headingPath: current, start, end: h.line - 1 });
      path.length = Math.max(0, h.level - 1);
      path[h.level - 1] = h.text;
      current = path.filter(Boolean).join(' › ');
      start = h.line;
    }
    sections.push({ headingPath: current, start, end: lines.length - 1 });
  } else {
    sections.push({ headingPath: '', start: bodyStartLine, end: lines.length - 1 });
  }
  const chunks: Chunk[] = [];
  for (const s of sections) {
    const sectionText = lines.slice(s.start, s.end + 1).join('\n').trim();
    if (!sectionText) continue;
    if (sectionText.length <= MAX) {
      chunks.push(make(chunks.length, s.headingPath, s.start, s.end, sectionText));
      continue;
    }
    // line windows
    let winStart = s.start;
    while (winStart <= s.end) {
      let len = 0;
      let winEnd = winStart;
      while (winEnd <= s.end && len + (lines[winEnd]?.length ?? 0) + 1 <= WINDOW) {
        len += (lines[winEnd]?.length ?? 0) + 1;
        winEnd++;
      }
      if (winEnd === winStart) winEnd = winStart + 1; // a single very long line
      const body = lines.slice(winStart, winEnd).join('\n').trim();
      if (body) chunks.push(make(chunks.length, s.headingPath, winStart, winEnd - 1, body.slice(0, MAX * 2)));
      if (winEnd > s.end) break;
      // step back to create overlap
      let back = 0;
      let next = winEnd;
      while (next > winStart + 1 && back < OVERLAP) {
        next--;
        back += (lines[next]?.length ?? 0) + 1;
      }
      winStart = Math.max(next, winStart + 1);
    }
  }
  return chunks.slice(0, 2000);
}

function make(ord: number, headingPath: string, start: number, end: number, text: string): Chunk {
  return { ord, headingPath, startLine: start, endLine: end, text, hash: sha256(`${headingPath}\n${text}`) };
}
