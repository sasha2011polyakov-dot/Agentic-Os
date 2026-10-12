import type { Db } from '../db/db.ts';
import { redactValue } from '../util/redact.ts';
import { nowIso } from '../util/time.ts';
import type { AppError } from '../util/errors.ts';

export type AuditOutcome = 'ok' | 'denied' | 'error';

export interface AuditEntry {
  id: number;
  ts: string;
  actor: string;
  action: string;
  target: string | null;
  outcome: AuditOutcome;
  details: unknown;
  runId: string | null;
}

/** Audit journal of ONE system, stored in its own database (travels with backups and exports). */
export class SystemAudit {
  constructor(private readonly db: Db) {}

  record(e: { actor: string; action: string; target?: string | null; outcome?: AuditOutcome; details?: unknown; runId?: string | null }): void {
    try {
      this.db.run(
        'INSERT INTO audit_log(ts, actor, action, target, outcome, details, run_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        nowIso(),
        e.actor,
        e.action,
        e.target ?? null,
        e.outcome ?? 'ok',
        e.details === undefined ? null : JSON.stringify(redactValue(e.details)),
        e.runId ?? null,
      );
    } catch {
      // auditing must not break the operation it records (e.g. database closed during shutdown)
    }
  }

  recordError(err: AppError, context: string): void {
    try {
      this.db.run(
        'INSERT INTO error_log(ts, code, message, context, details) VALUES (?, ?, ?, ?, ?)',
        nowIso(),
        err.code,
        err.message,
        context,
        err.details === undefined ? null : JSON.stringify(redactValue(err.details)),
      );
    } catch {
      // see above
    }
  }

  list(opts: { limit?: number; before?: number; actor?: string; action?: string; runId?: string; outcome?: AuditOutcome } = {}): AuditEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.before) {
      where.push('id < ?');
      params.push(opts.before);
    }
    if (opts.actor) {
      where.push('actor LIKE ?');
      params.push(`${opts.actor}%`);
    }
    if (opts.action) {
      where.push('action LIKE ?');
      params.push(`${opts.action}%`);
    }
    if (opts.runId) {
      where.push('run_id = ?');
      params.push(opts.runId);
    }
    if (opts.outcome) {
      where.push('outcome = ?');
      params.push(opts.outcome);
    }
    const sql = `SELECT id, ts, actor, action, target, outcome, details, run_id FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    params.push(Math.min(opts.limit ?? 200, 1000));
    return this.db
      .all<{ id: number; ts: string; actor: string; action: string; target: string | null; outcome: AuditOutcome; details: string | null; run_id: string | null }>(sql, ...params)
      .map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, target: r.target, outcome: r.outcome, details: r.details ? JSON.parse(r.details) : null, runId: r.run_id }));
  }

  errors(limit = 200): { id: number; ts: string; code: string; message: string; context: string | null; details: unknown }[] {
    return this.db
      .all<{ id: number; ts: string; code: string; message: string; context: string | null; details: string | null }>('SELECT * FROM error_log ORDER BY id DESC LIMIT ?', limit)
      .map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  }
}

/** Audit of registry-level operations (create/attach/delete systems, provider changes). */
export class RegistryAudit {
  constructor(private readonly db: Db) {}

  record(e: { actor: string; action: string; systemId?: string | null; outcome?: AuditOutcome; details?: unknown }): void {
    try {
      this.db.run(
        'INSERT INTO registry_audit(ts, actor, action, system_id, outcome, details) VALUES (?, ?, ?, ?, ?, ?)',
        nowIso(),
        e.actor,
        e.action,
        e.systemId ?? null,
        e.outcome ?? 'ok',
        e.details === undefined ? null : JSON.stringify(redactValue(e.details)),
      );
    } catch {
      // never break the caller
    }
  }

  list(limit = 200): { id: number; ts: string; actor: string; action: string; systemId: string | null; outcome: string; details: unknown }[] {
    return this.db
      .all<{ id: number; ts: string; actor: string; action: string; system_id: string | null; outcome: string; details: string | null }>('SELECT * FROM registry_audit ORDER BY id DESC LIMIT ?', limit)
      .map((r) => ({ id: r.id, ts: r.ts, actor: r.actor, action: r.action, systemId: r.system_id, outcome: r.outcome, details: r.details ? JSON.parse(r.details) : null }));
  }
}
