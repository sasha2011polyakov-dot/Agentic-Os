import type { Db } from '../db/db.ts';
import { AppError } from '../util/errors.ts';
import { parseJson } from '../util/json.ts';
import { newId } from '../util/ids.ts';
import { nowIso } from '../util/time.ts';
import { integrityCheck } from '../db/db.ts';

export type SystemStatus = 'connected' | 'disconnected' | 'unavailable' | 'error';

export interface SystemRecord {
  systemId: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  storagePath: string;
  status: SystemStatus;
  statusDetail: string | null;
  schemaVersion: number;
  settings: Record<string, unknown>;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  lastCheckedAt: string | null;
}

interface Row {
  system_id: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  storage_path: string;
  status: SystemStatus;
  status_detail: string | null;
  schema_version: number;
  settings: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  last_checked_at: string | null;
}

function toRecord(r: Row): SystemRecord {
  return {
    systemId: r.system_id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    color: r.color,
    storagePath: r.storage_path,
    status: r.status,
    statusDetail: r.status_detail,
    schemaVersion: r.schema_version,
    settings: parseJson(r.settings, {}),
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastOpenedAt: r.last_opened_at,
    lastCheckedAt: r.last_checked_at,
  };
}

export interface OperationStep {
  name: string;
  status: 'done' | 'failed' | 'skipped';
  detail?: string;
  at: string;
}

/** Persistent registry of systems (registry.db). The name is display-only; identity is system_id. */
export class SystemRegistry {
  constructor(private readonly db: Db) {}

  list(): SystemRecord[] {
    return this.db.all<Row>('SELECT * FROM systems ORDER BY sort_order, created_at').map(toRecord);
  }

  get(systemId: string): SystemRecord | null {
    const r = this.db.get<Row>('SELECT * FROM systems WHERE system_id = ?', systemId);
    return r ? toRecord(r) : null;
  }

  require(systemId: string): SystemRecord {
    const r = this.get(systemId);
    if (!r) throw new AppError('NOT_FOUND', 'Система не найдена в реестре.', { details: { systemId } });
    return r;
  }

  findByPath(storagePath: string): SystemRecord | null {
    const r = this.db.get<Row>('SELECT * FROM systems WHERE storage_path = ?', storagePath);
    return r ? toRecord(r) : null;
  }

  insert(rec: Omit<SystemRecord, 'updatedAt' | 'lastCheckedAt' | 'sortOrder' | 'statusDetail'> & { statusDetail?: string | null }): SystemRecord {
    const now = nowIso();
    const maxOrder = this.db.get<{ m: number | null }>('SELECT MAX(sort_order) AS m FROM systems')?.m ?? 0;
    this.db.run(
      `INSERT INTO systems(system_id, name, description, icon, color, storage_path, status, status_detail, schema_version, settings, sort_order, created_at, updated_at, last_opened_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.systemId,
      rec.name,
      rec.description,
      rec.icon,
      rec.color,
      rec.storagePath,
      rec.status,
      rec.statusDetail ?? null,
      rec.schemaVersion,
      JSON.stringify(rec.settings),
      maxOrder + 1,
      rec.createdAt,
      now,
      rec.lastOpenedAt,
      now,
    );
    return this.require(rec.systemId);
  }

  update(systemId: string, patch: Partial<Pick<SystemRecord, 'name' | 'description' | 'icon' | 'color' | 'storagePath' | 'status' | 'statusDetail' | 'schemaVersion' | 'settings' | 'sortOrder' | 'lastOpenedAt' | 'lastCheckedAt'>>): SystemRecord {
    const cols: string[] = [];
    const params: (string | number | null)[] = [];
    const map: Record<string, string> = {
      name: 'name', description: 'description', icon: 'icon', color: 'color', storagePath: 'storage_path', status: 'status',
      statusDetail: 'status_detail', schemaVersion: 'schema_version', sortOrder: 'sort_order', lastOpenedAt: 'last_opened_at', lastCheckedAt: 'last_checked_at',
    };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'settings') {
        cols.push('settings = ?');
        params.push(JSON.stringify(v));
      } else if (map[k]) {
        cols.push(`${map[k]} = ?`);
        params.push(v as string | number | null);
      }
    }
    if (cols.length === 0) return this.require(systemId);
    cols.push('updated_at = ?');
    params.push(nowIso());
    params.push(systemId);
    const r = this.db.run(`UPDATE systems SET ${cols.join(', ')} WHERE system_id = ?`, ...params);
    if (r.changes === 0) throw new AppError('NOT_FOUND', 'Система не найдена в реестре.');
    return this.require(systemId);
  }

  remove(systemId: string): void {
    this.db.run('DELETE FROM systems WHERE system_id = ?', systemId);
  }

  // Multi-step operation journal: lets the UI show exactly which steps of e.g. a deletion completed.
  startOperation(type: string, systemId: string | null, details: unknown = {}): string {
    const id = newId('op');
    this.db.run('INSERT INTO operations(id, type, system_id, status, steps, details, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, type, systemId, 'running', '[]', JSON.stringify(details), nowIso());
    return id;
  }

  addStep(opId: string, step: Omit<OperationStep, 'at'>): void {
    const row = this.db.get<{ steps: string }>('SELECT steps FROM operations WHERE id = ?', opId);
    const steps = parseJson<OperationStep[]>(row?.steps, []);
    steps.push({ ...step, at: nowIso() });
    this.db.run('UPDATE operations SET steps = ? WHERE id = ?', JSON.stringify(steps), opId);
  }

  finishOperation(opId: string, status: 'completed' | 'failed' | 'partial', error?: string): void {
    this.db.run('UPDATE operations SET status = ?, error = ?, finished_at = ? WHERE id = ?', status, error ?? null, nowIso(), opId);
  }

  operations(systemId?: string, limit = 50): { id: string; type: string; systemId: string | null; status: string; steps: OperationStep[]; details: unknown; error: string | null; startedAt: string; finishedAt: string | null }[] {
    const rows = systemId
      ? this.db.all<Record<string, string | null>>('SELECT * FROM operations WHERE system_id = ? ORDER BY started_at DESC LIMIT ?', systemId, limit)
      : this.db.all<Record<string, string | null>>('SELECT * FROM operations ORDER BY started_at DESC LIMIT ?', limit);
    return rows.map((r) => ({
      id: r.id!,
      type: r.type!,
      systemId: r.system_id ?? null,
      status: r.status!,
      steps: parseJson<OperationStep[]>(r.steps, []),
      details: parseJson(r.details, {}),
      error: r.error ?? null,
      startedAt: r.started_at!,
      finishedAt: r.finished_at ?? null,
    }));
  }

  /** Operations left 'running' by a crash are surfaced as 'partial' on startup instead of silently forgotten. */
  markInterruptedOperations(): number {
    return this.db.run("UPDATE operations SET status = 'partial', error = COALESCE(error, 'Прервано: приложение было закрыто во время операции.'), finished_at = ? WHERE status = 'running'", nowIso()).changes;
  }

  integrity(): string[] {
    const problems = integrityCheck(this.db);
    const dupPaths = this.db.all<{ storage_path: string; c: number }>('SELECT storage_path, COUNT(*) AS c FROM systems GROUP BY storage_path HAVING c > 1');
    for (const d of dupPaths) problems.push(`duplicate storage path: ${d.storage_path}`);
    return problems;
  }
}
