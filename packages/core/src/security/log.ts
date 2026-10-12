import type { Db } from '../db/db.ts';
import { sha256 } from '../util/hash.ts';
import { redact, redactValue } from '../util/redact.ts';
import { nowIso } from '../util/time.ts';

export type SecurityOutcome = 'ok' | 'denied' | 'error' | 'warning';

/** Kinds of security-relevant actions (29.15). Free-form strings are allowed, these are the common ones. */
export type SecurityAction =
  | 'project.connect'
  | 'project.mode'
  | 'workcopy.create'
  | 'workcopy.apply'
  | 'workcopy.discard'
  | 'permission.request'
  | 'permission.change'
  | 'confirm.risky'
  | 'backup.create'
  | 'backup.restore'
  | 'files.apply'
  | 'command.run'
  | 'command.blocked'
  | 'path.denied'
  | 'policy.denied'
  | 'patch.export'
  | 'git.command'
  | 'git.blocked'
  | 'network.egress'
  | 'secret.blocked'
  | 'injection.suspected'
  | 'extension.install'
  | 'extension.enable'
  | 'extension.disable'
  | 'extension.remove'
  | 'extension.integrity'
  | 'extension.denied'
  | 'key.change';

export interface SecurityEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  outcome: SecurityOutcome;
  sourceId: string | null;
  taskId: string | null;
  resources: string[];
  message: string;
  details: unknown;
  hash: string;
}

interface Row {
  id: number;
  ts: string;
  actor: string;
  action: string;
  outcome: SecurityOutcome;
  source_id: string | null;
  task_id: string | null;
  resources: string;
  message: string;
  details: string | null;
  prev_hash: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

function entryHash(prev: string, r: Omit<Row, 'id' | 'hash' | 'prev_hash'>): string {
  return sha256(`${prev}\u0000${r.ts}\u0000${r.actor}\u0000${r.action}\u0000${r.outcome}\u0000${r.source_id ?? ''}\u0000${r.task_id ?? ''}\u0000${r.resources}\u0000${r.message}\u0000${r.details ?? ''}`);
}

/**
 * Security journal. Append-only at the database level (UPDATE/DELETE triggers abort) and hash-chained, so a
 * modified or removed entry is detectable. Agents have no tool that writes here: only platform code records.
 * Secrets are redacted before writing; file contents are never stored — only paths.
 */
export class SecurityLog {
  constructor(
    private readonly db: Db,
    private readonly systemId: string | null,
  ) {}

  record(e: { actor: string; action: SecurityAction | string; outcome: SecurityOutcome; message: string; sourceId?: string | null; taskId?: string | null; resources?: string[]; details?: unknown }): void {
    try {
      this.db.transaction(() => {
        const prev = this.db.get<{ hash: string }>('SELECT hash FROM security_log ORDER BY id DESC LIMIT 1')?.hash ?? GENESIS;
        const row = {
          ts: nowIso(),
          actor: e.actor.slice(0, 200),
          action: e.action.slice(0, 100),
          outcome: e.outcome,
          source_id: e.sourceId ?? null,
          task_id: e.taskId ?? null,
          resources: JSON.stringify((e.resources ?? []).slice(0, 200).map((r) => redact(String(r)).slice(0, 500))),
          message: redact(e.message).slice(0, 2000),
          details: e.details === undefined ? null : JSON.stringify(redactValue(e.details)).slice(0, 20000),
        };
        this.db.run(
          'INSERT INTO security_log(ts, actor, action, outcome, source_id, task_id, resources, message, details, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          row.ts,
          row.actor,
          row.action,
          row.outcome,
          row.source_id,
          row.task_id,
          row.resources,
          row.message,
          row.details,
          prev,
          entryHash(prev, row),
        );
      });
    } catch {
      // the journal must never break the operation (e.g. database closing); the operation itself is still checked
    }
  }

  list(f: { limit?: number; before?: number; action?: string; outcome?: SecurityOutcome; sourceId?: string; taskId?: string } = {}): SecurityEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (f.before) {
      where.push('id < ?');
      params.push(f.before);
    }
    if (f.action) {
      where.push('action LIKE ?');
      params.push(`${f.action}%`);
    }
    if (f.outcome) {
      where.push('outcome = ?');
      params.push(f.outcome);
    }
    if (f.sourceId) {
      where.push('source_id = ?');
      params.push(f.sourceId);
    }
    if (f.taskId) {
      where.push('task_id = ?');
      params.push(f.taskId);
    }
    return this.db
      .all<Row>(`SELECT * FROM security_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, Math.min(f.limit ?? 200, 2000))
      .map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, outcome: r.outcome, sourceId: r.source_id, taskId: r.task_id, resources: JSON.parse(r.resources) as string[], message: r.message, details: r.details ? JSON.parse(r.details) : null, hash: r.hash }));
  }

  /** Recomputes the hash chain; returns the first broken entry id, or null when the journal is intact. */
  verify(): { ok: boolean; entries: number; brokenAt: number | null } {
    let prev = GENESIS;
    let n = 0;
    for (const r of this.db.all<Row>('SELECT * FROM security_log ORDER BY id')) {
      n++;
      if (r.prev_hash !== prev || entryHash(prev, r) !== r.hash) return { ok: false, entries: n, brokenAt: r.id };
      prev = r.hash;
    }
    return { ok: true, entries: n, brokenAt: null };
  }

  get scope(): string {
    return this.systemId ?? 'app';
  }
}
