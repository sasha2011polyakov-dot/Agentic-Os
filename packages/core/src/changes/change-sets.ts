import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import type { Indexer } from '../index/indexer.ts';
import type { WorkCopyService } from '../security/workcopy.ts';
import type { BackupService } from '../security/backup.ts';
import { normalizeRelPath } from '../fs/guard.ts';
import { detectSecretContent } from '../fs/secrets.ts';
import { analyzeRisks, categorize, modeAtLeast, modeLabel, NEVER_WRITE, CATEGORY_TEXT, type AccessMode, type RiskItem } from '../security/policy.ts';
import { inspectCheck, projectChecks, runCheck, type CheckResult } from '../missions/checks.ts';
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
  categories: string[];
  diff?: string;
}

/** What still stands between the set and the original project, per source (shown on the review screen). */
export interface ApplyGate {
  sourceId: string;
  sourceName: string;
  kind: 'vault' | 'project';
  mode: AccessMode | 'vault';
  modeLabel: string;
  modeAllows: boolean;
  checksConfigured: string[];
  checksPassed: boolean;
  allowed: boolean;
  reasons: string[];
}

export interface Verification {
  hash: string;
  at: string;
  allPassed: boolean;
  results: (Pick<CheckResult, 'name' | 'sourceId' | 'ok' | 'exitCode' | 'timedOut' | 'durationMs' | 'output' | 'isolation' | 'workCopyId'> & { blocked?: string })[];
  notes: string[];
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
  summary: { files: number; create: number; modify: number; delete: number; added: number; removed: number };
  review: { contentHash: string | null; reviewed: boolean; stale: boolean; reviewedAt: string | null; reviewedBy: string | null };
  verification: (Verification & { current: boolean }) | null;
  risks: RiskItem[];
  gates: ApplyGate[];
  backupId: string | null;
  /** Backwards-compatible short form of gates. */
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
  content_hash: string | null;
  reviewed_hash: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  verified_hash: string | null;
  verification: string | null;
  work_copy_id: string | null;
  backup_id: string | null;
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
  access_mode: AccessMode;
}

const MAX_FILE_CHARS = 1_000_000;
const MAX_FILES_PER_SET = 200;
const PROTECTED = new Set(['.git', 'node_modules', '.aos', '.trash']);

/**
 * Change sets (29.2 mode 2 / 29.7): agents only PROPOSE file changes; content is stored separately from the project
 * with the hash of the file it was based on. The user reviews exactly that content; any later change makes the
 * review stale. Changes reach a work copy for checks, and the ORIGINAL project only through `apply`, which requires:
 * mode "Apply to the original project", fresh review, passed checks, confirmed risks and a verified backup.
 */
export class ChangeSetService {
  /** Test hook (fault injection): the write of this relative path fails during apply. */
  simulateWriteFailure: string | null = null;

  constructor(
    private readonly rt: SystemRuntime,
    private readonly indexer: Indexer,
    private readonly workcopies: WorkCopyService,
    private readonly backups: BackupService,
  ) {}

  private source(id: string): SourceRowLite {
    const s = this.rt.db.get<SourceRowLite>('SELECT id, kind, name, root_path, writable, access_mode FROM sources WHERE id = ?', id);
    if (!s) throw new AppError('NOT_FOUND', `Source ${id} was not found in this system.`);
    return s;
  }

  private setRow(id: string): SetRow {
    const r = this.rt.db.get<SetRow>('SELECT * FROM change_sets WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Change set not found.');
    return r;
  }

  private files(setId: string): FileRow[] {
    return this.rt.db.all<FileRow>('SELECT * FROM change_set_files WHERE change_set_id = ? ORDER BY source_id, rel_path', setId);
  }

  /** Hash of the set's effective content (non-skipped files). Reviews and verifications are bound to it. */
  private contentHash(setId: string): string {
    const parts = this.files(setId)
      .filter((f) => f.status !== 'skipped')
      .map((f) => `${f.source_id}|${f.rel_path}|${f.op}|${f.base_hash ?? ''}|${f.new_hash ?? ''}`)
      .sort();
    return sha256(parts.join('\n'));
  }

  private refreshHash(setId: string, actor: string): void {
    const s = this.setRow(setId);
    const hash = this.contentHash(setId);
    this.rt.db.run('UPDATE change_sets SET content_hash = ? WHERE id = ?', hash, setId);
    if (s.reviewed_hash && s.reviewed_hash !== hash) {
      this.rt.security.record({ actor, action: 'review.stale', outcome: 'warning', taskId: s.mission_id ?? setId, message: `The set "${s.title}" changed after the review: the earlier approval is no longer valid, a new review is needed.`, details: { changeSetId: setId } });
    }
  }

  create(args: { title: string; createdBy: string; missionId?: string | null; runId?: string | null; stepId?: string | null }): string {
    const id = newId('cs');
    this.rt.db.run(
      "INSERT INTO change_sets(id, mission_id, run_id, step_id, title, status, created_by, created_at, content_hash) VALUES (?, ?, ?, ?, ?, 'proposed', ?, ?, ?)",
      id,
      args.missionId ?? null,
      args.runId ?? null,
      args.stepId ?? null,
      args.title.slice(0, 300),
      args.createdBy,
      nowIso(),
      sha256(''),
    );
    return id;
  }

  /** The open (proposed) set for a step / change group — created on first use so one unit of work yields one set. */
  forStep(args: { missionId?: string | null; runId?: string | null; stepId: string; title: string; createdBy: string }): string {
    const existing = this.rt.db.get<{ id: string }>("SELECT id FROM change_sets WHERE step_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 1", args.stepId);
    return existing?.id ?? this.create(args);
  }

  /** Adds (or replaces) one file change in a proposed set. Never touches the project. */
  async propose(setId: string, input: ProposeFileInput, actor = 'user'): Promise<ChangeFileView> {
    const set = this.setRow(setId);
    if (set.status !== 'proposed') throw new AppError('INVALID_STATE_TRANSITION', 'The change set was already applied or rejected: create a new one.');
    const src = this.source(input.sourceId);
    const rel = normalizeRelPath(input.path);
    const deny = (message: string, code: 'MODE_FORBIDS' | 'PATH_OUTSIDE_SCOPE' | 'PERMISSION_DENIED') => {
      this.rt.security.record({ actor, action: 'policy.denied', outcome: 'denied', sourceId: src.id, taskId: set.mission_id ?? setId, resources: [rel], message });
      throw new AppError(code, message);
    };
    if (src.kind === 'project' && !modeAtLeast(src.access_mode, 'prepare')) {
      deny(`The project "${src.name}" is in "${modeLabel(src.access_mode)}" mode: preparing changes is not allowed.`, 'MODE_FORBIDS');
    }
    for (const seg of rel.split('/')) if (PROTECTED.has(seg)) deny(`Changes in the service folder "${seg}" are not allowed.`, 'PATH_OUTSIDE_SCOPE');
    const cats = categorize(rel);
    for (const c of cats) if (NEVER_WRITE.includes(c)) deny(`${CATEGORY_TEXT[c].label}: ${CATEGORY_TEXT[c].risk}`, 'PERMISSION_DENIED');
    if (input.op !== 'delete') {
      if (typeof input.content !== 'string') throw new AppError('VALIDATION_FAILED', 'Creating or modifying a file needs the new content (content).');
      if (input.content.length > MAX_FILE_CHARS) throw new AppError('FILE_TOO_LARGE', 'The proposed content is longer than 1 million characters.');
      if (detectSecretContent(input.content)) deny('The proposed content looks like a secret (a key, a token, a private key). Such changes are not accepted.', 'PERMISSION_DENIED');
    }
    const count = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM change_set_files WHERE change_set_id = ?', setId)!.c;
    const replacing = this.rt.db.get<{ id: string }>('SELECT id FROM change_set_files WHERE change_set_id = ? AND source_id = ? AND rel_path = ?', setId, src.id, rel);
    if (!replacing && count >= MAX_FILES_PER_SET) throw new AppError('VALIDATION_FAILED', `No more than ${MAX_FILES_PER_SET} files in one set.`);

    let current: { text: string; hash: string } | null = null;
    try {
      const r = await this.rt.fs.readText(join(src.root_path, rel), { roots: [src.root_path], writable: false });
      current = { text: r.text, hash: r.hash };
    } catch (e) {
      if (toAppError(e).code !== 'NOT_FOUND') throw e;
    }
    if (input.op === 'create' && current) throw new AppError('WRITE_CONFLICT', `The file ${rel} already exists: propose a change (modify), not a creation.`);
    if (input.op !== 'create' && !current) throw new AppError('NOT_FOUND', `The file ${rel} was not found: it cannot be modified or deleted.`);

    const baseBlob = current ? this.rt.history.putBlob(current.text) : null;
    const newBlob = input.op === 'delete' ? null : this.rt.history.putBlob(input.content!);
    const newHash = input.op === 'delete' ? null : sha256(input.content!);
    if (input.op === 'modify' && newHash === current?.hash) throw new AppError('VALIDATION_FAILED', `The proposed content of ${rel} is the same as the current one: there are no changes.`);
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
    this.refreshHash(setId, actor);
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
      categories: categorize(f.rel_path).map((c) => CATEGORY_TEXT[c].label),
      ...(diff !== undefined ? { diff } : {}),
    };
  }

  private dirCounts(sourceId: string): Map<string, number> {
    const m = new Map<string, number>();
    for (const r of this.rt.db.all<{ rel_path: string }>('SELECT rel_path FROM files WHERE source_id = ?', sourceId)) {
      const parts = r.rel_path.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        m.set(dir, (m.get(dir) ?? 0) + 1);
      }
    }
    return m;
  }

  private gates(s: SetRow, files: FileRow[]): ApplyGate[] {
    const verification = parseJson<Verification | null>(s.verification, null);
    const verifiedNow = !!s.verified_hash && s.verified_hash === s.content_hash && !!verification?.allPassed;
    const out: ApplyGate[] = [];
    for (const sid of new Set(files.filter((f) => f.status !== 'skipped').map((f) => f.source_id))) {
      const src = this.rt.db.get<SourceRowLite>('SELECT id, kind, name, root_path, writable, access_mode FROM sources WHERE id = ?', sid);
      if (!src) {
        out.push({ sourceId: sid, sourceName: '(source disconnected)', kind: 'project', mode: 'read_only', modeLabel: '—', modeAllows: false, checksConfigured: [], checksPassed: false, allowed: false, reasons: ['the source is disconnected from the system'] });
        continue;
      }
      const reasons: string[] = [];
      if (src.kind === 'vault') {
        if (!src.writable) reasons.push('the vault is open read only');
        if (s.reviewed_hash !== s.content_hash) reasons.push(s.reviewed_hash ? 'the set changed after the review' : 'the changes were not reviewed');
        out.push({ sourceId: sid, sourceName: src.name, kind: 'vault', mode: 'vault', modeLabel: 'System vault', modeAllows: !!src.writable, checksConfigured: [], checksPassed: true, allowed: reasons.length === 0, reasons });
        continue;
      }
      const required = projectChecks(this.rt, sid).filter((c) => c.required !== false).map((c) => c.name);
      const modeAllows = src.access_mode === 'apply';
      if (!modeAllows) reasons.push(`the project mode "${modeLabel(src.access_mode)}" does not allow applying to the original files`);
      if (s.reviewed_hash !== s.content_hash) reasons.push(s.reviewed_hash ? 'the set changed after the review: a new review is needed' : 'the changes were not reviewed');
      const checksPassed = !required.length || verifiedNow;
      if (!checksPassed) reasons.push(verification && s.verified_hash === s.content_hash ? 'the checks in the work copy failed' : `the checks (${required.join(', ')}) must pass in a work copy for the current content`);
      out.push({ sourceId: sid, sourceName: src.name, kind: 'project', mode: src.access_mode, modeLabel: modeLabel(src.access_mode), modeAllows, checksConfigured: required, checksPassed, allowed: reasons.length === 0, reasons });
    }
    return out;
  }

  get(id: string, opts: { withDiff?: boolean } = {}): ChangeSetView {
    const s = this.setRow(id);
    const all = this.files(id);
    const names = new Map<string, string>();
    const files = all.map((f) => {
      if (!names.has(f.source_id)) names.set(f.source_id, this.rt.db.get<{ name: string }>('SELECT name FROM sources WHERE id = ?', f.source_id)?.name ?? '(source disconnected)');
      return this.fileView(f, names.get(f.source_id)!, opts.withDiff ?? true);
    });
    const active = all.filter((f) => f.status !== 'skipped');
    const risks: RiskItem[] = [];
    for (const sid of new Set(active.map((f) => f.source_id))) {
      const src = this.rt.db.get<SourceRowLite>('SELECT id, kind, name, root_path, writable, access_mode FROM sources WHERE id = ?', sid);
      const own = active.filter((f) => f.source_id === sid).map((f) => ({ path: f.rel_path, op: f.op }));
      for (const r of analyzeRisks(own, { original: src?.kind === 'project', dirFileCounts: this.dirCounts(sid) })) risks.push({ ...r, id: `${sid}:${r.id}` });
    }
    const verification = parseJson<Verification | null>(s.verification, null);
    const gates = this.gates(s, all);
    const sum = (op: ChangeOp) => active.filter((f) => f.op === op).length;
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
      summary: { files: active.length, create: sum('create'), modify: sum('modify'), delete: sum('delete'), added: files.filter((f) => f.status !== 'skipped').reduce((a, f) => a + f.added, 0), removed: files.filter((f) => f.status !== 'skipped').reduce((a, f) => a + f.removed, 0) },
      review: { contentHash: s.content_hash, reviewed: !!s.reviewed_hash && s.reviewed_hash === s.content_hash, stale: !!s.reviewed_hash && s.reviewed_hash !== s.content_hash, reviewedAt: s.reviewed_at, reviewedBy: s.reviewed_by },
      verification: verification ? { ...verification, current: s.verified_hash === s.content_hash } : null,
      risks,
      gates,
      backupId: s.backup_id,
      applicable: gates.map((g) => ({ sourceId: g.sourceId, allowed: g.allowed, reason: g.reasons[0] ?? null })),
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

  /** The whole set as one unified diff (review, or applying manually with `git apply`). Export is logged. */
  patch(id: string, actor = 'user'): string {
    const view = this.get(id, { withDiff: true });
    this.rt.security.record({ actor, action: 'patch.export', outcome: 'ok', taskId: view.missionId ?? id, resources: view.files.filter((f) => f.status !== 'skipped').map((f) => f.path), message: `Exported the patch of the set "${view.title}"` });
    return view.files
      .filter((f) => f.status !== 'skipped')
      .map((f) => f.diff ?? '')
      .join('');
  }

  /** The user confirms they reviewed exactly the current content (29.7). */
  review(id: string, actor = 'user'): ChangeSetView {
    const s = this.setRow(id);
    if (s.status !== 'proposed' && s.status !== 'conflict' && s.status !== 'partially_applied') throw new AppError('INVALID_STATE_TRANSITION', 'The set was already applied or rejected.');
    const hash = this.contentHash(id);
    this.rt.db.run('UPDATE change_sets SET content_hash = ?, reviewed_hash = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?', hash, hash, nowIso(), actor, id);
    this.rt.security.record({ actor, action: 'review.approve', outcome: 'ok', taskId: s.mission_id ?? id, resources: this.files(id).filter((f) => f.status !== 'skipped').map((f) => f.rel_path), message: `The set "${s.title}" was reviewed and marked as checked`, details: { contentHash: hash } });
    this.rt.emit('changes.changed', { changeSetId: id, missionId: s.mission_id });
    return this.get(id);
  }

  /** "Reject selected changes": the files are excluded; the review must be repeated for the rest. */
  rejectFiles(id: string, fileIds: string[], actor = 'user'): ChangeSetView {
    const s = this.setRow(id);
    if (s.status !== 'proposed' && s.status !== 'conflict') throw new AppError('INVALID_STATE_TRANSITION', 'Files can be rejected only in a set that is not applied.');
    for (const f of fileIds) this.rt.db.run("UPDATE change_set_files SET status = 'skipped', status_detail = 'rejected by the user' WHERE id = ? AND change_set_id = ?", f, id);
    this.refreshHash(id, actor);
    this.rt.audit.record({ actor, action: 'changeset.reject_files', target: id, details: { fileIds } });
    this.rt.emit('changes.changed', { changeSetId: id, missionId: s.mission_id });
    return this.get(id);
  }

  /** Proposed + base content of all active files (for applying to work copies, reviewers, verifiers). */
  contents(id: string): { sourceId: string; path: string; op: ChangeOp; content: string | null; base: string | null }[] {
    return this.files(id)
      .filter((f) => f.status !== 'skipped')
      .map((f) => ({ sourceId: f.source_id, path: f.rel_path, op: f.op, content: f.new_blob ? this.rt.history.getBlob(f.new_blob) : null, base: f.base_blob ? this.rt.history.getBlob(f.base_blob) : null }));
  }

  /** What each project check of the set would execute (shown before running, with risk findings). */
  async checkPlan(id: string, actor = 'user'): Promise<{ sourceId: string; workCopyId: string; checks: { name: string; required: boolean; autoRun: boolean; findings: unknown[]; executes: unknown[]; contentHash: string; notes: string[] }[] }[]> {
    const out = [];
    for (const sid of new Set(this.contents(id).map((f) => f.sourceId))) {
      const src = this.source(sid);
      if (src.kind !== 'project') continue;
      const wc = await this.applyToWorkCopy(id, sid, actor);
      const checks = [];
      for (const def of projectChecks(this.rt, sid)) {
        const { vetting } = await inspectCheck(this.rt, sid, def.name, wc.rootPath);
        checks.push({ name: def.name, required: def.required !== false, autoRun: vetting.autoRun, findings: vetting.findings, executes: vetting.executes, contentHash: vetting.contentHash, notes: vetting.notes });
      }
      out.push({ sourceId: sid, workCopyId: wc.id, checks });
    }
    return out;
  }

  /**
   * Brings the set's files of one project into the project's work copy (created on first use, never the original).
   * Requires mode "Work in a copy" or higher — enforced by WorkCopyService.create.
   */
  async applyToWorkCopy(setId: string, sourceId: string, actor: string): Promise<{ id: string; rootPath: string }> {
    const s = this.setRow(setId);
    const existing = this.workcopies.current(sourceId, s.mission_id);
    const wc = existing && existing.status !== 'error' ? existing : await this.workcopies.create(sourceId, { missionId: s.mission_id, actor });
    const own = this.contents(setId).filter((f) => f.sourceId === sourceId);
    await this.workcopies.applySet(wc.id, own.map((f) => ({ path: f.path, op: f.op, content: f.content })), { changeSetId: setId, actor, missionId: s.mission_id });
    this.rt.db.run('UPDATE change_sets SET work_copy_id = ? WHERE id = ?', wc.id, setId);
    return { id: wc.id, rootPath: wc.rootPath };
  }

  /** Work copy of a project for a mission, with the mission's current proposals applied (used before agent checks). */
  async syncMissionWorkCopy(missionId: string, sourceId: string, actor: string): Promise<{ id: string; rootPath: string }> {
    const set = this.rt.db.get<{ id: string }>("SELECT s.id FROM change_sets s WHERE s.mission_id = ? AND s.status = 'proposed' AND EXISTS (SELECT 1 FROM change_set_files f WHERE f.change_set_id = s.id AND f.source_id = ?) ORDER BY s.created_at DESC LIMIT 1", missionId, sourceId);
    if (set) return this.applyToWorkCopy(set.id, sourceId, actor);
    const existing = this.workcopies.current(sourceId, missionId);
    const wc = existing && existing.status !== 'error' ? existing : await this.workcopies.create(sourceId, { missionId, actor });
    return { id: wc.id, rootPath: wc.rootPath };
  }

  /**
   * "Check again": applies the set to a work copy and runs the project's checks there. The original
   * project is not touched. The result is bound to the current content hash.
   */
  async verifyInWorkCopy(id: string, opts: { actor: string; approvedScripts?: Record<string, string>; signal?: AbortSignal }): Promise<ChangeSetView> {
    const s = this.setRow(id);
    if (s.status !== 'proposed' && s.status !== 'conflict') throw new AppError('INVALID_STATE_TRANSITION', 'Only a set that is not applied can be checked.');
    const hash = this.contentHash(id);
    const results: Verification['results'] = [];
    const notes: string[] = [];
    for (const sid of new Set(this.contents(id).map((f) => f.sourceId))) {
      const src = this.source(sid);
      if (src.kind !== 'project') continue;
      const wc = await this.applyToWorkCopy(id, sid, opts.actor);
      const defs = projectChecks(this.rt, sid);
      if (!defs.length) notes.push(`No checks are configured for the project "${src.name}": the correctness of the changes is not confirmed automatically.`);
      for (const def of defs) {
        try {
          const r = await runCheck(this.rt, sid, def.name, { workCopy: wc, actor: opts.actor, runId: s.mission_id ?? id, approvedContentHash: opts.approvedScripts?.[`${sid}:${def.name}`] ?? null, ...(opts.signal ? { signal: opts.signal } : {}) });
          results.push({ name: r.name, sourceId: sid, ok: r.ok || def.required === false, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, output: r.output, isolation: r.isolation, workCopyId: wc.id });
        } catch (e) {
          const err = toAppError(e);
          results.push({ name: def.name, sourceId: sid, ok: def.required === false, exitCode: null, timedOut: false, durationMs: 0, output: '', isolation: { level: 'limited', tool: null, network: 'not_blocked', files: '—', limits: [], notes: [] }, workCopyId: wc.id, blocked: err.message });
        }
      }
    }
    const verification: Verification = { hash, at: nowIso(), allPassed: results.every((r) => r.ok), results, notes };
    this.rt.db.run('UPDATE change_sets SET content_hash = ?, verified_hash = ?, verification = ? WHERE id = ?', hash, verification.allPassed ? hash : null, JSON.stringify(verification), id);
    this.rt.emit('changes.changed', { changeSetId: id, missionId: s.mission_id });
    return this.get(id);
  }

  /**
   * Applies reviewed files to the ORIGINAL sources. Every gate is checked before anything is written; a verified
   * backup of the affected files is taken first; a write error stops the operation without "repair" attempts.
   */
  async apply(id: string, opts: { actor: string; fileIds?: string[]; confirmRisks?: string[] }): Promise<ChangeSetView> {
    const s = this.setRow(id);
    if (!['proposed', 'partially_applied', 'conflict'].includes(s.status)) throw new AppError('INVALID_STATE_TRANSITION', 'The set was already applied, reverted or rejected.');
    const all = this.files(id);
    const targets = all.filter((f) => (f.status === 'pending' || f.status === 'conflict' || f.status === 'failed') && (!opts.fileIds || opts.fileIds.includes(f.id)));
    if (!targets.length) throw new AppError('VALIDATION_FAILED', 'The set has no files to apply.');
    const hash = this.contentHash(id);
    if (hash !== s.content_hash) this.rt.db.run('UPDATE change_sets SET content_hash = ? WHERE id = ?', hash, id);
    const view = this.get(id, { withDiff: false });
    const deny = (code: 'MODE_FORBIDS' | 'REVIEW_REQUIRED' | 'REVIEW_STALE' | 'CHECKS_REQUIRED' | 'CONFIRMATION_REQUIRED', message: string, details?: unknown) => {
      this.rt.security.record({ actor: opts.actor, action: 'files.apply', outcome: 'denied', taskId: s.mission_id ?? id, resources: targets.map((t) => t.rel_path), message: `Applying was blocked: ${message}` });
      throw new AppError(code, message, details ? { details } : undefined);
    };
    // 1. every gate for every touched source, before writing anything
    for (const g of view.gates.filter((x) => targets.some((t) => t.source_id === x.sourceId))) {
      if (!g.modeAllows) deny('MODE_FORBIDS', g.kind === 'vault' ? 'The vault is open read only.' : `The project "${g.sourceName}" is in "${g.modeLabel}" mode: applying to the original files is not allowed.`);
    }
    if (!view.review.reviewed) deny(view.review.stale ? 'REVIEW_STALE' : 'REVIEW_REQUIRED', view.review.stale ? 'The set changed after the review: review the changes again.' : 'Review the changes first and mark the set as checked.');
    for (const g of view.gates.filter((x) => targets.some((t) => t.source_id === x.sourceId))) {
      if (!g.checksPassed) deny('CHECKS_REQUIRED', `Project "${g.sourceName}": the changes must pass the checks (${g.checksConfigured.join(', ')}) in a work copy.`);
    }
    const targetRisks = view.risks.filter((r) => r.files.some((p) => targets.some((t) => t.rel_path === p && r.id.startsWith(`${t.source_id}:`))));
    const missing = targetRisks.filter((r) => !(opts.confirmRisks ?? []).includes(r.id));
    if (missing.length) deny('CONFIRMATION_REQUIRED', `A separate confirmation is required: ${missing.map((r) => r.title).join('; ')}.`, { risks: missing });
    if (targetRisks.length) this.rt.security.record({ actor: opts.actor, action: 'confirm.risky', outcome: 'ok', taskId: s.mission_id ?? id, resources: targetRisks.flatMap((r) => r.files), message: `Risky changes were confirmed: ${targetRisks.map((r) => r.title).join('; ')}` });

    // 2. conflicts: the original must still be what the proposal was based on
    const conflicts: string[] = [];
    for (const f of targets) {
      const src = this.source(f.source_id);
      let cur: string | null = null;
      let notFile = false;
      try {
        cur = sha256(await readFile(join(src.root_path, ...f.rel_path.split('/'))));
      } catch (e) {
        notFile = (e as NodeJS.ErrnoException).code === 'EISDIR';
        cur = null;
      }
      const expected = f.op === 'create' ? null : f.base_hash;
      if (cur !== expected || notFile) {
        conflicts.push(f.rel_path);
        this.rt.db.run("UPDATE change_set_files SET status = 'conflict', status_detail = ? WHERE id = ?", notFile ? 'There is a folder where the file should be.' : cur === null ? 'The file was deleted after the change was prepared.' : f.op === 'create' ? 'A file with this name has appeared.' : 'The file changed after the change was prepared.', f.id);
      }
    }
    if (conflicts.length) {
      this.rt.db.run("UPDATE change_sets SET status = 'conflict' WHERE id = ?", id);
      this.rt.security.record({ actor: opts.actor, action: 'files.apply', outcome: 'denied', taskId: s.mission_id ?? id, resources: conflicts, message: `Applying was stopped: files changed after the changes were prepared (${conflicts.length}). Nothing was written.` });
      throw new AppError('WRITE_CONFLICT', `Files changed after the changes were prepared: ${conflicts.join(', ')}. Nothing was written: prepare the changes again or exclude these files.`, { details: { conflicts } });
    }

    // 3. verified backup per project (vault files are covered by version history)
    const backupIds: string[] = [];
    for (const sid of new Set(targets.map((t) => t.source_id))) {
      const src = this.source(sid);
      if (src.kind !== 'project') continue;
      const b = await this.backups.create({ sourceId: sid, paths: targets.filter((t) => t.source_id === sid).map((t) => t.rel_path), changeSetId: id, missionId: s.mission_id, actor: opts.actor });
      backupIds.push(b.id);
    }
    if (backupIds.length) this.rt.db.run('UPDATE change_sets SET backup_id = ? WHERE id = ?', backupIds[0]!, id);

    // 4. write; stop at the first failure and report the actual state (no automatic destructive repair)
    const touched = new Map<string, string[]>();
    const appliedHashes = new Map<string, { path: string; hash: string | null }[]>();
    let failure: { path: string; message: string } | null = null;
    for (const f of targets) {
      const src = this.source(f.source_id);
      const abs = join(src.root_path, f.rel_path);
      const scope = { roots: [src.root_path], writable: true };
      const history = { sourceId: src.id, relPath: f.rel_path, docId: null };
      try {
        if (this.simulateWriteFailure === f.rel_path) throw new AppError('SOURCE_NOT_ACCESSIBLE', 'Disk write error (simulated for tests).');
        if (f.op === 'delete') {
          const cur = await this.rt.fs.readText(abs, { roots: [src.root_path], writable: false });
          this.rt.history.snapshot({ ...history, content: cur.text, reason: 'before:changeset-delete', actor: opts.actor });
          const trashed = await this.rt.fs.trash(abs, `${src.kind === 'vault' ? '' : `_projects/${src.id}/`}${f.rel_path}`, this.rt.paths.trashDir, scope);
          this.rt.db.run("UPDATE change_set_files SET status = 'applied', status_detail = NULL, trash_path = ? WHERE id = ?", trashed, f.id);
        } else {
          const content = this.rt.history.getBlob(f.new_blob!);
          if (content === null) throw new AppError('INTEGRITY_CHECK_FAILED', 'The content of the change was not found in the database.');
          await this.rt.fs.writeText(abs, content, { scope, expectedHash: f.op === 'create' ? null : f.base_hash!, reason: 'changeset', actor: opts.actor, history });
          this.rt.db.run("UPDATE change_set_files SET status = 'applied', status_detail = NULL WHERE id = ?", f.id);
        }
        touched.set(src.id, [...(touched.get(src.id) ?? []), f.rel_path]);
        appliedHashes.set(src.id, [...(appliedHashes.get(src.id) ?? []), { path: f.rel_path, hash: f.op === 'delete' ? null : f.new_hash }]);
      } catch (e) {
        const err = toAppError(e);
        this.rt.db.run("UPDATE change_set_files SET status = ?, status_detail = ? WHERE id = ?", err.code === 'WRITE_CONFLICT' ? 'conflict' : 'failed', err.message, f.id);
        failure = { path: f.rel_path, message: err.message };
        break;
      }
    }
    for (const bid of backupIds) {
      const b = this.backups.get(bid);
      this.backups.recordApplied(bid, appliedHashes.get(b.sourceId) ?? []);
    }
    for (const [sid, paths] of touched) await this.indexer.indexPaths(sid, paths).catch(() => undefined);
    const after = this.files(id);
    const applied = after.filter((f) => f.status === 'applied').length;
    const activeCount = after.filter((f) => f.status !== 'skipped').length;
    const status: ChangeSetStatus = applied === activeCount ? 'applied' : applied > 0 ? 'partially_applied' : 'conflict';
    const report = { applied, written: [...touched.values()].flat(), failed: failure, backups: backupIds, notApplied: after.filter((f) => f.status !== 'applied' && f.status !== 'skipped').map((f) => f.rel_path) };
    this.rt.db.run('UPDATE change_sets SET status = ?, applied_at = ?, applied_by = ?, report = ? WHERE id = ?', status, nowIso(), opts.actor, JSON.stringify(report), id);
    this.rt.audit.record({ actor: opts.actor, action: 'changeset.apply', target: id, outcome: failure ? 'error' : 'ok', details: report });
    this.rt.security.record({
      actor: opts.actor,
      action: 'files.apply',
      outcome: failure ? 'error' : 'ok',
      taskId: s.mission_id ?? id,
      resources: report.written,
      message: failure
        ? `Applying stopped at the file ${failure.path}: ${failure.message}. ${applied} files were written; the original state is saved in a backup, and you can restore it in "Backups".`
        : `Applied to the original files: ${applied}. Backup: ${backupIds.join(', ') || 'the vault version history'}.`,
      details: report,
    });
    this.rt.emit('changes.changed', { changeSetId: id, missionId: s.mission_id, status });
    this.rt.emit('docs.changed', { changeSetId: id });
    return this.get(id);
  }

  /**
   * Reverts applied files. Projects: restore from the verified backup (files edited after applying are only
   * overwritten with explicit confirmation). Vault: restore previous content where unchanged since applying.
   */
  async revert(id: string, opts: { actor: string; confirmOverwrite?: boolean }): Promise<ChangeSetView> {
    const s = this.setRow(id);
    if (s.status !== 'applied' && s.status !== 'partially_applied') throw new AppError('INVALID_STATE_TRANSITION', 'Only an applied set can be reverted.');
    const report = parseJson<{ backups?: string[] }>(s.report, {});
    for (const bid of report.backups ?? []) await this.backups.restore(bid, { actor: opts.actor, ...(opts.confirmOverwrite ? { confirmOverwrite: true } : {}) });
    const touched = new Map<string, string[]>();
    let conflicts = 0;
    for (const f of this.files(id).filter((x) => x.status === 'applied')) {
      const src = this.source(f.source_id);
      if (src.kind === 'project') {
        this.rt.db.run("UPDATE change_set_files SET status = 'reverted', status_detail = 'restored from the backup' WHERE id = ?", f.id);
        touched.set(src.id, [...(touched.get(src.id) ?? []), f.rel_path]);
        continue;
      }
      const abs = join(src.root_path, f.rel_path);
      const scope = { roots: [src.root_path], writable: true };
      const history = { sourceId: src.id, relPath: f.rel_path, docId: null };
      try {
        if (f.op === 'create') {
          const cur = await this.rt.fs.readText(abs, { roots: [src.root_path], writable: false });
          if (cur.hash !== f.new_hash) throw new AppError('WRITE_CONFLICT', 'The file changed after it was applied: the revert was skipped.');
          this.rt.history.snapshot({ ...history, content: cur.text, reason: 'before:changeset-revert', actor: opts.actor });
          await this.rt.fs.trash(abs, f.rel_path, this.rt.paths.trashDir, scope);
        } else {
          const base = this.rt.history.getBlob(f.base_blob!);
          if (base === null) throw new AppError('INTEGRITY_CHECK_FAILED');
          await this.rt.fs.writeText(abs, base, { scope, expectedHash: f.op === 'modify' ? f.new_hash! : null, reason: 'changeset-revert', actor: opts.actor, history });
        }
        this.rt.db.run("UPDATE change_set_files SET status = 'reverted', status_detail = NULL WHERE id = ?", f.id);
        touched.set(src.id, [...(touched.get(src.id) ?? []), f.rel_path]);
      } catch (e) {
        conflicts++;
        this.rt.db.run('UPDATE change_set_files SET status_detail = ? WHERE id = ?', `The revert failed: ${toAppError(e).message}`, f.id);
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
    if (s.status !== 'proposed' && s.status !== 'conflict') throw new AppError('INVALID_STATE_TRANSITION', 'Only a set that is not applied can be rejected.');
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
