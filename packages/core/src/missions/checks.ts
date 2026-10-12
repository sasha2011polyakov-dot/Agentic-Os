import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import { assertInScope, normalizeRelPath } from '../fs/guard.ts';
import { AppError } from '../util/errors.ts';
import { parseJson } from '../util/json.ts';
import { redact } from '../util/redact.ts';

/**
 * User-defined verification commands of a project (e.g. "tests": npm test). Agents can only ask to run a
 * check BY NAME; the program and arguments come exclusively from the user's project settings.
 */
export interface CheckDefinition {
  name: string;
  program: string;
  args: string[];
  /** Working directory relative to the project root (default: root). */
  cwd?: string;
  timeoutSec: number;
  description?: string;
}

export interface CheckResult {
  name: string;
  sourceId: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Tail of combined output, secrets redacted. */
  output: string;
  truncated: boolean;
  startedAt: string;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;
const MAX_OUTPUT = 20_000;
const ENV_ALLOW = ['PATH', 'Path', 'HOME', 'USER', 'USERNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'SHELL', 'TERM'];

export function validateChecks(input: unknown): CheckDefinition[] {
  if (!Array.isArray(input)) throw new AppError('VALIDATION_FAILED', 'Проверки задаются списком.');
  if (input.length > 20) throw new AppError('VALIDATION_FAILED', 'Не больше 20 проверок на проект.');
  const seen = new Set<string>();
  return input.map((raw, i) => {
    const c = raw as Partial<CheckDefinition>;
    const where = `Проверка №${i + 1}`;
    if (typeof c.name !== 'string' || !NAME_RE.test(c.name)) throw new AppError('VALIDATION_FAILED', `${where}: имя — латиница, цифры, «-», «_», «.» (до 40 символов).`);
    if (seen.has(c.name)) throw new AppError('VALIDATION_FAILED', `${where}: имя «${c.name}» повторяется.`);
    seen.add(c.name);
    if (typeof c.program !== 'string' || !c.program.trim() || c.program.length > 500) throw new AppError('VALIDATION_FAILED', `${where}: укажите программу (например, npm, pytest, cargo).`);
    if (/[\n\r\0]/.test(c.program)) throw new AppError('VALIDATION_FAILED', `${where}: недопустимые символы в имени программы.`);
    const args = c.args ?? [];
    if (!Array.isArray(args) || args.length > 50 || args.some((a) => typeof a !== 'string' || a.length > 1000 || a.includes('\0'))) throw new AppError('VALIDATION_FAILED', `${where}: аргументы — список строк (до 50).`);
    const timeoutSec = c.timeoutSec ?? 300;
    if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 3600) throw new AppError('VALIDATION_FAILED', `${where}: тайм-аут от 1 до 3600 секунд.`);
    const cwd = c.cwd ? normalizeRelPath(c.cwd) : undefined;
    return { name: c.name, program: c.program.trim(), args: args as string[], timeoutSec, ...(cwd ? { cwd } : {}), ...(c.description ? { description: String(c.description).slice(0, 300) } : {}) };
  });
}

export function projectChecks(rt: SystemRuntime, sourceId: string): CheckDefinition[] {
  const r = rt.db.get<{ checks: string }>('SELECT checks FROM sources WHERE id = ?', sourceId);
  if (!r) throw new AppError('NOT_FOUND', `Проект ${sourceId} не найден.`);
  return parseJson<CheckDefinition[]>(r.checks, []);
}

/** Environment without the parent's secrets: only basic variables needed to find and run tools. */
export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' };
  for (const k of ENV_ALLOW) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

function tail(s: string): { text: string; truncated: boolean } {
  return s.length > MAX_OUTPUT ? { text: `…[начало вывода опущено]\n${s.slice(-MAX_OUTPUT)}`, truncated: true } : { text: s, truncated: false };
}

/**
 * Runs one user-defined check with execFile (no shell: arguments are never interpreted), a timeout,
 * bounded output and a sanitized environment. Never throws for a failing check — that is a result.
 */
export async function runCheck(rt: SystemRuntime, sourceId: string, name: string, opts: { signal?: AbortSignal; actor: string; runId?: string | null } = { actor: 'user' }): Promise<CheckResult> {
  const def = projectChecks(rt, sourceId).find((c) => c.name === name);
  if (!def) throw new AppError('CHECK_NOT_DEFINED', `Проверка «${name}» не задана для этого проекта.`);
  const src = rt.db.get<{ root_path: string }>('SELECT root_path FROM sources WHERE id = ?', sourceId)!;
  const cwd = await assertInScope(def.cwd ? join(src.root_path, def.cwd) : src.root_path, { roots: [src.root_path], writable: false });
  const command = [def.program, ...def.args].join(' ');
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = await new Promise<{ exitCode: number | null; timedOut: boolean; out: string }>((resolve) => {
    execFile(
      def.program,
      def.args,
      { cwd, env: sanitizedEnv(), timeout: def.timeoutSec * 1000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, shell: false, ...(opts.signal ? { signal: opts.signal } : {}) },
      (error, stdout, stderr) => {
        const out = `${stdout ?? ''}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`;
        if (!error) return resolve({ exitCode: 0, timedOut: false, out });
        const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
        if (e.code === 'ENOENT') return resolve({ exitCode: null, timedOut: false, out: `Программа «${def.program}» не найдена. Проверьте, что она установлена и доступна в PATH.` });
        if (e.code === 'ABORT_ERR') return resolve({ exitCode: null, timedOut: false, out: `${out}\n[проверка отменена]` });
        const timedOut = !!e.killed && e.signal === 'SIGTERM' && Date.now() - started >= def.timeoutSec * 1000 - 50;
        resolve({ exitCode: typeof e.code === 'number' ? e.code : null, timedOut, out: timedOut ? `${out}\n[превышен тайм-аут ${def.timeoutSec} с]` : out || e.message });
      },
    );
  });
  const t = tail(redact(result.out));
  const res: CheckResult = { name, sourceId, command, ok: result.exitCode === 0, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: Date.now() - started, output: t.text, truncated: t.truncated, startedAt };
  rt.audit.record({ actor: opts.actor, action: 'check.run', target: `${sourceId}:${name}`, outcome: res.ok ? 'ok' : 'error', details: { command, exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs }, runId: opts.runId ?? null });
  return res;
}
