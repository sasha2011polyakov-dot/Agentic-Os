import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { platform } from 'node:os';

/** What protection a command actually ran with — reported to the user as is (29.9: never claim isolation we lack). */
export interface Isolation {
  level: 'isolated' | 'limited';
  tool: 'bubblewrap' | null;
  network: 'blocked' | 'not_blocked';
  files: string;
  limits: string[];
  notes: string[];
}

export interface SandboxResult {
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  output: string;
  isolation: Isolation;
}

const ENV_ALLOW = ['PATH', 'Path', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'WINDIR', 'TERM'];

/** Environment without the parent's secrets: only what tools need to start. HOME points to a temp folder. */
export function sanitizedEnv(env: NodeJS.ProcessEnv = process.env, home?: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  for (const k of ENV_ALLOW) if (env[k] !== undefined) out[k] = env[k];
  if (home) {
    out.HOME = home;
    out.USERPROFILE = home;
  }
  return out;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, platform() === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a program name through PATH (like `which`), returning the real path. */
export async function resolveProgram(program: string, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  if (isAbsolute(program)) return (await isExecutable(program)) ? realpath(program).catch(() => program) : null;
  const exts = platform() === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const p = join(dir, program + ext);
      if (await isExecutable(p)) return realpath(p).catch(() => p);
    }
  }
  return null;
}

let caps: Promise<{ bwrap: string | null; prlimit: string | null }> | null = null;

export function sandboxCapabilities(): Promise<{ bwrap: string | null; prlimit: string | null }> {
  caps ??= (async () => {
    if (platform() !== 'linux') return { bwrap: null, prlimit: null };
    const bwrap = await resolveProgram('bwrap');
    let usable: string | null = null;
    if (bwrap) {
      // user namespaces may be disabled: probe once
      usable = await new Promise((res) => execFile(bwrap, ['--ro-bind', '/', '/', '--unshare-net', '--die-with-parent', 'true'], { timeout: 5000 }, (err) => res(err ? null : bwrap)));
    }
    return { bwrap: usable, prlimit: await resolveProgram('prlimit') };
  })();
  return caps;
}

/** For tests: forget detected capabilities. */
export function resetSandboxCapabilities(): void {
  caps = null;
}

/**
 * Runs a program without a shell (arguments are never interpreted) in `cwd` (a work copy), with a timeout,
 * bounded output and a sanitized environment. On Linux with bubblewrap: own mount/pid/network namespaces,
 * read-only system folders, only the work copy writable, no network unless explicitly allowed. Otherwise the
 * run is reported as "limited" and callers must have asked the user for confirmation.
 */
export async function runSandboxed(opts: { program: string; args: string[]; cwd: string; timeoutMs: number; allowNetwork?: boolean; mode?: 'auto' | 'limited'; signal?: AbortSignal; maxOutputBytes?: number }): Promise<SandboxResult> {
  const resolved = await resolveProgram(opts.program);
  if (!resolved) {
    return { exitCode: null, timedOut: false, aborted: false, output: `The program "${opts.program}" was not found. Check that it is installed and available in PATH.`, isolation: { level: 'limited', tool: null, network: 'not_blocked', files: '—', limits: [], notes: ['the command did not run'] } };
  }
  const c = opts.mode === 'limited' ? { bwrap: null, prlimit: null } : await sandboxCapabilities();
  const limits: string[] = [`timeout ${Math.round(opts.timeoutMs / 1000)} s`, `output up to ${Math.round((opts.maxOutputBytes ?? 8 * 1024 * 1024) / 1048576)} MB`, 'no command shell', 'environment without secrets'];
  const notes: string[] = [];
  let cmd = resolved;
  let args = [...opts.args];
  let isolation: Isolation;
  const home = '/tmp';
  if (c.bwrap) {
    const progRoot = dirname(dirname(resolved));
    const nodeRoot = dirname(dirname(process.execPath));
    const binds = ['--ro-bind', '/usr', '/usr', '--ro-bind-try', '/bin', '/bin', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--ro-bind-try', '/sbin', '/sbin', '--ro-bind-try', '/etc', '/etc'];
    for (const extra of new Set([progRoot, nodeRoot])) if (!extra.startsWith('/usr') && extra !== '/') binds.push('--ro-bind-try', extra, extra);
    args = [...binds, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--bind', opts.cwd, opts.cwd, '--unshare-all', ...(opts.allowNetwork ? ['--share-net'] : []), '--die-with-parent', '--new-session', '--chdir', opts.cwd, '--', resolved, ...opts.args];
    cmd = c.bwrap;
    isolation = { level: 'isolated', tool: 'bubblewrap', network: opts.allowNetwork ? 'not_blocked' : 'blocked', files: 'writes only to the work copy; the home folder and the rest of the disk are not accessible', limits, notes };
  } else {
    isolation = { level: 'limited', tool: null, network: 'not_blocked', files: 'the process runs with the user\'s rights; the working folder is a copy of the project', limits, notes };
    notes.push(platform() === 'linux' ? 'The bubblewrap sandbox was not found: full isolation is not available. Install the bubblewrap package so that checks run isolated.' : 'Full process isolation is not available on this OS: the command runs with the user\'s rights in the work copy.');
  }
  if (c.prlimit) {
    const cpu = Math.max(1, Math.ceil(opts.timeoutMs / 1000));
    args = [`--cpu=${cpu}`, `--fsize=${1024 * 1024 * 1024}`, '--core=0', '--', cmd, ...args];
    cmd = c.prlimit;
    limits.push(`CPU time up to ${cpu} s`, 'files up to 1 GB');
  } else if (platform() === 'linux') notes.push('CPU and file size limits were not applied (prlimit was not found).');
  notes.push('No memory limit is set: runtimes (for example V8) reserve virtual memory and do not start under a hard limit.');
  const env = sanitizedEnv(process.env, c.bwrap ? home : undefined);
  let tempHome: string | null = null;
  if (!c.bwrap) {
    // no namespaces: at least keep HOME away from the user's real home (dotfiles, credentials, tool caches)
    tempHome = await mkdtemp(join(tmpdir(), 'aos-home-'));
    env.HOME = tempHome;
    env.USERPROFILE = tempHome;
  }
  const started = Date.now();
  const res = await new Promise<{ exitCode: number | null; timedOut: boolean; aborted: boolean; out: string }>((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, env, timeout: opts.timeoutMs, maxBuffer: opts.maxOutputBytes ?? 8 * 1024 * 1024, windowsHide: true, shell: false, ...(opts.signal ? { signal: opts.signal } : {}) }, (error, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ? `${stdout ? '\n' : ''}${stderr}` : ''}`;
      if (!error) return resolve({ exitCode: 0, timedOut: false, aborted: false, out });
      const e = error as NodeJS.ErrnoException & { code?: number | string; killed?: boolean; signal?: string };
      if (e.code === 'ABORT_ERR') return resolve({ exitCode: null, timedOut: false, aborted: true, out: `${out}\n[the check was cancelled]` });
      const timedOut = !!e.killed && Date.now() - started >= opts.timeoutMs - 50;
      resolve({ exitCode: typeof e.code === 'number' ? e.code : null, timedOut, aborted: false, out: timedOut ? `${out}\n[timed out after ${Math.round(opts.timeoutMs / 1000)} s]` : out || e.message });
    });
  });
  if (tempHome) await rm(tempHome, { recursive: true, force: true }).catch(() => undefined);
  return { exitCode: res.exitCode, timedOut: res.timedOut, aborted: res.aborted, output: res.out, isolation };
}
