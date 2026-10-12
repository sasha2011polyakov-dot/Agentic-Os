import { join } from 'node:path';
import type { SystemRuntime } from '../systems/runtime.ts';
import { assertInScope, normalizeRelPath } from '../fs/guard.ts';
import { AppError } from '../util/errors.ts';
import { parseJson } from '../util/json.ts';
import { redact } from '../util/redact.ts';
import { runSandboxed, type Isolation } from '../security/sandbox.ts';
import { vetCheck, type ScriptVetting } from '../security/scripts.ts';

/**
 * User-defined verification commands of a project (e.g. "tests": npm test). Agents can only ask to run a
 * check BY NAME; the program and arguments come exclusively from the user's project settings. Checks run only
 * inside a work copy (never in the original project), without a shell, in the strongest available sandbox.
 */
export interface CheckDefinition {
  name: string;
  program: string;
  args: string[];
  /** Working directory relative to the project root (default: root). */
  cwd?: string;
  timeoutSec: number;
  description?: string;
  /** Must pass before changes may be applied to the original project (default true). */
  required?: boolean;
  /** Network access during the run (default false: blocked where the sandbox can enforce it). */
  allowNetwork?: boolean;
}

export interface CheckResult {
  name: string;
  sourceId: string;
  workCopyId: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Tail of combined output, secrets redacted. */
  output: string;
  truncated: boolean;
  startedAt: string;
  isolation: Isolation;
  vetting: { findings: ScriptVetting['findings']; contentHash: string };
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,40}$/;
const MAX_OUTPUT = 20_000;

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
    return {
      name: c.name,
      program: c.program.trim(),
      args: args as string[],
      timeoutSec,
      required: c.required !== false,
      allowNetwork: c.allowNetwork === true,
      ...(cwd ? { cwd } : {}),
      ...(c.description ? { description: String(c.description).slice(0, 300) } : {}),
    };
  });
}

export function projectChecks(rt: SystemRuntime, sourceId: string): CheckDefinition[] {
  const r = rt.db.get<{ checks: string }>('SELECT checks FROM sources WHERE id = ?', sourceId);
  if (!r) throw new AppError('NOT_FOUND', `Проект ${sourceId} не найден.`);
  return parseJson<CheckDefinition[]>(r.checks, []);
}

export { sanitizedEnv } from '../security/sandbox.ts';

function tail(s: string): { text: string; truncated: boolean } {
  return s.length > MAX_OUTPUT ? { text: `…[начало вывода опущено]\n${s.slice(-MAX_OUTPUT)}`, truncated: true } : { text: s, truncated: false };
}

/** What a check would execute in a work copy, with risk findings (shown to the user before approval). */
export async function inspectCheck(rt: SystemRuntime, sourceId: string, name: string, workCopyRoot: string): Promise<{ def: CheckDefinition; vetting: ScriptVetting }> {
  const def = projectChecks(rt, sourceId).find((c) => c.name === name);
  if (!def) throw new AppError('CHECK_NOT_DEFINED', `Проверка «${name}» не задана для этого проекта.`);
  const cwd = await assertInScope(def.cwd ? join(workCopyRoot, def.cwd) : workCopyRoot, { roots: [workCopyRoot], writable: false });
  return { def, vetting: await vetCheck(def, cwd) };
}

/**
 * Runs one user-defined check in a WORK COPY. Never throws for a failing check — that is a result. Refuses
 * (COMMAND_BLOCKED) when the vetting found risky content and the user did not approve exactly this content.
 */
export async function runCheck(
  rt: SystemRuntime,
  sourceId: string,
  name: string,
  opts: { workCopy: { id: string; rootPath: string }; actor: string; runId?: string | null; signal?: AbortSignal; approvedContentHash?: string | null },
): Promise<CheckResult> {
  const { def, vetting } = await inspectCheck(rt, sourceId, name, opts.workCopy.rootPath);
  const cwd = await assertInScope(def.cwd ? join(opts.workCopy.rootPath, def.cwd) : opts.workCopy.rootPath, { roots: [opts.workCopy.rootPath], writable: false });
  const command = [def.program, ...def.args].join(' ');
  if (!vetting.autoRun && opts.approvedContentHash !== vetting.contentHash) {
    const why = vetting.findings.filter((f) => f.severity === 'high').map((f) => `${f.text} (${f.where})`).join('; ');
    rt.security.record({ actor: opts.actor, action: 'command.blocked', outcome: 'denied', sourceId, taskId: opts.runId ?? null, resources: [command], message: `Проверка «${name}» не запущена: ${why}. Требуется отдельное подтверждение именно этого содержимого.`, details: { contentHash: vetting.contentHash, approved: opts.approvedContentHash ?? null } });
    throw new AppError('COMMAND_BLOCKED', `Проверка «${name}» не запущена автоматически: ${why}.`, { hint: 'Откройте проверку, изучите, что она выполнит, и подтвердите запуск отдельно. Подтверждение действует только для текущего содержимого скриптов.', details: { vetting } });
  }
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const res = await runSandboxed({ program: def.program, args: def.args, cwd, timeoutMs: def.timeoutSec * 1000, allowNetwork: !!def.allowNetwork, mode: rt.app.appSettings.get<'auto' | 'limited'>('security.sandbox'), ...(opts.signal ? { signal: opts.signal } : {}) });
  const t = tail(redact(res.output));
  const result: CheckResult = {
    name,
    sourceId,
    workCopyId: opts.workCopy.id,
    command,
    ok: res.exitCode === 0,
    exitCode: res.exitCode,
    timedOut: res.timedOut,
    durationMs: Date.now() - started,
    output: t.text,
    truncated: t.truncated,
    startedAt,
    isolation: res.isolation,
    vetting: { findings: vetting.findings, contentHash: vetting.contentHash },
  };
  rt.audit.record({ actor: opts.actor, action: 'check.run', target: `${sourceId}:${name}`, outcome: result.ok ? 'ok' : 'error', details: { command, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, isolation: res.isolation.level }, runId: opts.runId ?? null });
  rt.security.record({ actor: opts.actor, action: 'command.run', outcome: result.ok ? 'ok' : 'warning', sourceId, taskId: opts.runId ?? null, resources: [command, opts.workCopy.rootPath], message: `Проверка «${name}» в рабочей копии: ${result.ok ? 'успешно' : result.timedOut ? 'превышен тайм-аут' : `код ${result.exitCode}`} (изоляция: ${res.isolation.level === 'isolated' ? 'песочница' : 'ограниченный режим'})`, details: { isolation: res.isolation } });
  return result;
}
