import { posix } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import type { Indexer } from '../index/indexer.ts';
import { AppError } from '../util/errors.ts';
import { normalizeRelPath, validateSegment } from '../fs/guard.ts';
import { ATTACHMENT_MIME } from '../fs/file-kinds.ts';
import { parseJson } from '../util/json.ts';
import { sha256 } from '../util/hash.ts';
import { formatDate, isoDate } from '../util/time.ts';
import { parseMarkdown } from '../markdown/parse.ts';
import { splitFrontmatter, updateFrontmatter } from '../markdown/frontmatter.ts';
import { basenameKey, linkKey } from '../index/resolver.ts';
import { BUILTIN_TEMPLATES, mergeProperties, renderTemplate, type TemplateInfo } from './templates.ts';

export interface DocSummary {
  id: string;
  sourceId: string;
  relPath: string;
  title: string;
  docType: string | null;
  status: string | null;
  fmId: string | null;
  tags: string[];
  updatedAt: string | null;
  wordCount: number;
}

export interface LinkRef {
  docId: string;
  title: string;
  relPath: string;
  line: number;
  kind: string;
  relation: string;
  context: string | null;
}

export interface DocDetail extends DocSummary {
  content: string;
  hash: string;
  diskHash: string;
  editable: boolean;
  sourceKind: 'vault' | 'project';
  sourceName: string;
  frontmatter: Record<string, unknown>;
  headings: { level: number; text: string; line: number }[];
  outline: { kind: string; name: string; line: number }[];
  aliases: string[];
  properties: { key: string; type: string; values: (string | null)[] }[];
  outgoing: (LinkRef & { targetRaw: string; resolved: boolean })[];
  backlinks: LinkRef[];
  frontmatterError: string | null;
  stale: boolean;
}

export interface RenamePlan {
  docId: string;
  from: string;
  to: string;
  changes: { docId: string; title: string; relPath: string; line: number; before: string; after: string; hash: string }[];
  planHash: string;
}

interface DocRow {
  id: string;
  n: number;
  source_id: string;
  rel_path: string;
  title: string;
  doc_type: string | null;
  status: string | null;
  fm_id: string | null;
  frontmatter: string;
  headings: string;
  outline: string;
  aliases: string;
  word_count: number;
  hash: string;
  updated_at: string | null;
  review_after: string | null;
}

const ATTACHMENTS_FOLDER = 'Attachments';

/** Document operations of ONE system. All writes go through SafeFs (scope check, history, conflicts). */
export class DocumentService {
  constructor(
    private readonly rt: SystemRuntime,
    private readonly indexer: Indexer,
  ) {}

  private row(docId: string): DocRow {
    const r = this.rt.db.get<DocRow>('SELECT * FROM documents WHERE id = ?', docId);
    if (!r) throw new AppError('NOT_FOUND', 'Document not found.');
    return r;
  }

  private sourceOf(sourceId: string): { id: string; kind: 'vault' | 'project'; root_path: string; writable: number; name: string } {
    const s = this.rt.db.get<{ id: string; kind: 'vault' | 'project'; root_path: string; writable: number; name: string }>('SELECT id, kind, root_path, writable, name FROM sources WHERE id = ?', sourceId);
    if (!s) throw new AppError('NOT_FOUND', 'The document source was not found.');
    return s;
  }

  private vault() {
    return this.sourceOf(this.rt.primaryVaultId());
  }

  private scopeFor(source: { root_path: string; writable: number }) {
    return { roots: [source.root_path], writable: !!source.writable };
  }

  private tagsOf(docId: string): string[] {
    return this.rt.db.all<{ tag: string }>('SELECT tag FROM doc_tags WHERE doc_id = ? ORDER BY tag', docId).map((r) => r.tag);
  }

  summary(r: DocRow): DocSummary {
    return { id: r.id, sourceId: r.source_id, relPath: r.rel_path, title: r.title, docType: r.doc_type, status: r.status, fmId: r.fm_id, tags: this.tagsOf(r.id), updatedAt: r.updated_at, wordCount: r.word_count };
  }

  list(opts: { sourceId?: string; folder?: string; tag?: string; type?: string; property?: { key: string; value?: string }; sort?: 'title' | 'updated' | 'path'; limit?: number; offset?: number } = {}): { items: DocSummary[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.sourceId) {
      where.push('d.source_id = ?');
      params.push(opts.sourceId);
    }
    if (opts.folder) {
      where.push("d.rel_path LIKE ? ESCAPE '\\'");
      params.push(`${opts.folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`);
    }
    if (opts.tag) {
      where.push('EXISTS (SELECT 1 FROM doc_tags t WHERE t.doc_id = d.id AND (t.tag = ? OR t.tag LIKE ?))');
      const t = opts.tag.toLowerCase().replace(/^#/, '');
      params.push(t, `${t}/%`);
    }
    if (opts.type) {
      where.push('d.doc_type = ?');
      params.push(opts.type);
    }
    if (opts.property) {
      if (opts.property.value === undefined) {
        where.push('EXISTS (SELECT 1 FROM doc_properties p WHERE p.doc_id = d.id AND p.key = ?)');
        params.push(opts.property.key);
      } else {
        where.push('EXISTS (SELECT 1 FROM doc_properties p WHERE p.doc_id = d.id AND p.key = ? AND ulower(p.value_text) = ulower(?))');
        params.push(opts.property.key, opts.property.value);
      }
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = opts.sort === 'updated' ? 'd.updated_at DESC' : opts.sort === 'path' ? 'd.rel_path' : 'd.title_lower';
    const total = this.rt.db.get<{ c: number }>(`SELECT COUNT(*) AS c FROM documents d ${w}`, ...params)!.c;
    const rows = this.rt.db.all<DocRow>(`SELECT d.* FROM documents d ${w} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, Math.min(opts.limit ?? 100, 1000), opts.offset ?? 0);
    return { items: rows.map((r) => this.summary(r)), total };
  }

  /** Table view rows (Bases-lite): documents with the requested property columns. */
  table(opts: { columns: string[]; sourceId?: string; type?: string; tag?: string; limit?: number }): { rows: (DocSummary & { props: Record<string, (string | null)[]> })[]; propertyKeys: { key: string; type: string; count: number }[] } {
    const base = this.list({ ...(opts.sourceId ? { sourceId: opts.sourceId } : {}), ...(opts.type ? { type: opts.type } : {}), ...(opts.tag ? { tag: opts.tag } : {}), limit: opts.limit ?? 500 });
    const rows = base.items.map((d) => {
      const props: Record<string, (string | null)[]> = {};
      for (const c of opts.columns) {
        props[c] = this.rt.db.all<{ value_text: string | null }>('SELECT value_text FROM doc_properties WHERE doc_id = ? AND key = ? ORDER BY ord', d.id, c).map((r) => r.value_text);
      }
      return { ...d, props };
    });
    const propertyKeys = this.rt.db.all<{ key: string; type: string; count: number }>(
      'SELECT p.key, COALESCE(t.type, MIN(p.value_type)) AS type, COUNT(DISTINCT p.doc_id) AS count FROM doc_properties p LEFT JOIN property_types t ON t.key = p.key GROUP BY p.key ORDER BY count DESC LIMIT 200',
    );
    return { rows, propertyKeys };
  }

  tags(): { tag: string; display: string; count: number }[] {
    return this.rt.db.all<{ tag: string; display: string; count: number }>('SELECT tag, MIN(display) AS display, COUNT(*) AS count FROM doc_tags GROUP BY tag ORDER BY count DESC, tag LIMIT 2000');
  }

  async get(docId: string): Promise<DocDetail> {
    const r = this.row(docId);
    const src = this.sourceOf(r.source_id);
    const read = await this.rt.fs.readText(join(src.root_path, r.rel_path), this.scopeFor({ ...src, writable: 0 }));
    const outgoing = this.rt.db
      .all<{ target_raw: string; resolved_doc_id: string | null; line: number; kind: string; relation: string; title: string | null; rel_path: string | null }>(
        `SELECT l.target_raw, l.resolved_doc_id, l.line, l.kind, l.relation, d.title, d.rel_path FROM doc_links l LEFT JOIN documents d ON d.id = l.resolved_doc_id WHERE l.src_doc_id = ? ORDER BY l.line`,
        docId,
      )
      .map((l) => ({ docId: l.resolved_doc_id ?? '', title: l.title ?? l.target_raw, relPath: l.rel_path ?? '', line: l.line, kind: l.kind, relation: l.relation, context: null, targetRaw: l.target_raw, resolved: !!l.resolved_doc_id }));
    const backlinks = this.backlinks(docId);
    const props = new Map<string, { type: string; values: (string | null)[] }>();
    for (const p of this.rt.db.all<{ key: string; value_type: string; value_text: string | null }>('SELECT key, value_type, value_text FROM doc_properties WHERE doc_id = ? ORDER BY key, ord', docId)) {
      const e = props.get(p.key) ?? { type: p.value_type, values: [] };
      e.values.push(p.value_text);
      props.set(p.key, e);
    }
    const parsed = parseMarkdown(read.text, posix.basename(r.rel_path));
    const reviewAfter = r.review_after;
    return {
      ...this.summary(r),
      content: read.text,
      hash: r.hash,
      diskHash: read.hash,
      editable: !!src.writable,
      sourceKind: src.kind,
      sourceName: src.name,
      frontmatter: parseJson(r.frontmatter, {}),
      headings: parseJson(r.headings, []),
      outline: parseJson(r.outline, []),
      aliases: parseJson(r.aliases, []),
      properties: [...props].map(([key, v]) => ({ key, ...v })),
      outgoing,
      backlinks,
      frontmatterError: r.rel_path.endsWith('.md') ? parsed.frontmatterError : null,
      stale: !!reviewAfter && reviewAfter < isoDate(),
    };
  }

  backlinks(docId: string): LinkRef[] {
    return this.rt.db
      .all<{ src_doc_id: string; line: number; kind: string; relation: string; title: string; rel_path: string; context: string | null }>(
        `SELECT l.src_doc_id, l.line, l.kind, l.relation, d.title, d.rel_path, l.context FROM doc_links l JOIN documents d ON d.id = l.src_doc_id WHERE l.resolved_doc_id = ? AND l.src_doc_id <> ? ORDER BY d.title_lower, l.line`,
        docId,
        docId,
      )
      .map((l) => ({ docId: l.src_doc_id, title: l.title, relPath: l.rel_path, line: l.line, kind: l.kind, relation: l.relation, context: l.context }));
  }

  /** Mentions of the document's title or aliases that are not links yet (Obsidian "Unlinked mentions"). */
  unlinkedMentions(docId: string, limit = 50): { docId: string; title: string; relPath: string; snippet: string; term: string }[] {
    const r = this.row(docId);
    const terms = [r.title, ...parseJson<string[]>(r.aliases, [])].filter((t) => t && t.length >= 3);
    const linking = new Set(this.rt.db.all<{ src_doc_id: string }>('SELECT DISTINCT src_doc_id FROM doc_links WHERE resolved_doc_id = ?', docId).map((x) => x.src_doc_id));
    const out: { docId: string; title: string; relPath: string; snippet: string; term: string }[] = [];
    for (const term of terms) {
      const phrase = `"${term.replace(/"/g, ' ')}"`;
      let rows: { id: string; title: string; rel_path: string; snip: string }[] = [];
      try {
        rows = this.rt.db.all(
          `SELECT d.id, d.title, d.rel_path, snippet(documents_fts, 3, '[[', ']]', '…', 12) AS snip FROM documents_fts JOIN documents d ON d.n = documents_fts.rowid WHERE documents_fts MATCH ? LIMIT ?`,
          `body : ${phrase}`,
          limit,
        );
      } catch {
        rows = [];
      }
      for (const row of rows) {
        if (row.id === docId || linking.has(row.id) || out.some((o) => o.docId === row.id)) continue;
        out.push({ docId: row.id, title: row.title, relPath: row.rel_path, snippet: row.snip, term });
      }
    }
    return out.slice(0, limit);
  }

  // ---------- create / save ----------

  templates(): TemplateInfo[] {
    const folder = this.rt.settings.get<string>('docs.templatesFolder');
    const vault = this.vault();
    const user = this.rt.db
      .all<{ id: string; rel_path: string; title: string; doc_type: string | null }>("SELECT id, rel_path, title, doc_type FROM documents WHERE source_id = ? AND rel_path LIKE ? ESCAPE '\\'", vault.id, `${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`)
      .map((d) => ({ id: `user:${d.rel_path}`, name: d.title, description: `User template (${d.rel_path})`, docType: d.doc_type, builtin: false, folderHint: null, content: '' }));
    return [...BUILTIN_TEMPLATES, ...user];
  }

  private async templateContent(id: string): Promise<{ content: string; folderHint: string | null }> {
    const builtin = BUILTIN_TEMPLATES.find((t) => t.id === id);
    if (builtin) return { content: builtin.content, folderHint: builtin.folderHint };
    if (id.startsWith('user:')) {
      const rel = normalizeRelPath(id.slice(5));
      const vault = this.vault();
      const r = await this.rt.fs.readText(join(vault.root_path, rel), this.scopeFor({ ...vault, writable: 0 }));
      return { content: r.text, folderHint: null };
    }
    throw new AppError('NOT_FOUND', 'Template not found.');
  }

  /** Next free id with the prefix, e.g. REQ-007, across this system's documents. */
  nextId(prefix: string): string {
    const p = prefix.toUpperCase().replace(/[^A-Z0-9-]/g, '') || 'ID';
    const rows = this.rt.db.all<{ fm_id: string }>('SELECT fm_id FROM documents WHERE upper(fm_id) LIKE ?', `${p}-%`);
    let max = 0;
    for (const r of rows) {
      const m = new RegExp(`^${p}-(\\d+)$`, 'i').exec(r.fm_id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `${p}-${String(max + 1).padStart(3, '0')}`;
  }

  private systemName(): string {
    return this.rt.app.registryDb.get<{ name: string }>('SELECT name FROM systems WHERE system_id = ?', this.rt.systemId)?.name ?? '';
  }

  async create(input: { title: string; folder?: string; templateId?: string; properties?: Record<string, unknown>; content?: string; actor?: string; fileName?: string }): Promise<DocDetail> {
    const title = input.title.trim();
    if (!title) throw new AppError('VALIDATION_FAILED', 'Enter a document title.');
    const vault = this.vault();
    let body = input.content ?? '';
    let folderHint: string | null = null;
    if (input.templateId) {
      const t = await this.templateContent(input.templateId);
      folderHint = t.folderHint;
      body = renderTemplate(t.content, { title, systemName: this.systemName(), nextId: (p) => this.nextId(p) });
      if (input.content) body = `${body.trimEnd()}\n\n${input.content}`;
    } else if (!body) {
      body = `# ${title}\n\n`;
    }
    if (input.properties && Object.keys(input.properties).length) body = mergeProperties(body, input.properties);
    const folderSetting = this.rt.settings.get<string>('docs.newNoteFolder');
    const folder = (input.folder ?? folderHint ?? folderSetting ?? '').trim();
    const relFolder = folder ? normalizeRelPath(folder) : '';
    const base = input.fileName ? sanitizeFileName(input.fileName.replace(/\.md$/i, '')) : sanitizeFileName(title);
    const relPath = await this.uniquePath(vault.root_path, relFolder, base, '.md');
    const res = await this.rt.fs.writeText(join(vault.root_path, relPath), body, { scope: this.scopeFor(vault), expectedHash: null, reason: 'create', actor: input.actor ?? 'user', history: { sourceId: vault.id, relPath, docId: null } });
    await this.indexer.indexPaths(vault.id, [relPath]);
    const doc = this.rt.db.get<{ id: string }>('SELECT id FROM documents WHERE source_id = ? AND rel_path = ?', vault.id, relPath);
    if (!doc) throw new AppError('INTERNAL', 'The document was created but not indexed.');
    this.rt.audit.record({ actor: input.actor ?? 'user', action: 'doc.create', target: relPath, details: { docId: doc.id, template: input.templateId ?? null, hash: res.hash } });
    this.rt.emit('docs.changed', { docId: doc.id, change: 'create' });
    return this.get(doc.id);
  }

  private async uniquePath(root: string, folder: string, base: string, ext: string): Promise<string> {
    for (let i = 0; i < 1000; i++) {
      const name = i === 0 ? `${base}${ext}` : `${base} ${i + 1}${ext}`;
      const rel = folder ? `${folder}/${name}` : name;
      try {
        await stat(join(root, rel));
      } catch {
        return rel;
      }
    }
    throw new AppError('VALIDATION_FAILED', 'Could not find a free file name.');
  }

  /** Saves new content. expectedHash protects against overwriting external edits (WRITE_CONFLICT). */
  async save(docId: string, content: string, expectedHash: string, actor = 'user'): Promise<{ hash: string; doc: DocSummary }> {
    const r = this.row(docId);
    const src = this.sourceOf(r.source_id);
    if (!src.writable) throw new AppError('READ_ONLY_SOURCE');
    const res = await this.rt.fs.writeText(join(src.root_path, r.rel_path), content, { scope: this.scopeFor(src), expectedHash, reason: 'edit', actor, history: { sourceId: src.id, relPath: r.rel_path, docId } });
    await this.indexer.indexPaths(src.id, [r.rel_path]);
    this.rt.audit.record({ actor, action: 'doc.save', target: r.rel_path, details: { docId, from: res.previousHash, to: res.hash } });
    this.rt.emit('docs.changed', { docId, change: 'save' });
    return { hash: res.hash, doc: this.summary(this.row(docId)) };
  }

  async updateProperties(docId: string, patch: Record<string, unknown>, expectedHash: string, actor = 'user'): Promise<{ hash: string }> {
    const detail = await this.get(docId);
    if (detail.diskHash !== expectedHash) throw new AppError('WRITE_CONFLICT', undefined, { details: { currentHash: detail.diskHash, currentText: detail.content } });
    const next = updateFrontmatter(detail.content, patch);
    const res = await this.save(docId, next, expectedHash, actor);
    return { hash: res.hash };
  }

  // ---------- rename / move with link updates ----------

  private linkTextFor(targetDocRel: string, newRel: string, kind: string, fromRel: string, original: string): string {
    if (kind === 'markdown' || kind === 'embed' && /\.[a-z0-9]+$/i.test(original) && !original.endsWith('.md')) {
      // markdown links: relative path from the linking note, URL-encoded like Obsidian writes them
      const rel = posix.relative(posix.dirname(fromRel), newRel);
      const keepExt = /\.md$/i.test(original);
      const target = keepExt ? rel : rel.replace(/\.md$/i, '');
      return target.split('/').map((s) => encodeURIComponent(s)).join('/');
    }
    // wikilinks: shortest unique form (file name) unless another document shares the name
    const base = posix.basename(newRel).replace(/\.md$/i, '');
    const clash = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM documents WHERE basename_lower = ? AND rel_path <> ?', basenameKey(newRel), targetDocRel)!.c;
    const linkFormat = this.rt.settings.get<string>('docs.linkFormat');
    if (clash > 0 || linkFormat === 'absolute' || original.includes('/')) return newRel.replace(/\.md$/i, '');
    return base;
  }

  /** Computes every textual change a rename would cause, without writing anything. */
  async planRename(docId: string, newRelPathInput: string): Promise<RenamePlan> {
    const r = this.row(docId);
    const src = this.sourceOf(r.source_id);
    if (!src.writable) throw new AppError('READ_ONLY_SOURCE');
    let newRel = normalizeRelPath(newRelPathInput);
    if (!/\.[a-z0-9]+$/i.test(newRel)) newRel += posix.extname(r.rel_path) || '.md';
    if (newRel === r.rel_path) throw new AppError('VALIDATION_FAILED', 'The new name is the same as the current one.');
    const exists = this.rt.db.get<{ id: string }>('SELECT id FROM files WHERE source_id = ? AND rel_path = ?', src.id, newRel);
    if (exists) throw new AppError('WRITE_CONFLICT', 'A file with this name already exists.');
    const linkers = this.rt.db.all<{ src_doc_id: string }>('SELECT DISTINCT src_doc_id FROM doc_links WHERE resolved_doc_id = ?', docId);
    const changes: RenamePlan['changes'] = [];
    for (const { src_doc_id } of linkers) {
      const lr = this.row(src_doc_id);
      const lsrc = this.sourceOf(lr.source_id);
      if (!lsrc.writable) continue; // project files are never modified
      const file = await this.rt.fs.readText(join(lsrc.root_path, lr.rel_path), this.scopeFor({ ...lsrc, writable: 0 }));
      const edits = this.linkEdits(file.text, lr, docId, r.rel_path, newRel);
      for (const e of edits) changes.push({ docId: lr.id, title: lr.title, relPath: lr.rel_path, line: e.line, before: e.beforeLine, after: e.afterLine, hash: file.hash });
    }
    const planHash = sha256(JSON.stringify({ docId, to: newRel, changes: changes.map((c) => [c.docId, c.line, c.after, c.hash]) }));
    return { docId, from: r.rel_path, to: newRel, changes, planHash };
  }

  private linkEdits(text: string, linker: DocRow, targetId: string, targetRel: string, newRel: string): { start: number; end: number; replacement: string; line: number; beforeLine: string; afterLine: string }[] {
    const parsed = parseMarkdown(text, posix.basename(linker.rel_path));
    const edits: { start: number; end: number; replacement: string; line: number; beforeLine: string; afterLine: string }[] = [];
    const resolver = this.indexer.linkResolver;
    for (const l of parsed.links) {
      if (l.external || l.targetStart < 0 || !l.target) continue;
      const resolved = resolver.resolve(l.target, { sourceId: linker.source_id, relPath: linker.rel_path });
      if (resolved !== targetId) continue;
      const replacement = this.linkTextFor(targetRel, newRel, l.kind, linker.rel_path, text.slice(l.targetStart, l.targetEnd));
      edits.push({ start: l.targetStart, end: l.targetEnd, replacement, line: l.line, beforeLine: '', afterLine: '' });
    }
    // frontmatter relation values ("[[Old]]" or "Old")
    const fm = splitFrontmatter(text);
    if (fm.raw !== null) {
      const fmStart = text.indexOf('\n') + 1;
      for (const l of parsed.links.filter((x) => x.kind === 'frontmatter')) {
        const resolved = resolver.resolve(l.target, { sourceId: linker.source_id, relPath: linker.rel_path });
        if (resolved !== targetId) continue;
        const idx = fm.raw.indexOf(l.target);
        if (idx === -1) continue;
        const replacement = this.linkTextFor(targetRel, newRel, 'wikilink', linker.rel_path, l.target);
        const start = fmStart + idx;
        edits.push({ start, end: start + l.target.length, replacement, line: text.slice(0, start).split('\n').length - 1, beforeLine: '', afterLine: '' });
      }
    }
    edits.sort((a, b) => b.start - a.start);
    const lines = text.split('\n');
    let after = text;
    for (const e of edits) after = after.slice(0, e.start) + e.replacement + after.slice(e.end);
    const afterLines = after.split('\n');
    for (const e of edits) {
      e.beforeLine = lines[e.line] ?? '';
      e.afterLine = afterLines[e.line] ?? '';
    }
    return edits.reverse();
  }

  /**
   * Moves/renames a document. With updateLinks, every linking note in the vault is rewritten (each with a
   * conflict check and a history snapshot). Returns a report of what was done.
   */
  async rename(docId: string, newRelPath: string, opts: { updateLinks: boolean; planHash?: string; actor?: string } = { updateLinks: true }): Promise<{ docId: string; relPath: string; updated: string[]; failed: { relPath: string; error: string }[] }> {
    const plan = await this.planRename(docId, newRelPath);
    if (opts.planHash && opts.planHash !== plan.planHash) {
      throw new AppError('WRITE_CONFLICT', 'Files changed after the rename plan was built.', { hint: 'Build the plan again and review the changes.' });
    }
    const r = this.row(docId);
    const src = this.sourceOf(r.source_id);
    const actor = opts.actor ?? 'user';
    // Rewrite links BEFORE moving so resolution of the old name still works while computing edits.
    const updated: string[] = [];
    const failed: { relPath: string; error: string }[] = [];
    if (opts.updateLinks) {
      const byDoc = new Map<string, RenamePlan['changes']>();
      for (const c of plan.changes) byDoc.set(c.docId, [...(byDoc.get(c.docId) ?? []), c]);
      for (const [linkerId, changes] of byDoc) {
        const lr = this.row(linkerId);
        const lsrc = this.sourceOf(lr.source_id);
        try {
          const file = await this.rt.fs.readText(join(lsrc.root_path, lr.rel_path), this.scopeFor({ ...lsrc, writable: 0 }));
          if (file.hash !== changes[0]!.hash) throw new AppError('WRITE_CONFLICT');
          const edits = this.linkEdits(file.text, lr, docId, r.rel_path, plan.to);
          let text = file.text;
          for (const e of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, e.start) + e.replacement + text.slice(e.end);
          await this.rt.fs.writeText(join(lsrc.root_path, lr.rel_path), text, { scope: this.scopeFor(lsrc), expectedHash: file.hash, reason: 'rename-links', actor, history: { sourceId: lsrc.id, relPath: lr.rel_path, docId: linkerId } });
          updated.push(lr.rel_path);
        } catch (e) {
          failed.push({ relPath: lr.rel_path, error: e instanceof AppError ? e.message : String(e) });
        }
      }
    }
    await this.rt.fs.move(join(src.root_path, r.rel_path), join(src.root_path, plan.to), this.scopeFor(src));
    await this.indexer.indexPaths(src.id, [r.rel_path, plan.to, ...updated]);
    const moved = this.rt.db.get<{ id: string }>('SELECT id FROM documents WHERE source_id = ? AND rel_path = ?', src.id, plan.to);
    this.rt.audit.record({ actor, action: 'doc.rename', target: r.rel_path, outcome: failed.length ? 'error' : 'ok', details: { to: plan.to, updated, failed } });
    this.rt.emit('docs.changed', { docId, change: 'rename' });
    return { docId: moved?.id ?? docId, relPath: plan.to, updated, failed };
  }

  /** Moves the file into the system's .trash (recoverable), never a hard delete. */
  async delete(docId: string, actor = 'user'): Promise<{ trashedTo: string }> {
    const r = this.row(docId);
    const src = this.sourceOf(r.source_id);
    if (!src.writable) throw new AppError('READ_ONLY_SOURCE');
    const content = await this.rt.fs.readText(join(src.root_path, r.rel_path), this.scopeFor({ ...src, writable: 0 }));
    this.rt.history.snapshot({ sourceId: src.id, relPath: r.rel_path, docId, content: content.text, reason: 'before:delete', actor });
    const target = await this.rt.fs.trash(join(src.root_path, r.rel_path), r.rel_path, this.rt.paths.trashDir, { roots: [src.root_path], writable: true });
    await this.indexer.indexPaths(src.id, [r.rel_path]);
    this.rt.audit.record({ actor, action: 'doc.delete', target: r.rel_path, details: { docId, trashedTo: target } });
    this.rt.emit('docs.changed', { docId, change: 'delete' });
    return { trashedTo: target };
  }

  // ---------- daily notes, folders, attachments ----------

  async daily(date: Date = new Date()): Promise<DocDetail> {
    const folder = this.rt.settings.get<string>('docs.dailyFolder');
    const fmt = this.rt.settings.get<string>('docs.dailyFormat');
    const name = formatDate(date, fmt);
    const rel = `${folder ? folder + '/' : ''}${name}.md`;
    const vault = this.vault();
    const existing = this.rt.db.get<{ id: string }>('SELECT id FROM documents WHERE source_id = ? AND rel_path = ?', vault.id, normalizeRelPath(rel));
    if (existing) return this.get(existing.id);
    const parts = normalizeRelPath(rel).split('/');
    const fileName = parts.pop()!;
    return this.create({ title: name, folder: parts.join('/'), templateId: this.rt.settings.get<string>('docs.dailyTemplate'), fileName });
  }

  async folders(): Promise<string[]> {
    const vault = this.vault();
    const out = new Set<string>();
    for (const r of this.rt.db.all<{ rel_path: string }>('SELECT rel_path FROM files WHERE source_id = ?', vault.id)) {
      const parts = r.rel_path.split('/');
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
    }
    // empty folders created by the user are not in the index: add them from disk (one level deep is enough for pickers)
    try {
      for (const e of await readdir(vault.root_path, { withFileTypes: true })) if (e.isDirectory() && !e.name.startsWith('.')) out.add(e.name);
    } catch {
      // ignore
    }
    return [...out].sort((a, b) => a.localeCompare(b));
  }

  async createFolder(path: string): Promise<string> {
    const vault = this.vault();
    const rel = normalizeRelPath(path);
    await this.rt.fs.mkdirp(join(vault.root_path, rel), this.scopeFor(vault));
    this.rt.audit.record({ actor: 'user', action: 'folder.create', target: rel });
    return rel;
  }

  async uploadAttachment(fileName: string, bytes: Buffer, folder = ATTACHMENTS_FOLDER): Promise<{ relPath: string; embed: string }> {
    const vault = this.vault();
    const ext = posix.extname(fileName).toLowerCase();
    if (!ATTACHMENT_MIME[ext]) throw new AppError('VALIDATION_FAILED', 'Images and PDF are supported.');
    if (bytes.length > 20 * 1024 * 1024) throw new AppError('FILE_TOO_LARGE');
    const base = sanitizeFileName(posix.basename(fileName, ext));
    const relFolder = normalizeRelPath(folder);
    const rel = await this.uniquePath(vault.root_path, relFolder, base, ext);
    const { atomicWrite } = await import('../fs/safe-fs.ts');
    const { assertInScope } = await import('../fs/guard.ts');
    const abs = await assertInScope(join(vault.root_path, rel), this.scopeFor(vault), { write: true });
    await atomicWrite(abs, bytes);
    await this.indexer.indexPaths(vault.id, [rel]);
    this.rt.audit.record({ actor: 'user', action: 'attachment.upload', target: rel, details: { size: bytes.length } });
    return { relPath: rel, embed: `![[${posix.basename(rel)}]]` };
  }

  /** Bytes of an attachment referenced by an embed, resolved like Obsidian (exact path, then file name). */
  async attachment(target: string, fromDocId?: string): Promise<{ bytes: Buffer; mime: string; relPath: string }> {
    const vault = this.vault();
    const key = target.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    let rel = this.rt.db.get<{ rel_path: string; source_id: string }>('SELECT rel_path, source_id FROM files WHERE ulower(rel_path) = ulower(?)', key);
    if (!rel && fromDocId) {
      const from = this.row(fromDocId);
      const candidate = posix.normalize(posix.join(posix.dirname(from.rel_path), key));
      rel = this.rt.db.get('SELECT rel_path, source_id FROM files WHERE ulower(rel_path) = ulower(?)', candidate);
    }
    if (!rel) rel = this.rt.db.get("SELECT rel_path, source_id FROM files WHERE ulower(rel_path) LIKE ? ESCAPE '\\' ORDER BY length(rel_path) LIMIT 1", `%/${posix.basename(key).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}`);
    if (!rel) throw new AppError('NOT_FOUND', 'Attachment not found.');
    const src = this.sourceOf(rel.source_id);
    const ext = posix.extname(rel.rel_path).toLowerCase();
    const mime = ATTACHMENT_MIME[ext];
    if (!mime) throw new AppError('VALIDATION_FAILED', 'This file type is not displayed in the application.');
    const bytes = await this.rt.fs.readBytes(join(src.root_path, rel.rel_path), this.scopeFor({ ...src, writable: 0 }));
    void vault;
    return { bytes, mime, relPath: rel.rel_path };
  }

  // ---------- history ----------

  versions(docId: string) {
    const r = this.row(docId);
    return this.rt.history.list(r.source_id, r.rel_path, docId);
  }

  version(versionId: number) {
    const v = this.rt.history.get(versionId);
    if (!v) throw new AppError('NOT_FOUND', 'Version not found.');
    return v;
  }

  /** Restores a previous version as a new write (the current content is snapshotted first, so it is undoable). */
  async restore(docId: string, versionId: number, expectedHash: string, actor = 'user'): Promise<{ hash: string }> {
    const v = this.version(versionId);
    const r = this.row(docId);
    if (v.relPath !== r.rel_path && v.docId !== docId) throw new AppError('VALIDATION_FAILED', 'The version belongs to another document.');
    const res = await this.save(docId, v.content, expectedHash, actor);
    this.rt.audit.record({ actor, action: 'doc.restore', target: r.rel_path, details: { versionId } });
    return { hash: res.hash };
  }

  /** Lookup by link target, used by the UI for [[link]] navigation and creating missing notes. */
  resolve(target: string, fromDocId?: string): { docId: string | null; suggestedPath: string } {
    const from = fromDocId ? this.row(fromDocId) : null;
    const resolved = this.indexer.linkResolver.resolve(target, from ? { sourceId: from.source_id, relPath: from.rel_path } : { sourceId: this.rt.primaryVaultId(), relPath: '' });
    const key = linkKey(target);
    const suggested = key.includes('/') ? `${target.replace(/\.md$/i, '')}.md` : `${sanitizeFileName(target.replace(/\.md$/i, '').split('#')[0]!)}.md`;
    return { docId: resolved, suggestedPath: suggested };
  }

  /** Title search for link autocompletion and the quick switcher (prefix + trigram substring). */
  suggest(q: string, limit = 20): { id: string; title: string; relPath: string; aliases: string[] }[] {
    const query = q.trim().toLowerCase();
    if (!query) {
      return this.rt.db.all<{ id: string; title: string; rel_path: string; aliases: string }>('SELECT id, title, rel_path, aliases FROM documents ORDER BY updated_at DESC LIMIT ?', limit).map((r) => ({ id: r.id, title: r.title, relPath: r.rel_path, aliases: parseJson(r.aliases, []) }));
    }
    const out = new Map<string, { id: string; title: string; relPath: string; aliases: string[] }>();
    const add = (rows: { id: string; title: string; rel_path: string; aliases: string }[]) => {
      for (const r of rows) if (!out.has(r.id)) out.set(r.id, { id: r.id, title: r.title, relPath: r.rel_path, aliases: parseJson(r.aliases, []) });
    };
    add(this.rt.db.all("SELECT id, title, rel_path, aliases FROM documents WHERE title_lower LIKE ? ESCAPE '\\' OR basename_lower LIKE ? ESCAPE '\\' ORDER BY length(title) LIMIT ?", `${escapeLike(query)}%`, `${escapeLike(query)}%`, limit));
    add(this.rt.db.all('SELECT d.id, d.title, d.rel_path, d.aliases FROM doc_aliases a JOIN documents d ON d.id = a.doc_id WHERE a.alias_lower LIKE ? LIMIT ?', `${escapeLike(query)}%`, limit));
    if (out.size < limit && query.length >= 3) {
      try {
        add(this.rt.db.all('SELECT d.id, d.title, d.rel_path, d.aliases FROM documents_trgm t JOIN documents d ON d.n = t.rowid WHERE documents_trgm MATCH ? LIMIT ?', `"${query.replace(/"/g, '')}"`, limit));
      } catch {
        // malformed trigram query: ignore
      }
    }
    return [...out.values()].slice(0, limit);
  }
}

export function sanitizeFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  let s = name.replace(/[\u0000-\u001f<>:"/\\|?*#^[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/[. ]+$/, '').slice(0, 150);
  if (!s) s = 'Untitled';
  try {
    validateSegment(s);
  } catch {
    s = `_${s}`;
  }
  return s;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
