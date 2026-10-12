import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { redact } from '../util/redact.ts';
import { nowIso } from '../util/time.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  ts: string;
  level: LogLevel;
  msg: string;
  systemId?: string;
  [key: string]: unknown;
}

/**
 * JSON-lines logger. Every line passes through redact() so secrets never reach disk.
 * Rotation: when the file exceeds maxBytes it is renamed to app.1.log (one generation kept).
 */
export class Logger {
  private readonly recent: LogRecord[] = [];

  constructor(
    private readonly file: string | null,
    private readonly minLevel: LogLevel = 'info',
    private readonly maxBytes = 10 * 1024 * 1024,
    private readonly echo = false,
    private readonly context: Record<string, unknown> = {},
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  child(context: Record<string, unknown>): Logger {
    const child = new Logger(this.file, this.minLevel, this.maxBytes, this.echo, { ...this.context, ...context });
    // Children share the parent's ring buffer so the UI sees one stream.
    (child as unknown as { recent: LogRecord[] }).recent = this.recent;
    return child;
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.write('debug', msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.write('info', msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.write('warn', msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.write('error', msg, data);
  }

  recentRecords(limit = 200, minLevel: LogLevel = 'warn'): LogRecord[] {
    return this.recent.filter((r) => ORDER[r.level] >= ORDER[minLevel]).slice(-limit);
  }

  private write(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.minLevel]) return;
    const record: LogRecord = { ts: nowIso(), level, msg, ...this.context, ...normalize(data) };
    const line = redact(JSON.stringify(record));
    const safe = JSON.parse(line) as LogRecord;
    this.recent.push(safe);
    if (this.recent.length > 1000) this.recent.splice(0, this.recent.length - 1000);
    if (this.echo) process.stderr.write(line + '\n');
    if (!this.file) return;
    try {
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) {
        renameSync(this.file, this.file.replace(/\.log$/, '.1.log'));
      }
      appendFileSync(this.file, line + '\n', 'utf8');
    } catch {
      // Logging must never crash the app (e.g. disk full); the in-memory buffer still has the record.
    }
  }
}

function normalize(data?: Record<string, unknown>): Record<string, unknown> {
  if (!data) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v instanceof Error) {
      out[k] = { name: v.name, message: v.message, stack: v.stack, code: (v as { code?: unknown }).code };
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const nullLogger = new Logger(null, 'error');
