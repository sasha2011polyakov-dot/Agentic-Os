import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startApp } from './index.ts';

// node:sqlite prints an ExperimentalWarning on load; hide only that one, keep every other warning.
const originalEmit = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning.message;
  if (text.includes('SQLite is an experimental feature')) return;
  return (originalEmit as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

interface Args {
  command: string;
  port?: number;
  dataDir?: string;
  uiDir?: string;
  open: boolean;
  dev: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? 'serve', open: false, dev: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') args.port = Number(next());
    else if (a === '--data-dir') args.dataDir = resolve(next() ?? '');
    else if (a === '--ui-dir') args.uiDir = resolve(next() ?? '');
    else if (a === '--open') args.open = true;
    else if (a === '--dev') args.dev = true;
    else if (a === '--help' || a === '-h') args.command = 'help';
  }
  return args;
}

function defaultUiDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, '..', '..', 'ui', 'dist'), join(here, '..', 'ui'), join(here, 'ui')]) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '""', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    // the URL is printed anyway
  }
}

const HELP = `Agentic OS — локальная система знаний с AI-агентами

Использование:
  aos serve [--port N] [--data-dir PATH] [--ui-dir PATH] [--open]

Параметры:
  --port N         порт локального сервера (по умолчанию — свободный)
  --data-dir PATH  папка данных приложения (по умолчанию — системная, или AOS_DATA_DIR)
  --ui-dir PATH    папка собранного интерфейса (по умолчанию apps/ui/dist)
  --open           открыть интерфейс в браузере

Сервер слушает только 127.0.0.1. Ссылка для входа печатается при запуске.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'help' || args.command !== 'serve') {
    process.stdout.write(HELP + '\n');
    process.exit(args.command === 'help' ? 0 : 1);
  }
  const uiDir = args.uiDir ?? defaultUiDir();
  const app = await startApp({
    ...(args.port !== undefined ? { port: args.port } : {}),
    ...(args.dataDir ? { dataDir: args.dataDir } : {}),
    uiDir,
    echoLogs: args.dev,
    ...(args.dev ? { devCorsOrigin: 'http://127.0.0.1:5173', logLevel: 'debug' as const } : {}),
    ...(process.env.AOS_TOKEN ? { token: process.env.AOS_TOKEN } : {}),
  });
  process.stdout.write(
    [
      '',
      '  Agentic OS запущен',
      `  Данные приложения: ${app.core.services.paths.dataDir}`,
      `  Интерфейс:         ${uiDir ?? 'не собран (npm run build)'}`,
      '',
      `  Откройте в браузере: ${app.http.loginUrl}`,
      '',
      '  Ссылка содержит токен доступа, он действует до остановки сервера — не передавайте её другим. Остановить: Ctrl+C',
      '',
    ].join('\n'),
  );
  if (args.open) openBrowser(app.http.loginUrl);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\n  Остановка…\n');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  process.stderr.write(`Не удалось запустить Agentic OS: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
