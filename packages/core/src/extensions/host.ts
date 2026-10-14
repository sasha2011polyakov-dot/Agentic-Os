import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { platform } from 'node:os';
import { AppError } from '../util/errors.ts';
import { redact } from '../util/redact.ts';
import { sandboxCapabilities } from '../security/sandbox.ts';

function runtimeDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    process.env.AOS_PLUGIN_RUNTIME_DIR ?? '',
    join(here, '..', '..', 'plugin-runtime'), // source tree: packages/core/src/extensions → packages/core/plugin-runtime
    join(here, 'plugin-runtime'), // bundled: dist/plugin-runtime next to the bundle
    join(here, '..', 'plugin-runtime'),
  ].filter(Boolean);
}

export function pluginRuntimeDir(): string {
  for (const c of runtimeDirCandidates()) if (existsSync(join(c, 'runner.mjs')) && existsSync(join(c, 'guard.mjs'))) return c;
  throw new AppError('INTERNAL', 'Не найдена среда выполнения плагинов (plugin-runtime).');
}

export interface PluginIsolation {
  level: 'isolated' | 'restricted';
  network: string;
  files: string;
  notes: string[];
}

export interface PluginCall {
  method: string;
  allowed: boolean;
  reason?: string;
}

export interface PluginRunResult {
  ok: boolean;
  output: unknown;
  error: { code: string; message: string } | null;
  calls: PluginCall[];
  durationMs: number;
  isolation: PluginIsolation;
  stderr: string;
}

export type ApiHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const MAX_STDOUT = 4 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_CALLS = 200;

/**
 * Runs one plugin tool in a separate Node process with the permission model (section 30):
 * - file reads only inside the extension's own folder (+ the runtime files), no file writes at all;
 * - no child processes, workers, native addons, WASI, process.binding (Node --permission);
 * - no direct network (guard.mjs removes network modules and fetch); with bubblewrap also an empty network namespace;
 * - no code generation from strings, bounded memory, a timeout, bounded output, an EMPTY environment (no secrets);
 * - every request for data goes through `handle`, which checks the grants of this extension at call time.
 */
export async function runPluginProcess(opts: { extDir: string; entry: string; input: unknown; timeoutMs: number; handle: ApiHandler; signal?: AbortSignal; mode?: 'auto' | 'limited' }): Promise<PluginRunResult> {
  const runtime = pluginRuntimeDir();
  const nodeArgs = [
    '--permission',
    `--allow-fs-read=${opts.extDir}`,
    `--allow-fs-read=${runtime}`,
    '--disallow-code-generation-from-strings',
    '--max-old-space-size=128',
    '--no-experimental-global-navigator',
    `--import=${pathToFileURL(join(runtime, 'guard.mjs')).href}`,
    join(runtime, 'runner.mjs'),
  ];
  const caps = opts.mode === 'limited' ? { bwrap: null } : await sandboxCapabilities();
  const notes: string[] = [];
  let cmd = process.execPath;
  let args = nodeArgs;
  let isolation: PluginIsolation;
  if (caps.bwrap) {
    const nodeRoot = dirname(dirname(process.execPath));
    args = ['--ro-bind', '/usr', '/usr', '--ro-bind-try', '/lib', '/lib', '--ro-bind-try', '/lib64', '/lib64', '--ro-bind-try', '/etc/ssl', '/etc/ssl', '--ro-bind-try', nodeRoot, nodeRoot, '--ro-bind', opts.extDir, opts.extDir, '--ro-bind', runtime, runtime, '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--unshare-all', '--die-with-parent', '--new-session', '--chdir', opts.extDir, '--', process.execPath, ...nodeArgs];
    cmd = caps.bwrap;
    isolation = { level: 'isolated', network: 'заблокирована на уровне ОС (bubblewrap) и среды выполнения', files: 'чтение — только файлы расширения; запись запрещена', notes };
  } else {
    isolation = { level: 'restricted', network: 'прямой доступ заблокирован средой выполнения (модули сети и fetch удалены); изоляции сети на уровне ОС нет', files: 'чтение — только файлы расширения; запись запрещена (модель разрешений Node)', notes };
    notes.push(platform() === 'linux' ? 'bubblewrap не найден: сетевая изоляция обеспечивается только средствами среды выполнения.' : 'На этой ОС изоляция плагинов обеспечивается моделью разрешений Node без изоляции на уровне ОС.');
  }
  const started = Date.now();
  const calls: PluginCall[] = [];
  return new Promise<PluginRunResult>((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.extDir, env: { LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    let stdoutBytes = 0;
    let buf = '';
    let stderr = '';
    let finished = false;
    const finish = (r: Omit<PluginRunResult, 'calls' | 'durationMs' | 'isolation' | 'stderr'>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill('SIGKILL');
      resolve({ ...r, calls, durationMs: Date.now() - started, isolation, stderr: redact(stderr).slice(-4000) });
    };
    const timer = setTimeout(() => finish({ ok: false, output: null, error: { code: 'TIMEOUT', message: `Инструмент расширения не уложился в ${Math.round(opts.timeoutMs / 1000)} с.` } }), opts.timeoutMs);
    const onAbort = () => finish({ ok: false, output: null, error: { code: 'CANCELLED', message: 'Выполнение отменено.' } });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const reply = (m: unknown) => {
      if (!finished && child.stdin.writable) child.stdin.write(`${JSON.stringify(m)}\n`);
    };
    const onLine = (line: string) => {
      if (!line.trim()) return;
      let m: { type?: string; id?: number; method?: string; params?: Record<string, unknown>; ok?: boolean; output?: unknown; error?: { code?: string; message?: string } };
      try {
        m = JSON.parse(line);
      } catch {
        return; // plugin's own prints are ignored
      }
      if (m.type === 'call' && typeof m.id === 'number' && typeof m.method === 'string') {
        if (calls.length >= MAX_CALLS) {
          calls.push({ method: m.method, allowed: false, reason: 'превышено число обращений' });
          reply({ type: 'result', id: m.id, ok: false, error: { code: 'BUDGET_EXCEEDED', message: 'Слишком много обращений к API.' } });
          return;
        }
        const id = m.id;
        const method = m.method;
        opts
          .handle(method, m.params && typeof m.params === 'object' ? m.params : {})
          .then((value) => {
            calls.push({ method, allowed: true });
            reply({ type: 'result', id, ok: true, value });
          })
          .catch((e: unknown) => {
            const err = e instanceof AppError ? e : new AppError('INTERNAL', String((e as Error)?.message ?? e));
            calls.push({ method, allowed: false, reason: err.message });
            reply({ type: 'result', id, ok: false, error: { code: err.code, message: err.message } });
          });
        return;
      }
      if (m.type === 'done') finish(m.ok ? { ok: true, output: m.output ?? null, error: null } : { ok: false, output: null, error: { code: m.error?.code ?? 'EXTENSION_ERROR', message: m.error?.message ?? 'Ошибка расширения.' } });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_STDOUT) return finish({ ok: false, output: null, error: { code: 'VALIDATION_FAILED', message: 'Расширение вывело слишком много данных.' } });
      buf += chunk;
      if (buf.length > MAX_LINE && !buf.includes('\n')) return finish({ ok: false, output: null, error: { code: 'VALIDATION_FAILED', message: 'Слишком длинное сообщение расширения.' } });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c: string) => {
      if (stderr.length < 64_000) stderr += c;
    });
    child.on('error', (e) => finish({ ok: false, output: null, error: { code: 'INTERNAL', message: `Не удалось запустить расширение: ${e.message}` } }));
    child.on('close', (code) => {
      if (buf.trim()) onLine(buf); // a last `done` line without a trailing newline
      setImmediate(() => finish({ ok: false, output: null, error: { code: 'EXTENSION_ERROR', message: `Расширение завершилось без результата (код ${code ?? '—'}).${stderr ? ` ${redact(stderr).slice(-300)}` : ''}` } }));
    });
    child.stdin.on('error', () => undefined);
    reply({ type: 'start', entry: opts.entry, input: opts.input });
  });
}
