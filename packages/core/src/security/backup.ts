import { chmod, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import { assertInScope, isInside, normalizeRelPath } from '../fs/guard.ts';
import { atomicWrite } from '../fs/safe-fs.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { sha256 } from '../util/hash.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';

export interface BackupFile {
  path: string;
  existed: boolean;
  sha256: string | null;
  size: number;
  /** Hash written to the original by the operation (recorded after applying), for restore safety. */
  appliedHash?: string | null;
}

export interface BackupInfo {
  id: string;
  sourceId: string;
  changeSetId: string | null;
  missionId: string | null;
  path: string;
  status: 'creating' | 'verified' | 'failed' | 'restored' | 'pruned';
  files: BackupFile[];
  createdAt: string;
  verifiedAt: string | null;
  restoredAt: string | null;
  error: string | null;
}

interface Row {
  id: string;
  source_id: string;
  change_set_id: string | null;
  mission_id: string | null;
  path: string;
  status: BackupInfo['status'];
  files: string;
  created_at: string;
  verified_at: string | null;
  restored_at: string | null;
  error: string | null;
}

/**
 * Verified restore points for files of an ORIGINAL project, taken before changes are applied (29.8). Stored in
 * the application data folder — outside the project and outside work copies — with read-only files and a
 * manifest of SHA-256 hashes. A backup that cannot be written AND re-verified blocks the operation.
 */
export class BackupService {
  /** Test hook: makes the next create() fail (simulates a full disk / permission problem). */
  failNextCreate: string | null = null;

  constructor(private readonly rt: SystemRuntime) {}

  root(): string {
    return join(this.rt.app.paths.backupsDir, this.rt.systemId, 'changes');
  }

  private source(id: string): { id: string; root_path: string; name: string } {
    const s = this.rt.db.get<{ id: string; root_path: string; name: string }>('SELECT id, root_path, name FROM sources WHERE id = ?', id);
    if (!s) throw new AppError('NOT_FOUND', 'Project not found.');
    return s;
  }

  private view(r: Row): BackupInfo {
    return { id: r.id, sourceId: r.source_id, changeSetId: r.change_set_id, missionId: r.mission_id, path: r.path, status: r.status, files: parseJson(r.files, []), createdAt: r.created_at, verifiedAt: r.verified_at, restoredAt: r.restored_at, error: r.error };
  }

  get(id: string): BackupInfo {
    const r = this.rt.db.get<Row>('SELECT * FROM change_backups WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Backup not found.');
    return this.view(r);
  }

  list(f: { sourceId?: string; limit?: number } = {}): BackupInfo[] {
    const rows = f.sourceId ? this.rt.db.all<Row>('SELECT * FROM change_backups WHERE source_id = ? ORDER BY created_at DESC LIMIT ?', f.sourceId, f.limit ?? 200) : this.rt.db.all<Row>('SELECT * FROM change_backups ORDER BY created_at DESC LIMIT ?', f.limit ?? 200);
    return rows.map((r) => this.view(r));
  }

  /** Copies the current state of `paths` (files that do not exist are recorded as such) and verifies the copy. */
  async create(args: { sourceId: string; paths: string[]; changeSetId?: string | null; missionId?: string | null; actor: string }): Promise<BackupInfo> {
    const src = this.source(args.sourceId);
    const id = newId('bkp');
    const dir = join(this.root(), id);
    const now = nowIso();
    this.rt.db.run("INSERT INTO change_backups(id, source_id, change_set_id, mission_id, path, status, files, created_at) VALUES (?, ?, ?, ?, ?, 'creating', '[]', ?)", id, src.id, args.changeSetId ?? null, args.missionId ?? null, dir, now);
    const files: BackupFile[] = [];
    try {
      if (this.failNextCreate) {
        const reason = this.failNextCreate;
        this.failNextCreate = null;
        throw new Error(reason);
      }
      await mkdir(join(dir, 'files'), { recursive: true });
      for (const raw of [...new Set(args.paths)]) {
        const rel = normalizeRelPath(raw);
        const abs = await assertInScope(join(src.root_path, rel), { roots: [src.root_path], writable: false });
        let buf: Buffer | null = null;
        try {
          buf = await readFile(abs);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'EISDIR') throw new Error(`there is a folder where the file ${rel} should be`);
          if (code !== 'ENOENT') throw e;
        }
        if (buf) {
          const target = join(dir, 'files', ...rel.split('/'));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, buf, { flag: 'wx' }); // never overwrite an existing backup file
          await chmod(target, 0o444);
          files.push({ path: rel, existed: true, sha256: sha256(buf), size: buf.length });
        } else files.push({ path: rel, existed: false, sha256: null, size: 0 });
      }
      const manifest = { format: 1, id, systemId: this.rt.systemId, sourceId: src.id, sourceName: src.name, sourceRoot: src.root_path, changeSetId: args.changeSetId ?? null, missionId: args.missionId ?? null, createdAt: now, files };
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
      await chmod(join(dir, 'manifest.json'), 0o444);
      this.rt.db.run('UPDATE change_backups SET files = ? WHERE id = ?', JSON.stringify(files), id);
      const check = await this.verify(id);
      if (!check.ok) throw new Error(`the integrity check failed: ${check.problems.join('; ')}`);
      this.rt.security.record({ actor: args.actor, action: 'backup.create', outcome: 'ok', sourceId: src.id, taskId: args.missionId ?? args.changeSetId ?? null, resources: files.map((f) => f.path), message: `A backup of ${files.length} files was created and verified`, details: { backupId: id } });
      return this.get(id);
    } catch (e) {
      const appErr = toAppError(e);
      const msg = appErr.message;
      this.rt.db.run("UPDATE change_backups SET status = 'failed', error = ? WHERE id = ?", msg, id);
      await this.removeDir(dir).catch(() => undefined);
      // a path that escapes the project is a security violation, not a storage problem: report it as such
      if (appErr.code === 'PATH_OUTSIDE_SCOPE' || appErr.code === 'PATH_INVALID') {
        this.rt.security.record({ actor: args.actor, action: 'path.denied', outcome: 'denied', sourceId: src.id, taskId: args.missionId ?? args.changeSetId ?? null, resources: args.paths.slice(0, 50), message: `The operation was stopped: a path leaves the project (${msg}).` });
        throw appErr;
      }
      this.rt.security.record({ actor: args.actor, action: 'backup.create', outcome: 'error', sourceId: src.id, taskId: args.missionId ?? args.changeSetId ?? null, resources: args.paths.slice(0, 50), message: `The backup was not created: ${msg}. The operation was blocked.` });
      throw new AppError('BACKUP_FAILED', `Could not create a verified backup: ${msg}. No changes were applied.`, { details: { backupId: id } });
    }
  }

  /** Re-reads every stored file and compares SHA-256 with the manifest. */
  async verify(id: string): Promise<{ ok: boolean; problems: string[] }> {
    const b = this.get(id);
    const problems: string[] = [];
    let manifest: { files?: BackupFile[] } | null = null;
    try {
      manifest = JSON.parse(await readFile(join(b.path, 'manifest.json'), 'utf8')) as { files?: BackupFile[] };
    } catch {
      problems.push('the manifest cannot be read');
    }
    const files = manifest?.files ?? [];
    if (files.length !== b.files.length) problems.push('the manifest does not match the database record');
    for (const f of files) {
      if (!f.existed) continue;
      try {
        const buf = await readFile(join(b.path, 'files', ...f.path.split('/')));
        if (sha256(buf) !== f.sha256) problems.push(`${f.path}: the checksum does not match`);
      } catch {
        problems.push(`${f.path}: the backup file is missing`);
      }
    }
    if (!problems.length && b.status === 'creating') this.rt.db.run("UPDATE change_backups SET status = 'verified', verified_at = ? WHERE id = ?", nowIso(), id);
    return { ok: problems.length === 0, problems };
  }

  /** Records what the operation wrote, so a later restore can tell user edits from the operation's own changes. */
  recordApplied(id: string, applied: { path: string; hash: string | null }[]): void {
    const b = this.get(id);
    const map = new Map(applied.map((a) => [a.path, a.hash]));
    const files = b.files.map((f) => (map.has(f.path) ? { ...f, appliedHash: map.get(f.path) ?? null } : f));
    this.rt.db.run('UPDATE change_backups SET files = ? WHERE id = ?', JSON.stringify(files), id);
  }

  /** Files whose current content differs from what the operation wrote (edited afterwards by the user). */
  async changedSinceApply(id: string): Promise<string[]> {
    const b = this.get(id);
    const src = this.source(b.sourceId);
    const out: string[] = [];
    for (const f of b.files) {
      if (f.appliedHash === undefined) continue;
      let cur: string | null = null;
      try {
        cur = sha256(await readFile(join(src.root_path, ...f.path.split('/'))));
      } catch {
        cur = null;
      }
      if (cur !== f.appliedHash) out.push(f.path);
    }
    return out;
  }

  /**
   * Restores files to their backed-up state. The current state is backed up first (restore is reversible);
   * files edited after the operation are only overwritten with explicit confirmation.
   */
  async restore(id: string, opts: { actor: string; confirmOverwrite?: boolean }): Promise<{ restored: string[]; removed: string[]; safetyBackupId: string }> {
    const b = this.get(id);
    if (b.status !== 'verified' && b.status !== 'restored') throw new AppError('INVALID_STATE_TRANSITION', 'This backup cannot be used for a restore.');
    const integrity = await this.verify(id);
    if (!integrity.ok) throw new AppError('INTEGRITY_CHECK_FAILED', `The backup is damaged: ${integrity.problems.join('; ')}. The project files were not changed.`);
    const edited = await this.changedSinceApply(id);
    if (edited.length && !opts.confirmOverwrite) {
      throw new AppError('CONFIRMATION_REQUIRED', `Files changed after the changes were applied: ${edited.join(', ')}. The restore will overwrite these edits (the current state will be saved in a separate backup).`, { details: { edited } });
    }
    const src = this.source(b.sourceId);
    const safety = await this.create({ sourceId: b.sourceId, paths: b.files.map((f) => f.path), changeSetId: b.changeSetId, missionId: b.missionId, actor: opts.actor });
    const restored: string[] = [];
    const removed: string[] = [];
    const scope = { roots: [src.root_path], writable: true };
    for (const f of b.files) {
      const abs = join(src.root_path, ...f.path.split('/'));
      if (f.existed) {
        const buf = await readFile(join(b.path, 'files', ...f.path.split('/')));
        const real = await assertInScope(abs, scope, { write: true });
        await atomicWrite(real, buf);
        restored.push(f.path);
      } else {
        try {
          await stat(abs);
          await this.rt.fs.trash(abs, `_restore/${b.sourceId}/${f.path}`, this.rt.paths.trashDir, scope);
          removed.push(f.path);
        } catch {
          // already absent
        }
      }
    }
    this.rt.db.run("UPDATE change_backups SET status = 'restored', restored_at = ? WHERE id = ?", nowIso(), id);
    this.rt.security.record({ actor: opts.actor, action: 'backup.restore', outcome: 'ok', sourceId: b.sourceId, taskId: b.missionId ?? b.changeSetId, resources: [...restored, ...removed], message: `Restored ${restored.length} files, removed ${removed.length} created files (to the system trash)`, details: { backupId: id, safetyBackupId: safety.id } });
    return { restored, removed, safetyBackupId: safety.id };
  }

  /** Retention: keeps the newest `keep` restore points per project; older ones are removed from disk. */
  async prune(keep: number, actor = 'system'): Promise<number> {
    let removed = 0;
    for (const s of this.rt.db.all<{ source_id: string }>('SELECT DISTINCT source_id FROM change_backups')) {
      const old = this.rt.db.all<Row>("SELECT * FROM change_backups WHERE source_id = ? AND status IN ('verified','restored','failed') ORDER BY created_at DESC LIMIT -1 OFFSET ?", s.source_id, Math.max(1, keep));
      for (const r of old) {
        await this.removeDir(r.path);
        this.rt.db.run("UPDATE change_backups SET status = 'pruned' WHERE id = ?", r.id);
        removed++;
      }
    }
    if (removed) this.rt.security.record({ actor, action: 'backup.prune', outcome: 'ok', message: `Old backups deleted: ${removed} (${keep} are kept per project)` });
    return removed;
  }

  private async removeDir(dir: string): Promise<void> {
    if (!isInside(dir, this.root()) || dir === this.root()) throw new AppError('PATH_OUTSIDE_SCOPE', 'Deleting outside the backups folder is not allowed.');
    // backup files are read-only: make them writable before removal (only inside the backup folder)
    const walk = async (d: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else await chmod(p, 0o644).catch(() => undefined);
      }
    };
    await walk(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

