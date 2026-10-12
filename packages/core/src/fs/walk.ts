import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ignore } from 'ignore';
import { createGitignore, IgnoreRules, type SkipReason } from './ignore-rules.ts';
import { throwIfAborted } from '../util/errors.ts';

export interface WalkEntry {
  relPath: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  skip: SkipReason | null;
}

export interface WalkOptions {
  rules: IgnoreRules;
  maxFileBytes: number;
  signal?: AbortSignal;
  /** Report files skipped by directory rules too (e.g. for the connect preview). Off by default: node_modules can be huge. */
  reportSkippedDirs?: boolean;
  maxEntries?: number;
}

interface GitignoreLayer {
  base: string; // rel dir of the .gitignore ('' for root)
  matcher: Ignore;
}

/**
 * Walks a source root yielding every candidate file with a skip reason (or null when it should be indexed).
 * Symlinked directories are not followed (prevents escaping the root and cycles); symlinked files are skipped.
 */
export async function* walkSource(root: string, opts: WalkOptions): AsyncGenerator<WalkEntry> {
  let count = 0;
  async function* walkDir(relDir: string, layers: GitignoreLayer[]): AsyncGenerator<WalkEntry> {
    throwIfAborted(opts.signal);
    const absDir = relDir ? join(root, relDir) : root;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    let current = layers;
    if (opts.rules.respectGitignore && entries.some((e) => e.isFile() && e.name === '.gitignore')) {
      try {
        const content = await readFile(join(absDir, '.gitignore'), 'utf8');
        current = [...layers, { base: relDir, matcher: createGitignore(content) }];
      } catch {
        // unreadable .gitignore: ignore it
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (opts.maxEntries !== undefined && count >= opts.maxEntries) return;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        const dirSkip = opts.rules.isExcludedDir(entry.name, rel) ?? (gitignored(current, rel, true) ? 'gitignore' : null);
        if (dirSkip) {
          if (opts.reportSkippedDirs) {
            count++;
            yield { relPath: rel + '/', absPath: join(root, rel), size: 0, mtimeMs: 0, skip: dirSkip };
          }
          continue;
        }
        yield* walkDir(rel, current);
        continue;
      }
      if (!entry.isFile()) continue;
      const abs = join(root, rel);
      let st;
      try {
        st = await stat(abs);
      } catch {
        count++;
        yield { relPath: rel, absPath: abs, size: 0, mtimeMs: 0, skip: 'unreadable' };
        continue;
      }
      let skip: SkipReason | null = opts.rules.checkFile(rel);
      if (!skip && gitignored(current, rel, false)) skip = 'gitignore';
      if (!skip && st.size > opts.maxFileBytes) skip = 'too-large';
      count++;
      yield { relPath: rel, absPath: abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), skip };
    }
  }
  yield* walkDir('', []);
}

function gitignored(layers: GitignoreLayer[], rel: string, isDir: boolean): boolean {
  for (const layer of layers) {
    const local = layer.base ? rel.slice(layer.base.length + 1) : rel;
    if (!local) continue;
    if (layer.matcher.ignores(isDir ? local + '/' : local)) return true;
  }
  return false;
}
