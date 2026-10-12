import { access, constants, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { SystemRuntime, RuntimeService } from '../systems/runtime.ts';
import type { Indexer, IndexStats, SourceRow } from '../index/indexer.ts';
import type { GraphService } from '../graph/graph.ts';
import { projectNodeId } from '../graph/graph.ts';
import { SourceWatcher } from '../index/watcher.ts';
import { IgnoreRules, SKIP_REASON_TEXT, type SkipReason } from '../fs/ignore-rules.ts';
import { walkSource } from '../fs/walk.ts';
import { isInside, normalizeRelPath, realpathLoose } from '../fs/guard.ts';
import { classifyFile } from '../fs/file-kinds.ts';
import { readGitDetails, readGitInfo, type GitInfo } from './git.ts';
import { AppError, errorMessage } from '../util/errors.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';

export interface SourceInfo {
  id: string;
  kind: 'vault' | 'project';
  name: string;
  rootPath: string;
  purpose: string;
  category: string;
  writable: boolean;
  confidential: boolean;
  includeGlobs: string[];
  excludeGlobs: string[];
  respectGitignore: boolean;
  maxFileBytes: number;
  isGit: boolean;
  gitRoot: string | null;
  watch: boolean;
  watchMode: 'native' | 'polling' | 'off';
  status: string;
  statusMessage: string | null;
  lastIndexedAt: string | null;
  lastIndexStats: Partial<IndexStats>;
  counts: { indexed: number; skipped: number; errors: number; documents: number; links: number };
  createdAt: string;
}

export interface ConnectInput {
  path: string;
  name?: string;
  purpose?: string;
  category?: string;
  includeGlobs?: string[];
  excludeGlobs?: string[];
  respectGitignore?: boolean;
  maxFileBytes?: number;
  confidential?: boolean;
  watch?: boolean;
}

export interface SourcePreview {
  path: string;
  suggestedName: string;
  accessible: boolean;
  git: GitInfo;
  totalCandidates: number;
  indexable: number;
  skipped: number;
  skippedByReason: Record<string, { count: number; text: string }>;
  sample: { relPath: string; kind: string; skip: string | null }[];
  truncated: boolean;
  warnings: string[];
}

interface FullRow extends SourceRow {
  purpose: string;
  category: string;
  git_root: string | null;
  status_message: string | null;
  last_indexed_at: string | null;
  last_index_stats: string;
  created_at: string;
}

const MAX_PREVIEW = 20_000;

/** Connected folders of ONE system: the system vault + read-only project folders and repositories. */
export class SourceService implements RuntimeService {
  private readonly watchers = new Map<string, SourceWatcher>();
  private stopped = false;

  constructor(
    private readonly rt: SystemRuntime,
    private readonly indexer: Indexer,
    private readonly graph: GraphService,
  ) {}

  private toInfo(r: FullRow): SourceInfo {
    const counts = this.rt.db.get<{ indexed: number; skipped: number; errors: number }>(
      "SELECT SUM(status = 'indexed') AS indexed, SUM(status = 'skipped') AS skipped, SUM(status = 'error') AS errors FROM files WHERE source_id = ?",
      r.id,
    );
    const documents = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE source_id = ?', r.id)!.c;
    const links = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM doc_links l JOIN documents d ON d.id = l.src_doc_id WHERE d.source_id = ?', r.id)!.c;
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      rootPath: r.root_path,
      purpose: r.purpose,
      category: r.category,
      writable: !!r.writable,
      confidential: !!r.confidential,
      includeGlobs: parseJson(r.include_globs, []),
      excludeGlobs: parseJson(r.exclude_globs, []),
      respectGitignore: !!r.respect_gitignore,
      maxFileBytes: r.max_file_bytes,
      isGit: !!r.is_git,
      gitRoot: r.git_root,
      watch: !!r.watch,
      watchMode: this.watchers.get(r.id)?.mode ?? 'off',
      status: r.status,
      statusMessage: r.status_message,
      lastIndexedAt: r.last_indexed_at,
      lastIndexStats: parseJson(r.last_index_stats, {}),
      counts: { indexed: counts?.indexed ?? 0, skipped: counts?.skipped ?? 0, errors: counts?.errors ?? 0, documents, links },
      createdAt: r.created_at,
    };
  }

  list(kind?: 'vault' | 'project'): SourceInfo[] {
    const rows = kind ? this.rt.db.all<FullRow>('SELECT * FROM sources WHERE kind = ? ORDER BY kind DESC, name', kind) : this.rt.db.all<FullRow>("SELECT * FROM sources ORDER BY kind = 'project', name");
    return rows.map((r) => this.toInfo(r));
  }

  get(id: string): SourceInfo {
    const r = this.rt.db.get<FullRow>('SELECT * FROM sources WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Источник не найден.');
    return this.toInfo(r);
  }

  row(id: string): FullRow {
    const r = this.rt.db.get<FullRow>('SELECT * FROM sources WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Источник не найден.');
    return r;
  }

  private async validateFolder(path: string, ignoreId?: string): Promise<string> {
    if (!path || !isAbsolute(path)) throw new AppError('VALIDATION_FAILED', 'Укажите абсолютный путь к папке.');
    const abs = resolve(path);
    try {
      const st = await stat(abs);
      if (!st.isDirectory()) throw new AppError('VALIDATION_FAILED', 'Выбранный путь — не папка.');
      await access(abs, constants.R_OK);
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError('SOURCE_NOT_ACCESSIBLE', undefined, { details: { path: abs, reason: errorMessage(e) } });
    }
    const real = await realpathLoose(abs);
    const dataDir = await realpathLoose(this.rt.app.paths.dataDir);
    if (isInside(real, dataDir) || isInside(dataDir, real)) throw new AppError('SOURCE_OVERLAP', 'Нельзя подключать папку данных приложения.');
    for (const s of this.rt.db.all<{ id: string; name: string; root_path: string }>('SELECT id, name, root_path FROM sources')) {
      if (s.id === ignoreId) continue;
      const other = await realpathLoose(s.root_path);
      if (real === other) throw new AppError('SOURCE_ALREADY_CONNECTED', undefined, { details: { sourceId: s.id, name: s.name } });
      if (isInside(real, other) || isInside(other, real)) throw new AppError('SOURCE_OVERLAP', undefined, { details: { conflictsWith: s.name, path: s.root_path } });
    }
    return abs;
  }

  /** Dry run: what would be indexed with these rules. Nothing is written. */
  async preview(path: string, rules: { includeGlobs?: string[]; excludeGlobs?: string[]; respectGitignore?: boolean; maxFileBytes?: number } = {}): Promise<SourcePreview> {
    const warnings: string[] = [];
    let abs: string;
    try {
      abs = await this.validateFolder(path);
    } catch (e) {
      if (e instanceof AppError && (e.code === 'SOURCE_OVERLAP' || e.code === 'SOURCE_ALREADY_CONNECTED')) throw e;
      throw e;
    }
    const git = await readGitInfo(abs);
    if (git.isRepo && git.root && git.root !== abs) warnings.push(`Папка находится внутри Git-репозитория ${git.root}.`);
    const ignore = new IgnoreRules({ includeGlobs: rules.includeGlobs ?? [], excludeGlobs: [...this.rt.settings.get<string[]>('index.defaultExcludes'), ...(rules.excludeGlobs ?? [])], respectGitignore: rules.respectGitignore ?? true });
    const byReason: Record<string, { count: number; text: string }> = {};
    const sample: SourcePreview['sample'] = [];
    let total = 0;
    let indexable = 0;
    let truncated = false;
    for await (const e of walkSource(abs, { rules: ignore, maxFileBytes: rules.maxFileBytes ?? 2 * 1024 * 1024, reportSkippedDirs: true, maxEntries: MAX_PREVIEW })) {
      total++;
      const kind = classifyFile(e.relPath).kind;
      let skip: SkipReason | null = e.skip;
      if (!skip && (kind === 'pdf' || kind === 'office')) skip = 'unsupported-format';
      if (skip) byReason[skip] = { count: (byReason[skip]?.count ?? 0) + 1, text: SKIP_REASON_TEXT[skip] };
      else if (kind !== 'image') indexable++;
      if (sample.length < 300) sample.push({ relPath: e.relPath, kind: e.relPath.endsWith('/') ? 'folder' : kind, skip });
    }
    if (total >= MAX_PREVIEW) {
      truncated = true;
      warnings.push(`Показаны первые ${MAX_PREVIEW} элементов. Проверьте правила исключений: возможно, подключается слишком большая папка.`);
    }
    if (indexable === 0) warnings.push('Не найдено файлов для индексации. Проверьте правила включения и исключения.');
    return { path: abs, suggestedName: basename(abs), accessible: true, git, totalCandidates: total, indexable, skipped: total - indexable, skippedByReason: byReason, sample, truncated, warnings };
  }

  /** Registers a folder (read-only) and starts indexing in the background. Original files are never modified. */
  async connect(input: ConnectInput): Promise<SourceInfo> {
    const abs = await this.validateFolder(input.path);
    const git = await readGitInfo(abs);
    const id = newId('src');
    const now = nowIso();
    const name = (input.name?.trim() || basename(abs)).slice(0, 120);
    this.rt.db.run(
      `INSERT INTO sources(id, kind, name, root_path, purpose, category, writable, confidential, include_globs, exclude_globs, respect_gitignore, max_file_bytes, is_git, git_root, watch, status, created_at, updated_at)
       VALUES (?, 'project', ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
      id,
      name,
      abs,
      input.purpose?.slice(0, 1000) ?? '',
      input.category?.slice(0, 100) ?? '',
      input.confidential ? 1 : 0,
      JSON.stringify(cleanGlobs(input.includeGlobs)),
      JSON.stringify(cleanGlobs(input.excludeGlobs)),
      input.respectGitignore === false ? 0 : 1,
      clampSize(input.maxFileBytes),
      git.isRepo ? 1 : 0,
      git.root,
      input.watch === false ? 0 : 1,
      now,
      now,
    );
    this.graph.upsertNode({ id: projectNodeId(id), type: git.isRepo ? 'repository' : 'project', label: name, refId: id, sourceId: id, props: { path: abs, purpose: input.purpose ?? '' } });
    this.rt.audit.record({ actor: 'user', action: 'source.connect', target: id, details: { path: abs, name, isGit: git.isRepo } });
    this.rt.emit('source.updated', { sourceId: id, status: 'pending' });
    this.startWatcher(id);
    void this.indexer.indexSource(id).catch((e) => this.rt.log.warn('initial indexing failed', { sourceId: id, error: e as Error }));
    return this.get(id);
  }

  async update(id: string, patch: Partial<Omit<ConnectInput, 'path'>> & { writable?: boolean }): Promise<SourceInfo> {
    const r = this.row(id);
    const sets: string[] = [];
    const params: (string | number)[] = [];
    let rulesChanged = false;
    const set = (col: string, v: string | number) => {
      sets.push(`${col} = ?`);
      params.push(v);
    };
    if (patch.name !== undefined) set('name', patch.name.trim().slice(0, 120) || r.name);
    if (patch.purpose !== undefined) set('purpose', patch.purpose.slice(0, 1000));
    if (patch.category !== undefined) set('category', patch.category.slice(0, 100));
    if (patch.confidential !== undefined) set('confidential', patch.confidential ? 1 : 0);
    if (patch.watch !== undefined) set('watch', patch.watch ? 1 : 0);
    if (patch.includeGlobs !== undefined) {
      set('include_globs', JSON.stringify(cleanGlobs(patch.includeGlobs)));
      rulesChanged = true;
    }
    if (patch.excludeGlobs !== undefined) {
      set('exclude_globs', JSON.stringify(cleanGlobs(patch.excludeGlobs)));
      rulesChanged = true;
    }
    if (patch.respectGitignore !== undefined) {
      set('respect_gitignore', patch.respectGitignore ? 1 : 0);
      rulesChanged = true;
    }
    if (patch.maxFileBytes !== undefined) {
      set('max_file_bytes', clampSize(patch.maxFileBytes));
      rulesChanged = true;
    }
    if (patch.writable !== undefined && r.kind === 'project' && patch.writable) {
      throw new AppError('READ_ONLY_SOURCE', 'Подключённые проекты открываются только для чтения.', { hint: 'Создавайте и изменяйте документы в хранилище системы.' });
    }
    if (!sets.length) return this.get(id);
    set('updated_at', nowIso());
    params.push(id);
    this.rt.db.run(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`, ...params);
    if (patch.name !== undefined && r.kind === 'project') this.graph.upsertNode({ id: projectNodeId(id), type: r.is_git ? 'repository' : 'project', label: patch.name.trim() || r.name, refId: id, sourceId: id, props: { path: r.root_path } });
    this.rt.audit.record({ actor: 'user', action: 'source.update', target: id, details: patch });
    if (patch.watch !== undefined) {
      this.stopWatcher(id);
      if (patch.watch) this.startWatcher(id);
    }
    if (rulesChanged) void this.indexer.indexSource(id, { force: true }).catch(() => undefined);
    this.rt.emit('source.updated', { sourceId: id });
    return this.get(id);
  }

  /** Removes the source and its index entries. The folder and every file in it stay untouched. */
  async disconnect(id: string): Promise<void> {
    const r = this.row(id);
    if (r.kind === 'vault' && id === this.rt.primaryVaultId()) {
      throw new AppError('VALIDATION_FAILED', 'Основное хранилище системы нельзя отключить.', { hint: 'Чтобы убрать систему целиком, используйте раздел «Системы».' });
    }
    this.indexer.cancel(id);
    this.stopWatcher(id);
    this.rt.db.transaction(() => {
      const docs = this.rt.db.all<{ id: string }>('SELECT id FROM documents WHERE source_id = ?', id);
      for (const d of docs) this.indexer.removeDocument(d.id);
      this.rt.db.run('DELETE FROM graph_nodes WHERE source_id = ?', id);
      this.rt.db.run('DELETE FROM sources WHERE id = ?', id);
      this.graph.pruneUnresolved();
    });
    this.rt.audit.record({ actor: 'user', action: 'source.disconnect', target: id, details: { path: r.root_path, name: r.name } });
    this.rt.emit('source.updated', { sourceId: id, removed: true });
    this.rt.emit('graph.changed', { sourceId: id });
  }

  async checkAvailability(id: string): Promise<SourceInfo> {
    const r = this.row(id);
    try {
      const st = await stat(r.root_path);
      if (!st.isDirectory()) throw new Error('not a directory');
      await access(r.root_path, constants.R_OK);
      if (r.status === 'unavailable') {
        this.rt.db.run("UPDATE sources SET status = 'pending', status_message = NULL WHERE id = ?", id);
        void this.indexer.indexSource(id).catch(() => undefined);
      }
    } catch (e) {
      this.rt.db.run("UPDATE sources SET status = 'unavailable', status_message = ? WHERE id = ?", `Папка недоступна: ${errorMessage(e)}`, id);
    }
    return this.get(id);
  }

  reindex(id: string, force = false): Promise<IndexStats> {
    this.row(id);
    return this.indexer.indexSource(id, { force });
  }

  /** Immediate children of a folder inside a source, from the index (files) — fast even for big repos. */
  tree(id: string, dir = ''): { path: string; folders: { name: string; path: string; files: number }[]; files: { name: string; path: string; kind: string; status: string; skipReason: string | null; docId: string | null; size: number }[] } {
    this.row(id);
    const prefix = dir ? normalizeRelPath(dir) + '/' : '';
    const rows = this.rt.db.all<{ rel_path: string; kind: string; status: string; skip_reason: string | null; doc_id: string | null; size: number }>(
      `SELECT f.rel_path, f.kind, f.status, f.skip_reason, d.id AS doc_id, f.size FROM files f LEFT JOIN documents d ON d.file_id = f.id
       WHERE f.source_id = ? AND f.rel_path LIKE ? ESCAPE '\\' ORDER BY f.rel_path`,
      id,
      `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`,
    );
    const folders = new Map<string, number>();
    const files: ReturnType<SourceService['tree']>['files'] = [];
    for (const r of rows) {
      const rest = r.rel_path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push({ name: rest, path: r.rel_path, kind: r.kind, status: r.status, skipReason: r.skip_reason, docId: r.doc_id, size: r.size });
      else folders.set(rest.slice(0, slash), (folders.get(rest.slice(0, slash)) ?? 0) + 1);
    }
    return {
      path: prefix.replace(/\/$/, ''),
      folders: [...folders].map(([name, count]) => ({ name, path: prefix + name, files: count })).sort((a, b) => a.name.localeCompare(b.name)),
      files,
    };
  }

  /** Files of a source filtered by status (e.g. to show what was skipped and why). */
  files(id: string, opts: { status?: string; q?: string; limit?: number; offset?: number } = {}): { items: { path: string; kind: string; status: string; skipReason: string | null; skipText: string | null; size: number }[]; total: number } {
    this.row(id);
    const where = ['source_id = ?'];
    const params: (string | number)[] = [id];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.q) {
      where.push("ulower(rel_path) LIKE ? ESCAPE '\\'");
      params.push(`%${opts.q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const total = this.rt.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM files WHERE ${where.join(' AND ')}`, ...params)!.c;
    const rows = this.rt.db.all<{ rel_path: string; kind: string; status: string; skip_reason: string | null; size: number }>(
      `SELECT rel_path, kind, status, skip_reason, size FROM files WHERE ${where.join(' AND ')} ORDER BY rel_path LIMIT ? OFFSET ?`,
      ...params,
      Math.min(opts.limit ?? 200, 2000),
      opts.offset ?? 0,
    );
    return { items: rows.map((r) => ({ path: r.rel_path, kind: r.kind, status: r.status, skipReason: r.skip_reason, skipText: r.skip_reason ? (SKIP_REASON_TEXT[r.skip_reason as SkipReason] ?? r.skip_reason) : null, size: r.size })), total };
  }

  async readFile(id: string, relPath: string): Promise<{ text: string; hash: string; size: number }> {
    const r = this.row(id);
    const rel = normalizeRelPath(relPath);
    const file = this.rt.db.get<{ status: string; skip_reason: string | null }>('SELECT status, skip_reason FROM files WHERE source_id = ? AND rel_path = ?', id, rel);
    if (file?.skip_reason === 'secret-name' || file?.skip_reason === 'secret-content') {
      throw new AppError('PERMISSION_DENIED', 'Файл похож на файл с секретами и не открывается в приложении.', { hint: 'Откройте его в своём редакторе, если уверены, что это безопасно.' });
    }
    const res = await this.rt.fs.readText(join(r.root_path, rel), { roots: [r.root_path], writable: false });
    return { text: res.text, hash: res.hash, size: res.size };
  }

  async gitInfo(id: string): Promise<GitInfo> {
    const r = this.row(id);
    const info = await readGitInfo(r.root_path);
    if (info.isRepo && info.root && this.rt.app.appSettings.get<boolean>('security.gitDetails')) {
      return { ...info, ...(await readGitDetails(info.root)) };
    }
    return info;
  }

  // ---------- watchers / lifecycle ----------

  private startWatcher(id: string): void {
    if (this.stopped || this.watchers.has(id)) return;
    const r = this.rt.db.get<{ root_path: string; watch: number }>('SELECT root_path, watch FROM sources WHERE id = ?', id);
    if (!r || !r.watch) return;
    const w = new SourceWatcher(
      r.root_path,
      (paths) => void this.indexer.indexPaths(id, paths).catch((e) => this.rt.log.warn('incremental indexing failed', { sourceId: id, error: e as Error })),
      () => void this.indexer.indexSource(id).catch(() => undefined),
      this.rt.log,
    );
    w.start();
    this.watchers.set(id, w);
  }

  private stopWatcher(id: string): void {
    this.watchers.get(id)?.stop();
    this.watchers.delete(id);
  }

  /** On open: start watchers and run a catch-up scan (only changed files are re-parsed). */
  async start(): Promise<void> {
    for (const s of this.rt.db.all<{ id: string }>('SELECT id FROM sources')) {
      this.startWatcher(s.id);
      void this.indexer.indexSource(s.id).catch((e) => this.rt.log.warn('catch-up indexing failed', { sourceId: s.id, error: e as Error }));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const id of [...this.watchers.keys()]) this.stopWatcher(id);
    await this.indexer.stop();
  }
}

function cleanGlobs(globs?: string[]): string[] {
  return (globs ?? []).map((g) => g.trim()).filter((g) => g && g.length < 300).slice(0, 200);
}

function clampSize(v?: number): number {
  if (!v || !Number.isFinite(v)) return 2 * 1024 * 1024;
  return Math.max(16 * 1024, Math.min(Math.floor(v), 50 * 1024 * 1024));
}
