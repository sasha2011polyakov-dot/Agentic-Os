import { join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import type { Indexer } from '../index/indexer.ts';
import { normalizeRelPath } from '../fs/guard.ts';
import { detectSecretContent, isSecretFileName } from '../fs/secrets.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { sha256 } from '../util/hash.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { diffLines, diffStats, unifiedDiff } from '../util/diff.ts';

export type ChangeOp = 'create' | 'modify' | 'delete';
export type ChangeSetStatus = 'proposed' | 'applied' | 'partially_applied' | 'conflict' | 'reverted' | 'rejected';
export type ChangeFileStatus = 'pending' | 'applied' | 'conflict' | 'reverted' | 'skipped' | 'failed';

export interface ProposeFileInput {
  sourceId: string;
  path: string;
  op: ChangeOp;
  content?: string;
  rationale?: string;
}

export interface ChangeFileView {
  id: string;
  sourceId: string;
  sourceName: string;
  path: string;
  op: ChangeOp;
  rationale: string;
  status: ChangeFileStatus;
  statusDetail: string | null;
  added: number;
  removed: number;
  diff?: string;
}

export interface ChangeSetView {
  id: string;
  missionId: string | null;
  runId: string | null;
  stepId: string | null;
  title: string;
  status: ChangeSetStatus;
  createdBy: string;
  createdAt: string;
  appliedAt: string | null;
  appliedBy: string | null;
  revertedAt: string | null;
  report: unknown;
  files: ChangeFileView[];
  /** Per source: may this set be applied by the user (vault: yes; project: only with allow_apply). */
  applicable: { sourceId: string; allowed: boolean; reason: string | null }[];
}

interface SetRow {
  id: string;
  mission_id: string | null;
  run_id: string | null;
  step_id: string | null;
  title: string;
  status: ChangeSetStatus;
  created_by: string;
  created_at: string;
  applied_at: string | null;
  applied_by: string | null;
  reverted_at: string | null;
  report: string | null;
}

interface FileRow {
  id: string;
  change_set_id: string;
  source_id: string;
  rel_path: string;
  op: ChangeOp;
  base_hash: string | null;
  base_blob: string | null;
  new_blob: string | null;
  new_hash: string | null;
  rationale: string;
  status: ChangeFileStatus;
  status_detail: string | null;
  trash_path: string | null;
}

interface SourceRowLite {
  id: string;
  kind: 'vault' | 'project';
  name: string;
  root_path: string;
  writable: number;
  allow_apply: number;
}

const MAX_FILE_CHARS = 1_000_000;
const MAX_FILES_PER_SET = 200;
const PROTECTED = new Set(['.git', 'node_modules', '.aos', '.trash']);

/**
 * Change sets: agents only PROPOSE file changes (stored as content-addressed blobs with the hash of the file
 * they were based on). Applying is a separate user action with conflict detection, history snapshots and a
 * revert path. Projects stay read-only unless the user enabled "allow apply" for that project.
 */
export class ChangeSetService {
  constructor(
    private readonly rt: SystemRuntime,
    private readonly indexer: Indexer,
  ) {}

  private source(id: string): SourceRowLite {
    const s = this.rt.db.get<SourceRowLite>('SELECT id, kind, name, root_path, writable, allow_apply FROM sources WHERE id = ?', id);
    if (!s) throw new AppError('NOT_FOUND', `Источник ${id} не найден.`);
    return s;
  }

  private setRow(id: string): SetRow {
    const r = this.rt.db.get<SetRow>('SELECT * FROM change_sets WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Набор изменений не найден.');
    return r;
  }

  private files(setId: string): FileRow[] {
    return this.rt.db.all<FileRow>('SELECT * FROM change_set_files WHERE change_set_id = ? ORDER BY source_id, rel_path', setId);
  }

  applyDenial(s: SourceRowLite): string | null {
    if (s.kind === 'vault') return s.writable ? null : 'хранилище открыто только для чтения';
    return s.allow_apply ? null : `применение изменений к проекту «${s.name}» не разрешено в его настройках`;
  }

  create(args: { title: string; createdBy: string; missionId?: string | null; runId?: string | null; stepId?: string | null }): string {
    const id = newId('cs');
    this.rt.db.run(
      "INSERT INTO change_sets(id, mission_id, run_id, step_id, title, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?)",
      id,
      args.missionId ?? null,
      args.runId ?? null,
      args.stepId ?? null,
      args.title.slice(0, 300),
      args.createdBy,
      nowIso(),
    );
    return id;
  }

  /** The open (proposed) set of a mission step — created on first use so one step yields one reviewable set. */
  forStep(args: { missionId?: string | null; runId?: string | null; stepId: string; title: string; createdBy: string }): string {
    const existing = this.rt.db.get<{ id: string }>("SELECT id FROM change_sets WHERE step_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1", args.stepId);
    return existing?.id ?? this.create(args);
  }

  /** Adds (or replaces) one file change in a proposed set. Never touches the disk. */
  async propose(setId: string, input: ProposeFileInput): Promise<ChangeFileView> {
    const set = this.setRow(setId);
    if (set.status !== 'proposed') throw new AppError('INVALID_STATE_TRANSITION', 'Набор изменений уже применён или отклонён — создайте новый.');
    const src = this.source(input.sourceId);
    const rel = normalizeRelPath(input.path);
    for (const seg of rel.split('/')) if (PROTECTED.has(seg)) throw new AppError('PATH_OUTSIDE_SCOPE', `Изменения в служебной папке «${seg}» запрещены.`);
    if (isSecretFileName(rel)) throw new AppError('PERMISSION_DENIED', 'Изменение файлов с секретами (.env, ключи, учётные данные) не допускается.');
    if (input.op !== 'delete') {
      if (typeof input.content !== 'string') throw new AppError('VALIDATION_FAILED', 'Для создания или изменения файла нужно новое содержимое (content).');
      if (input.content.length > MAX_FILE_CHARS) throw new AppError('FILE_TOO_LARGE', 'Предлагаемое содержимое больше 1 млн символов.');
      if (detectSecretContent(input.content)) throw new AppError('PERMISSION_DENIED', 'Предлагаемое содержимое похоже на секрет (ключ, токен, приватный ключ). Такие изменения не принимаются.');
    }
    const count = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM change_set_files WHERE change_set_id = ?', setId)!.c;
    const replacing = this.rt.db.get<{ id: string }>('SELECT id FROM change_set_files WHERE change_set_id = ? AND source_id = ? AND rel_path = ?', setId, src.id, rel);
    if (!replacing && count >= MAX_FILES_PER_SET) throw new AppError('VALIDATION_FAILED', `В одном наборе не больше ${MAX_FILES_PER_SET} файлов.`);

    let current: { text: string; hash: string } | null = null;
    try {
      const r = await this.rt.fs.readText(join(src.root_path, rel), { roots: [src.root_path], writable: false });
      current = { text: r.text, hash: r.hash };
    } catch (e) {
      if (toAppError(e).code !== 'NOT_FOUND') throw e;
    }
    if (input.op === 'create' && current) throw new AppError('WRITE_CONFLICT', `Файл ${rel} уже существует — предложите изменение (modify), а не создание.`);
    if (input.op !== 'create' && !current) throw new AppError('NOT_FOUND', `Файл ${rel} не найден — его нельзя изменить или удалить.`);

    const baseBlob = current ? this.rt.history.putBlob(current.text) : null;
    const newBlob = input.op === 'delete' ? null : this.rt.history.putBlob(input.content!);
    const newHash = input.op === 'delete' ? null : sha256(input.content!);
    if (input.op === 'modify' && newHash === current?.hash) throw new AppError('VALIDATION_FAILED', `Предлагаемое содержимое ${rel} совпадает с текущим — изменений нет.`);
    const rationale = (input.rationale ?? '').slice(0, 2000);
    let id: string;
    if (replacing) {
      id = replacing.id;
      this.rt.db.run("UPDATE change_set_files SET op = ?, base_hash = ?, base_blob = ?, new_blob = ?, new_hash = ?, rationale = ?, status = 'pending', status_detail = NULL WHERE id = ?", input.op, current?.hash ?? null, baseBlob, newBlob, newHash, rationale, id);
    } else {
      id = newId('csf');
      this.rt.db.run(
        "INSERT INTO change_set_files(id, change_set_id, source_id, rel_path, op, base_hash, base_blob, new_blob, new_hash, rationale, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
        id,
        setId,
        src.id,
        rel,
        input.op,
        current?.hash ?? null,
        baseBlob,
        newBlob,
        newHash,
        rationale,
      );
    }
    this.rt.emit('changes.changed', { changeSetId: setId, missionId: set.mission_id });
    return this.fileView(this.rt.db.get<FileRow>('SELECT * FROM change_set_files WHERE id = ?', id)!, src.name, true);
  }

  private fileView(f: FileRow, sourceName: string, withDiff: boolean): ChangeFileView {
    const before = f.base_blob ? this.rt.history.getBlob(f.base_blob) : null;
    const after = f.new_blob ? this.rt.history.getBlob(f.new_blob) : null;
    const oldText = f.op === 'create' ? null : before;
    const newText = f.op === 'delete' ? null : after;
    const stats = diffStats(diffLines(oldText ?? '', newText ?? ''));
    const diff = withDiff ? unifiedDiff(oldText, newText, f.rel_path) : undefined;
    return {
      id: f.id,
      sourceId: f.source_id,
      sourceName,
      path: f.rel_path,
      op: f.op,
      rationale: f.rationale,
      status: f.status,
      statusDetail: f.status_detail,
      added: stats.added,
      removed: stats.removed,
      ...(diff !== undefined ? { diff } : {}),
    };
  }

  get(id: string, opts: { withDiff?: boolean } = {}): ChangeSetView {
    const s = this.setRow(id);
    const names = new Map<string, SourceRowLite>();
    const files = this.files(id).map((f) => {
      let src = names.get(f.source_id);
      if (!src) {
        src = this.rt.db.get<SourceRowLite>('SELECT id, kind, name, root_path, writable, allow_apply FROM sources WHERE id = ?', f.source_id) ?? { id: f.source_id, kind: 'project', name: '(источник отключён)', root_path: '', writable: 0, allow_apply: 0 };
        names.set(f.source_id, src);
      }
      return this.fileView(f, src.name, opts.withDiff ?? true);
    });
    return {
      id: s.id,
      missionId: s.mission_id,
      runId: s.run_id,
      stepId: s.step_id,
      title: s.title,
      status: s.status,
      createdBy: s.created_by,
      createdAt: s.created_at,
      appliedAt: s.applied_at,
      appliedBy: s.applied_by,
      revertedAt: s.reverted_at,
      report: parseJson(s.report, null),
      files,
      applicable: [...names.values()].map((src) => ({ sourceId: src.id, allowed: src.root_path !== '' && this.applyDenial(src) === null, reason: src.root_path === '' ? 'источник отключён' : this.applyDenial(src) })),
    };
  }

  list(opts: { missionId?: string; status?: ChangeSetStatus; limit?: number } = {}): ChangeSetView[] {
    const where: string[] = [];
    const params: string[] = [];
    if (opts.missionId) {
      where.push('mission_id = ?');
      params.push(opts.missionId);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const rows = this.rt.db.all<{ id: string }>(`SELECT id FROM change_sets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT ?`, ...params, Math.min(opts.limit ?? 100, 500));
    return rows.map((r) => this.get(r.id, { withDiff: false }));
  }

  /** The whole set as one unified diff (for review or for applying manually with `git apply`). */
  patch(id: string): string {
    return this.get(id, { withDiff: true })
      .files.map((f) => f.diff ?? '')
      .join('');
  }

  /**
   * Applies pending files of a set. Each file is checked against the hash it was proposed on: if the file was
   * changed since, it is marked "conflict" and left untouched. Previous content goes to version history.
   */
  async apply(id: string, opts: { actor: string; fileIds?: string[] }): Promise<ChangeSetView> {
    const s = this.setRow(id);
    if (!['proposed', 'partially_applied', 'conflict'].includes(s.status)) throw new AppError('INVALID_STATE_TRANSITION', 'Набор уже применён, отменён или отклонён.');
    const all = this.files(id);
    const targets = all.filter((f) => (f.status === 'pending' || f.status === 'conflict' || f.status === 'failed') && (!opts.fileIds || opts.fileIds.includes(f.id)));
    if (!targets.length) throw new AppError('VALIDATION_FAILED', 'В наборе нет файлов для применения.');
    // permission check for every touched source BEFORE writing anything
    for (const sid of new Set(targets.map((f) => f.source_id))) {
      const src = this.source(sid);
      const denial = this.applyDenial(src);
      if (denial) throw new AppError('APPLY_NOT_ALLOWED', `Нельзя применить набор: ${denial}.`, { details: { sourceId: sid } });
    }
    const touched = new Map<string, string[]>();
    for (const f of targets) {
      const src = this.source(f.source_id);
      const abs = join(src.root_path, f.rel_path);
      const scope = { roots: [src.root_path], writable: true };
      const history = { sourceId: src.id, relPath: f.rel_path, docId: null };
      try {
        if (f.op === 'delete') {
          const cur = await this.rt.fs.readText(abs, { roots: [src.root_path], writable: false }).catch((e) => {
            if (toAppError(e).code === 'NOT_FOUND') return null;
            throw e;
          });
          if (!cur || cur.hash !== f.base_hash) throw new AppError('WRITE_CONFLICT', cur ? 'Файл изменён после предложения.' : 'Файл уже удалён.');
          this.rt.history.snapshot({ ...history, content: cur.text, reason: 'before:changeset-delete', actor: opts.actor });
          const trashed = await this.rt.fs.trash(abs, `${src.kind === 'vault' ? '' : `_projects/${src.id}/`}${f.rel_path}`, this.rt.paths.trashDir, scope);
          this.rt.db.run("UPDATE change_set_files SET status = 'applied', status_detail = NULL, trash_path = ? WHERE id = ?", trashed, f.id);
        } else {
          const content = this.rt.history.getBlob(f.new_blob!);
          if (content === null) throw new AppError('INTEGRITY_CHECK_FAILED', 'Содержимое изменения не найдено в базе.');
          await this.rt.fs.writeText(abs, content, { scope, expectedHash: f.op === 'create' ? null : f.base_hash!, reason: 'changeset', actor: opts.actor, history });
          this.rt.db.run("UPDATE change_set_files SET status = 'applied', status_detail = NULL WHERE id = ?", f.id);
        }
        const list = touched.get(src.id) ?? [];
        list.push(f.rel_path);
        touched.set(src.id, list);
      } catch (e) {
        const err = toAppError(e);
        const status: ChangeFileStatus = err.code === 'WRITE_CONFLICT' ? 'conflict' : 'failed';
        this.rt.db.run('UPDATE change_set_files SET status = ?, status_detail = ? WHERE id = ?', status, err.code === 'WRITE_CONFLICT' ? `Конфликт: ${err.message} Файл не изменён.` : err.message, f.id);
      }
    }
    for (const [sid, paths] of touched) await this.indexer.indexPaths(sid, paths).catch(() => undefined);
    const after = this.files(id);
    const applied = after.filter((f) => f.status === 'applied').length;
    const status: ChangeSetStatus = applied === after.length ? 'applied' : applied > 0 ? 'partially_applied' : 'conflict';
    const report = { applied, conflicts: after.filter((f) => f.status === 'conflict').map((f) => f.rel_path), failed: after.filter((f) => f.status === 'failed').map((f) => ({ path: f.rel_path, error: f.status_detail })) };
    this.rt.db.run('UPDATE change_sets SET status = ?, applied_at = ?, applied_by = ?, report = ? WHERE id = ?', status, nowIso(), opts.actor, JSON.stringify(report), id);
    this.rt.audit.record({ actor: opts.actor, action: 'changeset.apply', target: id, outcome: status === 'conflict' ? 'error' : 'ok', details: report });
    this.rt.emit('changes.changed', { changeSetId: id, missionId: s.mission_id, status });
    this.rt.emit('docs.changed', { changeSetId: id });
    return this.get(id);
  }

  /** Reverts applied files, but only those still unchanged since applying (never clobbers later edits). */
  async revert(id: string, opts: { actor: string }): Promise<ChangeSetView> {
    const s = this.setRow(id);
    if (s.status !== 'applied' && s.status !== 'partially_applied') throw new AppError('INVALID_STATE_TRANSITION', 'Откатить можно только применённый набор.');
    const touched = new Map<string, string[]>();
    let conflicts = 0;
    for (const f of this.files(id).filter((x) => x.status === 'applied')) {
      const src = this.source(f.source_id);
      const abs = join(src.root_path, f.rel_path);
      const scope = { roots: [src.root_path], writable: true };
      const history = { sourceId: src.id, relPath: f.rel_path, docId: null };
      try {
        if (f.op === 'create') {
          const cur = await this.rt.fs.readText(abs, { roots: [src.root_path], writable: false });
          if (cur.hash !== f.new_hash) throw new AppError('WRITE_CONFLICT', 'Файл изменён после применения — откат пропущен.');
          this.rt.history.snapshot({ ...history, content: cur.text, reason: 'before:changeset-revert', actor: opts.actor });
          await this.rt.fs.trash(abs, `${src.kind === 'vault' ? '' : `_projects/${src.id}/`}${f.rel_path}`, this.rt.paths.trashDir, scope);
        } else if (f.op === 'modify') {
          const base = this.rt.history.getBlob(f.base_blob!);
          if (base === null) throw new AppError('INTEGRITY_CHECK_FAILED');
          await this.rt.fs.writeText(abs, base, { scope, expectedHash: f.new_hash!, reason: 'changeset-revert', actor: opts.actor, history });
        } else {
          const base = this.rt.history.getBlob(f.base_blob!);
          if (base === null) throw new AppError('INTEGRITY_CHECK_FAILED');
          await this.rt.fs.writeText(abs, base, { scope, expectedHash: null, reason: 'changeset-revert', actor: opts.actor, history });
        }
        this.rt.db.run("UPDATE change_set_files SET status = 'reverted', status_detail = NULL WHERE id = ?", f.id);
        const list = touched.get(src.id) ?? [];
        list.push(f.rel_path);
        touched.set(src.id, list);
      } catch (e) {
        conflicts++;
        this.rt.db.run('UPDATE change_set_files SET status_detail = ? WHERE id = ?', `Откат не выполнен: ${toAppError(e).message}`, f.id);
      }
    }
    for (const [sid, paths] of touched) await this.indexer.indexPaths(sid, paths).catch(() => undefined);
    if (!conflicts) this.rt.db.run("UPDATE change_sets SET status = 'reverted', reverted_at = ? WHERE id = ?", nowIso(), id);
    this.rt.audit.record({ actor: opts.actor, action: 'changeset.revert', target: id, outcome: conflicts ? 'error' : 'ok', details: { conflicts } });
    this.rt.emit('changes.changed', { changeSetId: id, missionId: s.mission_id });
    this.rt.emit('docs.changed', { changeSetId: id });
    return this.get(id);
  }

  reject(id: string, opts: { actor: string; reason?: string }): ChangeSetView {
    const s = this.setRow(id);
    if (s.status !== 'proposed' && s.status !== 'conflict') throw new AppError('INVALID_STATE_TRANSITION', 'Отклонить можно только неприменённый набор.');
    this.rt.db.run("UPDATE change_sets SET status = 'rejected', report = ? WHERE id = ?", JSON.stringify({ reason: opts.reason ?? null }), id);
    this.rt.db.run("UPDATE change_set_files SET status = 'skipped' WHERE change_set_id = ? AND status IN ('pending','conflict','failed')", id);
    this.rt.audit.record({ actor: opts.actor, action: 'changeset.reject', target: id, details: { reason: opts.reason ?? null } });
    this.rt.emit('changes.changed', { changeSetId: id, missionId: s.mission_id });
    return this.get(id, { withDiff: false });
  }

  /** Text of a proposed file (for verifiers and the review UI). */
  proposedContent(fileId: string): { before: string | null; after: string | null } {
    const f = this.rt.db.get<FileRow>('SELECT * FROM change_set_files WHERE id = ?', fileId);
    if (!f) throw new AppError('NOT_FOUND');
    return { before: f.base_blob ? this.rt.history.getBlob(f.base_blob) : null, after: f.new_blob ? this.rt.history.getBlob(f.new_blob) : null };
  }
}
