import { constants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import { assertInScope, isInside, normalizeRelPath } from '../fs/guard.ts';
import { atomicWrite } from '../fs/safe-fs.ts';
import { isSecretFileName } from '../fs/secrets.ts';
import { AppError, toAppError } from '../util/errors.ts';
import { newId } from '../util/ids.ts';
import { parseJson } from '../util/json.ts';
import { nowIso } from '../util/time.ts';
import { modeAtLeast, modeLabel, type AccessMode } from './policy.ts';

export interface WorkCopyInfo {
  id: string;
  sourceId: string;
  missionId: string | null;
  rootPath: string;
  status: 'creating' | 'ready' | 'stale' | 'discarded' | 'error';
  files: number;
  bytes: number;
  excluded: { path: string; reason: string }[];
  appliedSets: string[];
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  source_id: string;
  mission_id: string | null;
  root_path: string;
  status: WorkCopyInfo['status'];
  files: number;
  bytes: number;
  excluded: string;
  applied_sets: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Folders never copied: Git metadata (history, credentials, hooks) stays only in the original. */
const NEVER_COPY = new Set(['.git', '.hg', '.svn', '.aos']);
/** Heavy dependency/build folders: copied only when the whole project still fits the size limit. */
const HEAVY = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'target', '.gradle', '.next', '.nuxt', 'dist', 'build', 'out', '.cache', 'vendor']);
const MAX_FILES = 300_000;

interface Entry {
  rel: string;
  size: number;
  heavy: boolean;
}

/**
 * Isolated work copies (29.3). A work copy is a physically separate folder inside the application data folder
 * (never inside the project or the system). Agents' change sets are applied there and checks run there; the
 * original project is not touched. If a safe copy cannot be made, the operation is refused — never redirected
 * to the original.
 */
export class WorkCopyService {
  constructor(private readonly rt: SystemRuntime) {}

  root(): string {
    return join(this.rt.app.paths.dataDir, 'workcopies', this.rt.systemId);
  }

  private source(id: string): { id: string; kind: string; name: string; root_path: string; access_mode: AccessMode } {
    const s = this.rt.db.get<{ id: string; kind: string; name: string; root_path: string; access_mode: AccessMode }>('SELECT id, kind, name, root_path, access_mode FROM sources WHERE id = ?', id);
    if (!s) throw new AppError('NOT_FOUND', 'Проект не найден.');
    return s;
  }

  private view(r: Row): WorkCopyInfo {
    return { id: r.id, sourceId: r.source_id, missionId: r.mission_id, rootPath: r.root_path, status: r.status, files: r.files, bytes: r.bytes, excluded: parseJson(r.excluded, []), appliedSets: parseJson(r.applied_sets, []), error: r.error, createdAt: r.created_at, updatedAt: r.updated_at };
  }

  get(id: string): WorkCopyInfo {
    const r = this.rt.db.get<Row>('SELECT * FROM work_copies WHERE id = ?', id);
    if (!r) throw new AppError('NOT_FOUND', 'Рабочая копия не найдена.');
    return this.view(r);
  }

  list(sourceId?: string): WorkCopyInfo[] {
    const rows = sourceId ? this.rt.db.all<Row>("SELECT * FROM work_copies WHERE source_id = ? AND status <> 'discarded' ORDER BY created_at DESC", sourceId) : this.rt.db.all<Row>("SELECT * FROM work_copies WHERE status <> 'discarded' ORDER BY created_at DESC");
    return rows.map((r) => this.view(r));
  }

  /** Latest usable copy for a project (and mission, when given). */
  current(sourceId: string, missionId?: string | null): WorkCopyInfo | null {
    const r = missionId
      ? this.rt.db.get<Row>("SELECT * FROM work_copies WHERE source_id = ? AND mission_id = ? AND status IN ('ready','stale') ORDER BY created_at DESC LIMIT 1", sourceId, missionId)
      : this.rt.db.get<Row>("SELECT * FROM work_copies WHERE source_id = ? AND mission_id IS NULL AND status IN ('ready','stale') ORDER BY created_at DESC LIMIT 1", sourceId);
    return r ? this.view(r) : null;
  }

  private async scan(root: string): Promise<{ entries: Entry[]; skipped: { path: string; reason: string }[] }> {
    const entries: Entry[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const walk = async (dirAbs: string, rel: string, heavy: boolean): Promise<void> => {
      let list;
      try {
        list = await readdir(dirAbs, { withFileTypes: true });
      } catch (e) {
        skipped.push({ path: rel || '.', reason: `папка не читается: ${toAppError(e).message}` });
        return;
      }
      for (const e of list) {
        const childRel = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) {
          // links are not followed: they could point outside the project (29.11)
          skipped.push({ path: childRel, reason: 'символическая ссылка не копируется' });
          continue;
        }
        if (e.isDirectory()) {
          if (NEVER_COPY.has(e.name)) {
            skipped.push({ path: childRel, reason: e.name === '.git' ? 'служебная папка Git не копируется' : 'служебная папка' });
            continue;
          }
          await walk(join(dirAbs, e.name), childRel, heavy || HEAVY.has(e.name));
        } else if (e.isFile()) {
          if (isSecretFileName(childRel)) {
            skipped.push({ path: childRel, reason: 'файл с секретами не копируется' });
            continue;
          }
          const st = await lstat(join(dirAbs, e.name));
          entries.push({ rel: childRel, size: st.size, heavy });
          if (entries.length > MAX_FILES) throw new AppError('WORKCOPY_FAILED', `В проекте больше ${MAX_FILES} файлов — полная копия не создаётся.`);
        }
      }
    };
    await walk(root, '', false);
    return { entries, skipped };
  }

  /** Creates a work copy. Requires the project mode «Работать в копии» or higher. */
  async create(sourceId: string, opts: { missionId?: string | null; actor: string }): Promise<WorkCopyInfo> {
    const src = this.source(sourceId);
    if (src.kind !== 'project') throw new AppError('VALIDATION_FAILED', 'Рабочие копии создаются для подключённых проектов.');
    if (!modeAtLeast(src.access_mode, 'workcopy')) {
      this.rt.security.record({ actor: opts.actor, action: 'workcopy.create', outcome: 'denied', sourceId, taskId: opts.missionId ?? null, message: `Рабочая копия не создана: режим проекта «${modeLabel(src.access_mode)}»` });
      throw new AppError('MODE_FORBIDS', `Проект «${src.name}» в режиме «${modeLabel(src.access_mode)}»: рабочие копии не разрешены.`, { hint: 'Включите режим «Работать в копии» в карточке проекта.' });
    }
    const id = newId('wc');
    const dir = join(this.root(), id);
    const now = nowIso();
    this.rt.db.run("INSERT INTO work_copies(id, source_id, mission_id, root_path, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'creating', ?, ?)", id, sourceId, opts.missionId ?? null, dir, now, now);
    try {
      if (isInside(dir, src.root_path) || isInside(src.root_path, dir)) throw new AppError('WORKCOPY_FAILED', 'Папка рабочей копии пересекается с проектом.');
      const { entries, skipped } = await this.scan(src.root_path);
      const max = this.rt.app.appSettings.get<number>('security.workCopyMaxBytes');
      const total = entries.reduce((s, e) => s + e.size, 0);
      const light = entries.filter((e) => !e.heavy);
      const lightTotal = light.reduce((s, e) => s + e.size, 0);
      let toCopy = entries;
      const excluded = [...skipped];
      if (total > max) {
        if (lightTotal > max) throw new AppError('WORKCOPY_FAILED', `Проект слишком большой для рабочей копии (${Math.round(lightTotal / 1048576)} МБ без зависимостей, лимит ${Math.round(max / 1048576)} МБ).`);
        toCopy = light;
        excluded.push({ path: '(зависимости и результаты сборки)', reason: `не скопированы из-за размера (${Math.round((total - lightTotal) / 1048576)} МБ): проверки, которым они нужны, могут не пройти; автоматическая установка зависимостей не выполняется` });
      }
      await mkdir(dir, { recursive: true });
      let bytes = 0;
      for (const e of toCopy) {
        const from = join(src.root_path, ...e.rel.split('/'));
        const to = join(dir, ...e.rel.split('/'));
        await mkdir(dirname(to), { recursive: true });
        // copy-on-write clone where the file system supports it, plain copy otherwise — never a hard link
        await copyFile(from, to, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL);
        const st = await stat(from);
        await chmod(to, st.mode & 0o777);
        bytes += e.size;
      }
      this.rt.db.run("UPDATE work_copies SET status = 'ready', files = ?, bytes = ?, excluded = ?, updated_at = ? WHERE id = ?", toCopy.length, bytes, JSON.stringify(excluded.slice(0, 500)), nowIso(), id);
      this.rt.security.record({ actor: opts.actor, action: 'workcopy.create', outcome: 'ok', sourceId, taskId: opts.missionId ?? null, resources: [dir], message: `Создана рабочая копия «${src.name}»: ${toCopy.length} файлов, ${Math.round(bytes / 1024)} КБ`, details: { excluded: excluded.length } });
      return this.get(id);
    } catch (e) {
      const err = toAppError(e);
      this.rt.db.run("UPDATE work_copies SET status = 'error', error = ?, updated_at = ? WHERE id = ?", err.message, nowIso(), id);
      await this.removeDir(dir).catch(() => undefined);
      this.rt.security.record({ actor: opts.actor, action: 'workcopy.create', outcome: 'error', sourceId, taskId: opts.missionId ?? null, message: `Рабочая копия не создана: ${err.message}. Исходный проект не изменялся.` });
      throw err.code === 'WORKCOPY_FAILED' || err.code === 'MODE_FORBIDS' ? err : new AppError('WORKCOPY_FAILED', `${err.message}`, { cause: e });
    }
  }

  /** Writes the (non-skipped) files of a change set into the copy. Only content from the set is written. */
  async applySet(workCopyId: string, files: { path: string; op: 'create' | 'modify' | 'delete'; content: string | null }[], opts: { changeSetId: string; actor: string; missionId?: string | null }): Promise<{ written: string[]; deleted: string[] }> {
    const wc = this.get(workCopyId);
    if (wc.status !== 'ready' && wc.status !== 'stale') throw new AppError('INVALID_STATE_TRANSITION', 'Рабочая копия недоступна.');
    const scope = { roots: [wc.rootPath], writable: true };
    const written: string[] = [];
    const deleted: string[] = [];
    for (const f of files) {
      const rel = normalizeRelPath(f.path);
      const abs = await assertInScope(join(wc.rootPath, ...rel.split('/')), scope, { write: true });
      if (f.op === 'delete') {
        await unlink(abs).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
        deleted.push(rel);
      } else {
        await atomicWrite(abs, f.content ?? '');
        written.push(rel);
      }
    }
    const applied = [...new Set([...wc.appliedSets, opts.changeSetId])];
    this.rt.db.run('UPDATE work_copies SET applied_sets = ?, updated_at = ? WHERE id = ?', JSON.stringify(applied), nowIso(), workCopyId);
    this.rt.security.record({ actor: opts.actor, action: 'workcopy.apply', outcome: 'ok', sourceId: wc.sourceId, taskId: opts.missionId ?? opts.changeSetId, resources: [...written, ...deleted], message: `Изменения применены к рабочей копии (${written.length} записано, ${deleted.length} удалено). Исходный проект не изменялся.` });
    return { written, deleted };
  }

  /** True when the original project changed after the copy was made (indexed later than the copy). */
  isStale(workCopyId: string): boolean {
    const wc = this.get(workCopyId);
    const newer = this.rt.db.get<{ c: number }>('SELECT COUNT(*) AS c FROM files WHERE source_id = ? AND indexed_at > ?', wc.sourceId, wc.createdAt)!.c;
    if (newer && wc.status === 'ready') this.rt.db.run("UPDATE work_copies SET status = 'stale', updated_at = ? WHERE id = ?", nowIso(), workCopyId);
    return newer > 0;
  }

  async discard(workCopyId: string, actor: string): Promise<void> {
    const wc = this.get(workCopyId);
    await this.removeDir(wc.rootPath);
    this.rt.db.run("UPDATE work_copies SET status = 'discarded', updated_at = ? WHERE id = ?", nowIso(), workCopyId);
    this.rt.security.record({ actor, action: 'workcopy.discard', outcome: 'ok', sourceId: wc.sourceId, taskId: wc.missionId, resources: [wc.rootPath], message: 'Рабочая копия удалена. Исходный проект не затронут.' });
  }

  private async removeDir(dir: string): Promise<void> {
    const root = this.root();
    if (!isInside(dir, root) || dir === root) throw new AppError('PATH_OUTSIDE_SCOPE', 'Удаление вне папки рабочих копий запрещено.');
    await rm(dir, { recursive: true, force: true });
  }
}
