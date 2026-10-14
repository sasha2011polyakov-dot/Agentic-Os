import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import { AppError } from '../util/errors.ts';
import { sha256 } from '../util/hash.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { SKIP_REASON_TEXT, type SkipReason } from '../fs/ignore-rules.ts';

export interface ProjectInventory {
  sourceId: string;
  name: string;
  rootPath: string;
  computedAt: string;
  totals: { files: number; indexed: number; skipped: number; errors: number; documents: number };
  languages: { language: string; files: number }[];
  topLevel: { path: string; files: number }[];
  manifests: { path: string; kind: string; summary: Record<string, unknown> }[];
  entryPoints: string[];
  tests: { count: number; sample: string[] };
  documentation: { path: string; title: string }[];
  keyFiles: string[];
  skipped: { reason: string; text: string; count: number; sample: string[] }[];
  limitations: string[];
}

const MANIFESTS: Record<string, string> = {
  'package.json': 'npm',
  'pyproject.toml': 'python',
  'requirements.txt': 'python',
  'setup.py': 'python',
  'cargo.toml': 'rust',
  'go.mod': 'go',
  'pom.xml': 'maven',
  'build.gradle': 'gradle',
  'build.gradle.kts': 'gradle',
  'composer.json': 'php',
  gemfile: 'ruby',
  dockerfile: 'docker',
  'docker-compose.yml': 'docker',
  makefile: 'make',
  'tsconfig.json': 'typescript',
};

const ENTRY_RE = /(^|\/)(main|index|app|server|cli|manage)\.(ts|tsx|js|mjs|py|go|rs|java|kt|rb|php)$|(^|\/)cmd\/[^/]+\/main\.go$|(^|\/)src\/main\.rs$|(^|\/)src\/lib\.rs$/i;

/**
 * Deterministic project inventory (no model call): what is in the project, what was read and what was not.
 * Cached per source and invalidated by the hash of the indexed file list.
 */
export async function projectInventory(rt: SystemRuntime, sourceId: string): Promise<ProjectInventory> {
  const src = rt.db.get<{ id: string; name: string; root_path: string; kind: string }>('SELECT id, name, root_path, kind FROM sources WHERE id = ?', sourceId);
  if (!src) throw new AppError('NOT_FOUND', 'Source not found.');
  const files = rt.db.all<{ rel_path: string; kind: string; language: string | null; status: string; skip_reason: string | null; hash: string | null; error: string | null }>(
    'SELECT rel_path, kind, language, status, skip_reason, hash, error FROM files WHERE source_id = ? ORDER BY rel_path',
    sourceId,
  );
  const filesHash = sha256(files.map((f) => `${f.rel_path}:${f.hash ?? f.skip_reason ?? ''}`).join('\n'));
  const cached = rt.db.get<{ profile: string; files_hash: string }>('SELECT profile, files_hash FROM project_profiles WHERE source_id = ?', sourceId);
  if (cached && cached.files_hash === filesHash) return parseJson<ProjectInventory>(cached.profile, null as unknown as ProjectInventory);

  const langs = new Map<string, number>();
  const top = new Map<string, number>();
  const skipped = new Map<string, string[]>();
  const tests: string[] = [];
  let indexed = 0;
  let errors = 0;
  for (const f of files) {
    const first = f.rel_path.includes('/') ? f.rel_path.slice(0, f.rel_path.indexOf('/')) : '(root)';
    top.set(first, (top.get(first) ?? 0) + 1);
    if (f.status === 'indexed') {
      indexed++;
      const lang = f.language ?? (f.kind === 'code' ? 'code' : f.kind);
      langs.set(lang, (langs.get(lang) ?? 0) + 1);
      if (/(^|\/)(tests?|__tests__|spec)\//i.test(f.rel_path) || /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$/i.test(f.rel_path)) tests.push(f.rel_path);
    } else if (f.status === 'skipped') {
      const list = skipped.get(f.skip_reason ?? 'unknown') ?? [];
      list.push(f.rel_path);
      skipped.set(f.skip_reason ?? 'unknown', list);
    } else errors++;
  }
  const manifests: ProjectInventory['manifests'] = [];
  for (const f of files) {
    const name = f.rel_path.split('/').pop()!.toLowerCase();
    const kind = MANIFESTS[name];
    if (!kind || f.rel_path.split('/').length > 3) continue;
    const summary: Record<string, unknown> = {};
    if (name === 'package.json' && f.status === 'indexed') {
      try {
        const pkg = JSON.parse(await readFile(join(src.root_path, f.rel_path), 'utf8')) as { name?: string; version?: string; main?: string; bin?: unknown; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        Object.assign(summary, { name: pkg.name, version: pkg.version, main: pkg.main, scripts: Object.keys(pkg.scripts ?? {}), dependencies: Object.keys(pkg.dependencies ?? {}).slice(0, 40), devDependencies: Object.keys(pkg.devDependencies ?? {}).length });
      } catch {
        summary.error = 'could not be parsed';
      }
    }
    manifests.push({ path: f.rel_path, kind, summary });
  }
  const entryPoints = files.filter((f) => f.status === 'indexed' && ENTRY_RE.test(f.rel_path)).map((f) => f.rel_path).slice(0, 30);
  for (const m of manifests) {
    const main = m.summary.main;
    if (typeof main === 'string' && !entryPoints.includes(main)) entryPoints.unshift(main);
  }
  const documentation = rt.db
    .all<{ rel_path: string; title: string }>("SELECT rel_path, title FROM documents WHERE source_id = ? AND (doc_type IN ('readme','document','decision','requirement','spec') OR rel_path LIKE '%.md') ORDER BY rel_path LIMIT 200", sourceId)
    .map((d) => ({ path: d.rel_path, title: d.title }));
  const keyFiles = [...new Set([...manifests.map((m) => m.path), ...entryPoints, ...documentation.filter((d) => /readme|architecture|design|adr|requirement/i.test(d.path)).map((d) => d.path)])].slice(0, 40);
  const limitations: string[] = [];
  const skippedCount = [...skipped.values()].reduce((s, l) => s + l.length, 0);
  if (skippedCount) limitations.push(`${skippedCount} file(s) were not indexed (see the skipped list): their content was not analyzed.`);
  if (errors) limitations.push(`${errors} file(s) could not be read.`);
  if (skipped.has('secret-name') || skipped.has('secret-content')) limitations.push('Files that look like secrets were deliberately not read.');
  limitations.push('The code structure was detected heuristically (regular expressions), without full parsing.');
  const documents = rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE source_id = ?', sourceId)!.c;
  const inventory: ProjectInventory = {
    sourceId,
    name: src.name,
    rootPath: src.root_path,
    computedAt: nowIso(),
    totals: { files: files.length, indexed, skipped: skippedCount, errors, documents },
    languages: [...langs].map(([language, n]) => ({ language, files: n })).sort((a, b) => b.files - a.files),
    topLevel: [...top].map(([path, n]) => ({ path, files: n })).sort((a, b) => b.files - a.files).slice(0, 40),
    manifests,
    entryPoints,
    tests: { count: tests.length, sample: tests.slice(0, 15) },
    documentation,
    keyFiles,
    skipped: [...skipped].map(([reason, list]) => ({ reason, text: SKIP_REASON_TEXT[reason as SkipReason] ?? reason, count: list.length, sample: list.slice(0, 8) })),
    limitations,
  };
  rt.db.run(
    'INSERT INTO project_profiles(source_id, profile, files_hash, computed_at) VALUES (?, ?, ?, ?) ON CONFLICT(source_id) DO UPDATE SET profile = excluded.profile, files_hash = excluded.files_hash, computed_at = excluded.computed_at',
    sourceId,
    JSON.stringify(inventory),
    filesHash,
    inventory.computedAt,
  );
  return inventory;
}
