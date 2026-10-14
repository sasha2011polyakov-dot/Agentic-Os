import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import type { GraphService, EdgeInput } from '../graph/graph.ts';
import { docNodeId, nodeTypeForDoc, projectNodeId, unresolvedNodeId } from '../graph/graph.ts';
import { classifyFile, isTextKind, looksBinary, type FileKind } from '../fs/file-kinds.ts';
import { IgnoreRules, type SkipReason } from '../fs/ignore-rules.ts';
import { walkSource, type WalkEntry } from '../fs/walk.ts';
import { detectSecretContent } from '../fs/secrets.ts';
import { findRequirementIds, inferDocType, parseFile, type ParsedDocument } from '../parsers/index.ts';
import { flattenProperties, inferType } from '../markdown/properties.ts';
import { chunkDocument } from './chunks.ts';
import { basenameKey, linkKey, LinkResolver } from './resolver.ts';
import { AppError, errorMessage, throwIfAborted } from '../util/errors.ts';
import { sha256 } from '../util/hash.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';

export interface SourceRow {
  id: string;
  kind: 'vault' | 'project';
  name: string;
  root_path: string;
  writable: number;
  confidential: number;
  include_globs: string;
  exclude_globs: string;
  respect_gitignore: number;
  max_file_bytes: number;
  is_git: number;
  watch: number;
  status: string;
}

export interface IndexStats {
  sourceId: string;
  scanned: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  removed: number;
  renamed: number;
  errors: number;
  documents: number;
  durationMs: number;
  skippedByReason: Record<string, number>;
  errorSamples: { path: string; error: string }[];
  cancelled: boolean;
}

interface ExistingFile {
  id: string;
  rel_path: string;
  size: number;
  mtime_ms: number;
  hash: string | null;
  status: string;
  skip_reason: string | null;
}

interface PendingDoc {
  fileId: string;
  relPath: string;
  kind: FileKind;
  language: string | undefined;
  size: number;
  mtimeMs: number;
  hash: string;
  text: string;
  parsed: ParsedDocument;
  renamedFrom?: ExistingFile;
}

const BATCH = 40;

function emptyStats(sourceId: string): IndexStats {
  return { sourceId, scanned: 0, indexed: 0, unchanged: 0, skipped: 0, removed: 0, renamed: 0, errors: 0, documents: 0, durationMs: 0, skippedByReason: {}, errorSamples: [], cancelled: false };
}

/**
 * Incremental indexer of ONE system. Jobs per source are serialized (watcher bursts, manual reindex and
 * app writes never race). Phases: (A) process changed files, (B) resolve links incl. forward references,
 * (C) rebuild graph edges of affected documents. Each batch is one transaction.
 */
export class Indexer {
  private readonly resolver: LinkResolver;
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly controllers = new Map<string, AbortController>();
  private stopped = false;

  constructor(
    private readonly rt: SystemRuntime,
    private readonly graph: GraphService,
  ) {
    this.resolver = new LinkResolver(rt.db);
  }

  get linkResolver(): LinkResolver {
    return this.resolver;
  }

  isIndexing(sourceId?: string): boolean {
    return sourceId ? this.controllers.has(sourceId) : this.controllers.size > 0;
  }

  private enqueue<T>(sourceId: string, job: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(sourceId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(job);
    this.queues.set(sourceId, next);
    void next.finally(() => {
      if (this.queues.get(sourceId) === next) this.queues.delete(sourceId);
    }).catch(() => undefined);
    return next;
  }

  cancel(sourceId: string): void {
    this.controllers.get(sourceId)?.abort();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled([...this.queues.values()]);
  }

  source(sourceId: string): SourceRow {
    const s = this.rt.db.get<SourceRow>('SELECT * FROM sources WHERE id = ?', sourceId);
    if (!s) throw new AppError('NOT_FOUND', 'Source not found.');
    return s;
  }

  private rules(s: SourceRow): IgnoreRules {
    const systemExcludes = this.rt.settings.get<string[]>('index.defaultExcludes');
    return new IgnoreRules({
      includeGlobs: parseJson<string[]>(s.include_globs, []),
      excludeGlobs: [...systemExcludes, ...parseJson<string[]>(s.exclude_globs, [])],
      respectGitignore: !!s.respect_gitignore,
    });
  }

  private setStatus(sourceId: string, status: string, message: string | null, extra: { stats?: IndexStats } = {}): void {
    if (this.rt.isClosed) return;
    const now = nowIso();
    if (extra.stats) {
      this.rt.db.run('UPDATE sources SET status = ?, status_message = ?, last_indexed_at = ?, last_index_stats = ?, updated_at = ? WHERE id = ?', status, message, now, JSON.stringify(extra.stats), now, sourceId);
    } else {
      this.rt.db.run('UPDATE sources SET status = ?, status_message = ?, updated_at = ? WHERE id = ?', status, message, now, sourceId);
    }
    this.rt.emit('source.updated', { sourceId, status, message });
  }

  /** Full scan of a source (only changed files are re-parsed unless force). */
  indexSource(sourceId: string, opts: { force?: boolean } = {}): Promise<IndexStats> {
    return this.enqueue(sourceId, () => this.runScan(sourceId, opts.force ?? false));
  }

  /** Incremental update for specific paths (watcher events, app writes). Missing files are treated as deleted. */
  indexPaths(sourceId: string, relPaths: string[]): Promise<IndexStats> {
    return this.enqueue(sourceId, () => this.runPaths(sourceId, [...new Set(relPaths)]));
  }

  private async runScan(sourceId: string, force: boolean): Promise<IndexStats> {
    const started = Date.now();
    const stats = emptyStats(sourceId);
    const s = this.source(sourceId);
    try {
      const st = await stat(s.root_path);
      if (!st.isDirectory()) throw new Error('not a directory');
    } catch (e) {
      this.setStatus(sourceId, 'unavailable', `Folder unavailable: ${errorMessage(e)}`);
      throw new AppError('SOURCE_NOT_ACCESSIBLE', undefined, { details: { path: s.root_path } });
    }
    const controller = new AbortController();
    this.controllers.set(sourceId, controller);
    this.setStatus(sourceId, 'indexing', 'Scanning…');
    try {
      const existing = new Map(this.rt.db.all<ExistingFile>('SELECT id, rel_path, size, mtime_ms, hash, status, skip_reason FROM files WHERE source_id = ?', sourceId).map((f) => [f.rel_path, f]));
      const seen = new Set<string>();
      const entries: WalkEntry[] = [];
      for await (const entry of walkSource(s.root_path, { rules: this.rules(s), maxFileBytes: s.max_file_bytes, signal: controller.signal })) {
        entries.push(entry);
        seen.add(entry.relPath);
        if (entries.length % 500 === 0) this.rt.emit('index.progress', { sourceId, phase: 'scan', scanned: entries.length });
      }
      const deleted = [...existing.values()].filter((f) => !seen.has(f.rel_path));
      await this.processEntries(s, entries, existing, deleted, force, stats, controller.signal);
    } catch (e) {
      if (controller.signal.aborted || (e instanceof AppError && e.code === 'CANCELLED')) {
        stats.cancelled = true;
      } else {
        this.controllers.delete(sourceId);
        stats.durationMs = Date.now() - started;
        this.setStatus(sourceId, 'error', `Indexing error: ${errorMessage(e)}`, { stats });
        this.rt.log.error('indexing failed', { sourceId, error: e as Error });
        throw e;
      }
    } finally {
      this.controllers.delete(sourceId);
    }
    stats.durationMs = Date.now() - started;
    stats.documents = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE source_id = ?', sourceId)!.c;
    const message = stats.cancelled ? 'Indexing cancelled: processed files were saved.' : stats.errors ? `Done with errors: ${stats.errors}` : null;
    this.setStatus(sourceId, stats.cancelled ? 'ready' : 'ready', message, { stats });
    this.rt.emit('index.done', stats);
    this.rt.audit.record({ actor: 'system', action: 'index.scan', target: sourceId, outcome: stats.errors ? 'error' : 'ok', details: { ...stats, errorSamples: stats.errorSamples.slice(0, 5) } });
    return stats;
  }

  private async runPaths(sourceId: string, relPaths: string[]): Promise<IndexStats> {
    const started = Date.now();
    const stats = emptyStats(sourceId);
    if (this.stopped || this.rt.isClosed) return stats;
    const s = this.source(sourceId);
    const rules = this.rules(s);
    const existing = new Map<string, ExistingFile>();
    for (const p of relPaths) {
      const f = this.rt.db.get<ExistingFile>('SELECT id, rel_path, size, mtime_ms, hash, status, skip_reason FROM files WHERE source_id = ? AND rel_path = ?', sourceId, p);
      if (f) existing.set(p, f);
    }
    const entries: WalkEntry[] = [];
    const deleted: ExistingFile[] = [];
    for (const rel of relPaths) {
      const abs = join(s.root_path, rel);
      let st;
      try {
        st = await stat(abs);
      } catch {
        const ex = existing.get(rel);
        if (ex) deleted.push(ex);
        continue;
      }
      if (!st.isFile()) continue;
      const segments = rel.split('/');
      let dirSkip: SkipReason | null = null;
      for (let i = 0; i < segments.length - 1 && !dirSkip; i++) dirSkip = rules.isExcludedDir(segments[i]!, segments.slice(0, i + 1).join('/'));
      const skip = dirSkip ?? rules.checkFile(rel) ?? (st.size > s.max_file_bytes ? 'too-large' : null);
      entries.push({ relPath: rel, absPath: abs, size: st.size, mtimeMs: Math.floor(st.mtimeMs), skip });
    }
    await this.processEntries(s, entries, existing, deleted, false, stats);
    stats.durationMs = Date.now() - started;
    stats.documents = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE source_id = ?', sourceId)!.c;
    if (stats.indexed || stats.removed || stats.renamed) this.rt.emit('docs.changed', { sourceId, paths: relPaths });
    return stats;
  }

  private async processEntries(s: SourceRow, entries: WalkEntry[], existing: Map<string, ExistingFile>, deleted: ExistingFile[], force: boolean, stats: IndexStats, signal?: AbortSignal): Promise<void> {
    const deletedByHash = new Map<string, ExistingFile>();
    for (const d of deleted) if (d.hash && d.status === 'indexed') deletedByHash.set(d.hash, d);
    const changedDocIds = new Set<string>();
    let pending: PendingDoc[] = [];
    const skippedRows: { entry: WalkEntry; reason: SkipReason; kind: FileKind; existing?: ExistingFile }[] = [];

    const flush = () => {
      if (!pending.length && !skippedRows.length) return;
      const batch = pending;
      const skips = skippedRows.splice(0);
      pending = [];
      this.rt.db.transaction(() => {
        for (const sk of skips) this.writeSkipped(s, sk.entry, sk.reason, sk.kind, sk.existing);
        for (const p of batch) changedDocIds.add(this.writeDocument(s, p));
      });
    };

    for (const entry of entries) {
      throwIfAborted(signal);
      stats.scanned++;
      const ex = existing.get(entry.relPath);
      const { kind, language } = classifyFile(entry.relPath);
      if (entry.skip) {
        stats.skipped++;
        stats.skippedByReason[entry.skip] = (stats.skippedByReason[entry.skip] ?? 0) + 1;
        if (!ex || ex.status !== 'skipped' || ex.skip_reason !== entry.skip) skippedRows.push({ entry, reason: entry.skip, kind, ...(ex ? { existing: ex } : {}) });
        continue;
      }
      if (!isTextKind(kind)) {
        const reason: SkipReason | null = kind === 'image' ? null : kind === 'other' ? null : 'unsupported-format';
        if (kind === 'other') {
          // Unknown extension: index only if it looks like text (README-like files), never binaries.
          try {
            const head = await readFile(entry.absPath);
            if (looksBinary(head) || entry.size > 512 * 1024) {
              stats.skipped++;
              stats.skippedByReason.binary = (stats.skippedByReason.binary ?? 0) + 1;
              if (!ex || ex.skip_reason !== 'binary') skippedRows.push({ entry, reason: 'binary', kind, ...(ex ? { existing: ex } : {}) });
              continue;
            }
          } catch {
            stats.errors++;
            continue;
          }
          stats.skipped++;
          stats.skippedByReason['unsupported-format'] = (stats.skippedByReason['unsupported-format'] ?? 0) + 1;
          if (!ex || ex.skip_reason !== 'unsupported-format') skippedRows.push({ entry, reason: 'unsupported-format', kind, ...(ex ? { existing: ex } : {}) });
          continue;
        }
        if (reason) {
          stats.skipped++;
          stats.skippedByReason[reason] = (stats.skippedByReason[reason] ?? 0) + 1;
          if (!ex || ex.skip_reason !== reason) skippedRows.push({ entry, reason, kind, ...(ex ? { existing: ex } : {}) });
        } else if (!ex || ex.size !== entry.size || ex.mtime_ms !== entry.mtimeMs) {
          // attachments (images): tracked so embeds resolve, never parsed
          this.rt.db.run(
            `INSERT INTO files(id, source_id, rel_path, size, mtime_ms, hash, kind, language, status, skip_reason, error, indexed_at)
             VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 'indexed', NULL, NULL, ?)
             ON CONFLICT(source_id, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, kind = excluded.kind, status = 'indexed', skip_reason = NULL, indexed_at = excluded.indexed_at`,
            ex?.id ?? newId('f'),
            s.id,
            entry.relPath,
            entry.size,
            entry.mtimeMs,
            kind,
            nowIso(),
          );
        }
        continue;
      }
      if (!force && ex && ex.status === 'indexed' && ex.size === entry.size && ex.mtime_ms === entry.mtimeMs && ex.hash) {
        stats.unchanged++;
        continue;
      }
      let buf: Buffer;
      try {
        buf = await readFile(entry.absPath);
      } catch (e) {
        stats.errors++;
        if (stats.errorSamples.length < 20) stats.errorSamples.push({ path: entry.relPath, error: errorMessage(e) });
        skippedRows.push({ entry, reason: 'unreadable', kind, ...(ex ? { existing: ex } : {}) });
        continue;
      }
      if (looksBinary(buf)) {
        stats.skipped++;
        stats.skippedByReason.binary = (stats.skippedByReason.binary ?? 0) + 1;
        skippedRows.push({ entry, reason: 'binary', kind, ...(ex ? { existing: ex } : {}) });
        continue;
      }
      const hash = sha256(buf);
      if (!force && ex && ex.hash === hash && ex.status === 'indexed') {
        this.rt.db.run('UPDATE files SET size = ?, mtime_ms = ? WHERE id = ?', entry.size, entry.mtimeMs, ex.id);
        stats.unchanged++;
        continue;
      }
      const text = buf.toString('utf8');
      // Vault notes are user content the user chose to write; project files are scanned for credentials.
      if (s.kind === 'project' && kind !== 'markdown' && detectSecretContent(text)) {
        stats.skipped++;
        stats.skippedByReason['secret-content'] = (stats.skippedByReason['secret-content'] ?? 0) + 1;
        skippedRows.push({ entry, reason: 'secret-content', kind, ...(ex ? { existing: ex } : {}) });
        continue;
      }
      let parsed: ParsedDocument;
      try {
        parsed = parseFile(entry.relPath, kind, text, language);
      } catch (e) {
        stats.errors++;
        if (stats.errorSamples.length < 20) stats.errorSamples.push({ path: entry.relPath, error: errorMessage(e) });
        continue;
      }
      const renamedFrom = !ex ? deletedByHash.get(hash) : undefined;
      if (renamedFrom) {
        deletedByHash.delete(hash);
        const idx = deleted.indexOf(renamedFrom);
        if (idx !== -1) deleted.splice(idx, 1);
        stats.renamed++;
      }
      pending.push({ fileId: ex?.id ?? renamedFrom?.id ?? newId('f'), relPath: entry.relPath, kind, language, size: entry.size, mtimeMs: entry.mtimeMs, hash, text, parsed, ...(renamedFrom ? { renamedFrom } : {}) });
      stats.indexed++;
      if (pending.length >= BATCH) {
        flush();
        this.rt.emit('index.progress', { sourceId: s.id, phase: 'index', scanned: stats.scanned, indexed: stats.indexed, total: entries.length });
        await new Promise((r) => setImmediate(r)); // keep the event loop responsive
      }
    }
    flush();
    if (deleted.length) {
      this.rt.db.transaction(() => {
        for (const d of deleted) {
          const doc = this.rt.db.get<{ id: string }>('SELECT id FROM documents WHERE file_id = ?', d.id);
          if (doc) this.removeDocument(doc.id);
          this.rt.db.run('DELETE FROM files WHERE id = ?', d.id);
          stats.removed++;
        }
      });
    }
    // Phase B + C
    this.rt.emit('index.progress', { sourceId: s.id, phase: 'links', scanned: stats.scanned, indexed: stats.indexed, total: entries.length });
    const affected = this.resolveLinks(changedDocIds, stats.removed > 0 || stats.renamed > 0 || changedDocIds.size > 0);
    for (const id of changedDocIds) affected.add(id);
    // New/changed requirement documents: project files that mention their id need traceability edges.
    for (const id of changedDocIds) {
      const fmId = this.rt.db.get<{ fm_id: string | null }>('SELECT fm_id FROM documents WHERE id = ?', id)?.fm_id;
      if (fmId && /^REQ(-[A-Z0-9]+)*-\d{1,5}$/i.test(fmId)) for (const m of this.docsMentioning(fmId)) affected.add(m);
    }
    this.rt.db.transaction(() => {
      for (const id of affected) this.rebuildDocEdges(id);
      this.graph.pruneUnresolved();
    });
    if (affected.size) this.rt.emit('graph.changed', { sourceId: s.id, documents: affected.size });
  }

  private writeSkipped(s: SourceRow, entry: WalkEntry, reason: SkipReason, kind: FileKind, ex?: ExistingFile): void {
    if (ex) {
      const doc = this.rt.db.get<{ id: string }>('SELECT id FROM documents WHERE file_id = ?', ex.id);
      if (doc) this.removeDocument(doc.id);
    }
    this.rt.db.run(
      `INSERT INTO files(id, source_id, rel_path, size, mtime_ms, hash, kind, language, status, skip_reason, error, indexed_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, 'skipped', ?, NULL, ?)
       ON CONFLICT(source_id, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = NULL, kind = excluded.kind,
         status = 'skipped', skip_reason = excluded.skip_reason, indexed_at = excluded.indexed_at`,
      ex?.id ?? newId('f'),
      s.id,
      entry.relPath,
      entry.size,
      entry.mtimeMs,
      kind,
      reason,
      nowIso(),
    );
  }

  /** Inserts/updates one document and all derived rows. Returns the (stable) document id. */
  private writeDocument(s: SourceRow, p: PendingDoc): string {
    const db = this.rt.db;
    const now = nowIso();
    if (p.renamedFrom) {
      db.run('UPDATE files SET rel_path = ? WHERE id = ?', p.relPath, p.renamedFrom.id);
      db.run('UPDATE documents SET rel_path = ? WHERE file_id = ?', p.relPath, p.renamedFrom.id);
      this.rt.history.rename(s.id, p.renamedFrom.rel_path, p.relPath);
    }
    db.run(
      `INSERT INTO files(id, source_id, rel_path, size, mtime_ms, hash, kind, language, status, skip_reason, error, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexed', NULL, NULL, ?)
       ON CONFLICT(source_id, rel_path) DO UPDATE SET size = excluded.size, mtime_ms = excluded.mtime_ms, hash = excluded.hash, kind = excluded.kind,
         language = excluded.language, status = 'indexed', skip_reason = NULL, error = NULL, indexed_at = excluded.indexed_at`,
      p.fileId,
      s.id,
      p.relPath,
      p.size,
      p.mtimeMs,
      p.hash,
      p.kind,
      p.language ?? null,
      now,
    );
    const fileId = db.get<{ id: string }>('SELECT id FROM files WHERE source_id = ? AND rel_path = ?', s.id, p.relPath)!.id;
    const fm = p.parsed.frontmatter;
    const fmId = typeof fm.id === 'string' || typeof fm.id === 'number' ? String(fm.id) : null;
    const status = typeof fm.status === 'string' ? fm.status : null;
    const createdAt = typeof fm.created === 'string' ? fm.created : null;
    const updatedAt = typeof fm.updated === 'string' ? fm.updated : new Date(p.mtimeMs).toISOString();
    const reviewAfter = typeof fm.review_after === 'string' ? fm.review_after : null;
    const docType = p.parsed.docType ?? inferDocType(p.relPath);
    const existing = db.get<{ id: string; n: number }>('SELECT id, n FROM documents WHERE file_id = ?', fileId);
    const docId = existing?.id ?? newId('doc');
    const values = [
      s.id, p.relPath, p.parsed.title, p.parsed.title.toLowerCase(), basenameKey(p.relPath), fmId, docType, status,
      JSON.stringify(p.parsed.aliases), JSON.stringify(fm), JSON.stringify(p.parsed.headings), JSON.stringify(p.parsed.blockIds),
      JSON.stringify(p.parsed.outline.slice(0, 300)), p.parsed.wordCount, p.hash, createdAt, updatedAt, reviewAfter, now,
    ] as const;
    let n: number;
    if (existing) {
      db.run(
        `UPDATE documents SET source_id = ?, rel_path = ?, title = ?, title_lower = ?, basename_lower = ?, fm_id = ?, doc_type = ?, status = ?, aliases = ?,
           frontmatter = ?, headings = ?, block_ids = ?, outline = ?, word_count = ?, hash = ?, created_at = ?, updated_at = ?, review_after = ?, indexed_at = ? WHERE id = ?`,
        ...values,
        docId,
      );
      n = existing.n;
    } else {
      const r = db.run(
        `INSERT INTO documents(id, file_id, source_id, rel_path, title, title_lower, basename_lower, fm_id, doc_type, status, aliases, frontmatter, headings, block_ids, outline,
           word_count, hash, created_at, updated_at, review_after, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        docId,
        fileId,
        ...values,
      );
      n = Number(r.lastInsertRowid);
    }
    // full-text rows
    db.run('DELETE FROM documents_fts WHERE rowid = ?', n);
    db.run('DELETE FROM documents_trgm WHERE rowid = ?', n);
    const tagsText = p.parsed.tags.map((t) => t.tag).join(' ');
    db.run('INSERT INTO documents_fts(rowid, title, aliases, headings, body, path, tags) VALUES (?, ?, ?, ?, ?, ?, ?)', n, p.parsed.title, p.parsed.aliases.join(' '), p.parsed.headings.map((h) => h.text).join(' '), p.parsed.searchText.slice(0, 2_000_000), p.relPath, tagsText);
    db.run('INSERT INTO documents_trgm(rowid, title, path) VALUES (?, ?, ?)', n, p.parsed.title, p.relPath);
    // derived rows
    for (const t of ['doc_aliases', 'doc_tags', 'doc_properties', 'doc_checkboxes', 'chunks']) db.run(`DELETE FROM ${t} WHERE doc_id = ?`, docId);
    db.run('DELETE FROM doc_links WHERE src_doc_id = ?', docId);
    for (const a of new Set(p.parsed.aliases.map((x) => x.toLowerCase()))) db.run('INSERT OR IGNORE INTO doc_aliases(doc_id, alias_lower, alias) VALUES (?, ?, ?)', docId, a, p.parsed.aliases.find((x) => x.toLowerCase() === a)!);
    for (const t of p.parsed.tags) db.run('INSERT OR IGNORE INTO doc_tags(doc_id, tag, display) VALUES (?, ?, ?)', docId, t.tag, t.display);
    for (const prop of flattenProperties(fm)) {
      db.run('INSERT OR IGNORE INTO doc_properties(doc_id, key, ord, value_type, value_text, value_num) VALUES (?, ?, ?, ?, ?, ?)', docId, prop.key, prop.ord, prop.type, prop.text, prop.num);
    }
    for (const [key, value] of Object.entries(fm)) db.run('INSERT OR IGNORE INTO property_types(key, type, inferred) VALUES (?, ?, 1)', key, inferType(key, value));
    for (const t of p.parsed.tasks) db.run('INSERT OR IGNORE INTO doc_checkboxes(doc_id, line, text, done) VALUES (?, ?, ?, ?)', docId, t.line, t.text, t.done ? 1 : 0);
    const fileLines = p.text.split('\n');
    for (const l of p.parsed.links) {
      if (l.external) continue;
      const context = (l.kind === 'frontmatter' ? l.raw : (fileLines[l.line] ?? '')).trim().slice(0, 300) || null;
      db.run(
        'INSERT INTO doc_links(src_doc_id, kind, relation, target_raw, target_key, heading, block_id, alias, line, col, is_external, context, resolved_doc_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL)',
        docId,
        l.kind,
        l.relation,
        l.target,
        linkKey(l.target),
        l.heading,
        l.blockId,
        l.alias,
        l.line,
        l.col,
        context,
      );
    }
    const chunks = chunkDocument(p.text, p.parsed, p.kind === 'markdown', p.kind === 'markdown' ? parsedBodyStart(p.text) : 0);
    for (const c of chunks) db.run('INSERT INTO chunks(doc_id, ord, heading_path, start_line, end_line, text, hash) VALUES (?, ?, ?, ?, ?, ?, ?)', docId, c.ord, c.headingPath, c.startLine, c.endLine, c.text, c.hash);
    this.graph.upsertNode({
      id: docNodeId(docId),
      type: nodeTypeForDoc(docType, s.kind),
      label: p.parsed.title,
      refId: docId,
      sourceId: s.id,
      props: { path: p.relPath, docType, status, fmId, tags: p.parsed.tags.map((t) => t.tag), updatedAt },
    });
    return docId;
  }

  removeDocument(docId: string): void {
    const row = this.rt.db.get<{ n: number }>('SELECT n FROM documents WHERE id = ?', docId);
    if (row) {
      this.rt.db.run('DELETE FROM documents_fts WHERE rowid = ?', row.n);
      this.rt.db.run('DELETE FROM documents_trgm WHERE rowid = ?', row.n);
    }
    this.rt.db.run('DELETE FROM documents WHERE id = ?', docId);
    this.graph.removeNode(docNodeId(docId));
  }

  /**
   * Re-resolves links of changed documents plus every currently unresolved link (forward references to
   * files that were just created). Returns documents whose resolution changed (their edges must be rebuilt).
   */
  private resolveLinks(changedDocIds: Set<string>, recheckAll: boolean): Set<string> {
    const affected = new Set<string>();
    const rows = recheckAll
      ? this.rt.db.all<{ id: number; src_doc_id: string; target_raw: string; resolved_doc_id: string | null; source_id: string; rel_path: string }>(
          `SELECT l.id, l.src_doc_id, l.target_raw, l.resolved_doc_id, d.source_id, d.rel_path FROM doc_links l JOIN documents d ON d.id = l.src_doc_id
           WHERE l.resolved_doc_id IS NULL OR l.src_doc_id IN (${[...changedDocIds].map(() => '?').join(',') || "''"})`,
          ...changedDocIds,
        )
      : [];
    this.rt.db.transaction(() => {
      for (const r of rows) {
        if (!r.target_raw) continue;
        const resolved = this.resolver.resolve(r.target_raw, { sourceId: r.source_id, relPath: r.rel_path });
        if (resolved !== r.resolved_doc_id) {
          this.rt.db.run('UPDATE doc_links SET resolved_doc_id = ? WHERE id = ?', resolved, r.id);
          affected.add(r.src_doc_id);
        }
      }
    });
    // Links that pointed at a document whose title/path changed may now resolve elsewhere — handled because
    // changed docs' own links are re-resolved and deleted docs null their incoming links (ON DELETE SET NULL).
    return affected;
  }

  /** Rebuilds edges derived from one document: links, typed frontmatter relations, project membership, REQ mentions. */
  rebuildDocEdges(docId: string): void {
    const db = this.rt.db;
    const doc = db.get<{ id: string; n: number; source_id: string; doc_type: string | null; frontmatter: string; rel_path: string }>('SELECT id, n, source_id, doc_type, frontmatter, rel_path FROM documents WHERE id = ?', docId);
    if (!doc) return;
    const src = db.get<{ kind: 'vault' | 'project'; name: string; is_git: number }>('SELECT kind, name, is_git FROM sources WHERE id = ?', doc.source_id);
    if (!src) return;
    const from = docNodeId(docId);
    const edges: EdgeInput[] = [];
    const links = db.all<{ target_raw: string; target_key: string; resolved_doc_id: string | null; relation: string; kind: string; heading: string | null; block_id: string | null }>(
      'SELECT target_raw, target_key, resolved_doc_id, relation, kind, heading, block_id FROM doc_links WHERE src_doc_id = ?',
      docId,
    );
    for (const l of links) {
      if (!l.target_key) continue; // same-document anchor
      if (l.resolved_doc_id) {
        if (l.resolved_doc_id === docId) continue;
        edges.push({ src: from, dst: docNodeId(l.resolved_doc_id), relation: l.relation, origin: 'explicit', evidence: l.kind === 'frontmatter' ? `document property` : null });
      } else if (!this.resolver.isAttachment(l.target_raw, doc.source_id)) {
        const uid = unresolvedNodeId(l.target_key);
        this.graph.upsertNode({ id: uid, type: 'unresolved', label: l.target_raw, refId: l.target_key, sourceId: null, props: { target: l.target_raw } });
        edges.push({ src: from, dst: uid, relation: l.relation, origin: 'explicit' });
      }
    }
    if (src.kind === 'project') {
      const pid = projectNodeId(doc.source_id);
      this.graph.upsertNode({ id: pid, type: src.is_git ? 'repository' : 'project', label: src.name, refId: doc.source_id, sourceId: doc.source_id, props: {} });
      edges.push({ src: from, dst: pid, relation: 'belongs_to', origin: 'extracted', evidence: 'the file is in the project folder' });
    }
    const fm = parseJson<Record<string, unknown>>(doc.frontmatter, {});
    const projectRef = typeof fm.project === 'string' ? fm.project.replace(/^\[\[|\]\]$/g, '').trim() : null;
    if (projectRef) {
      const proj = db.get<{ id: string; name: string; is_git: number }>("SELECT id, name, is_git FROM sources WHERE kind = 'project' AND (ulower(name) = ulower(?) OR id = ?)", projectRef, projectRef);
      if (proj) {
        const pid = projectNodeId(proj.id);
        this.graph.upsertNode({ id: pid, type: proj.is_git ? 'repository' : 'project', label: proj.name, refId: proj.id, sourceId: proj.id, props: {} });
        edges.push({ src: from, dst: pid, relation: 'belongs_to', origin: 'explicit', evidence: 'project property' });
      }
    }
    // Traceability: requirement IDs mentioned in project files (code → implements, tests → verifies).
    // Only code and tests: a document mentioning an id is a reference, already covered by explicit links.
    if (src.kind === 'project' && (doc.doc_type === 'code' || doc.doc_type === 'test')) {
      const body = db.get<{ body: string }>('SELECT body FROM documents_fts WHERE rowid = ?', doc.n)?.body ?? '';
      for (const reqId of findRequirementIds(body).slice(0, 50)) {
        const req = db.get<{ id: string }>('SELECT id FROM documents WHERE upper(fm_id) = ? AND id <> ?', reqId.toUpperCase(), docId);
        if (req) edges.push({ src: from, dst: docNodeId(req.id), relation: doc.doc_type === 'test' ? 'verifies' : 'implements', origin: 'extracted', evidence: `mentions ${reqId}` });
      }
    }
    this.graph.setDerivedEdges(`doc:${docId}`, dedupe(edges));
  }

  /** Recomputes all graph edges from stored links (repair / after schema changes). */
  rebuildAllEdges(): number {
    const ids = this.rt.db.all<{ id: string }>('SELECT id FROM documents').map((r) => r.id);
    const affected = this.resolveLinks(new Set(ids), true);
    this.rt.db.transaction(() => {
      for (const id of ids) this.rebuildDocEdges(id);
      this.graph.removeDanglingDocNodes();
      this.graph.pruneUnresolved();
    });
    return affected.size;
  }

  /** Called when a requirement-like document appears: project files mentioning its id need new edges. */
  docsMentioning(fmId: string): string[] {
    const q = `"${fmId.replace(/"/g, '')}"`;
    try {
      return this.rt.db.all<{ id: string }>('SELECT d.id FROM documents_fts f JOIN documents d ON d.n = f.rowid WHERE documents_fts MATCH ? LIMIT 200', `body : ${q}`).map((r) => r.id);
    } catch {
      return [];
    }
  }
}

function dedupe(edges: EdgeInput[]): EdgeInput[] {
  const seen = new Set<string>();
  return edges.filter((e) => {
    const k = `${e.src}|${e.dst}|${e.relation}|${e.origin}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function parsedBodyStart(text: string): number {
  if (!/^﻿?---[ \t]*\r?\n/.test(text)) return 0;
  const lines = text.split('\n');
  for (let i = 1; i < lines.length; i++) if (/^(---|\.\.\.)[ \t]*\r?$/.test(lines[i]!)) return i + 1;
  return 0;
}
