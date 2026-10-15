import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { AppCore, liveCheckMarkdown, runLiveCheck, type LiveProvider } from '@aos/core';
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
  // check-ai
  provider?: string;
  baseUrl?: string;
  model?: string;
  context?: number;
  agents?: string;
  missions: boolean;
  report?: string;
  apiKeyEnv?: string;
  timeoutMin?: number;
  keep: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? 'serve', open: false, dev: false, missions: true, keep: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--port') args.port = Number(next());
    else if (a === '--data-dir') args.dataDir = resolve(next() ?? '');
    else if (a === '--ui-dir') args.uiDir = resolve(next() ?? '');
    else if (a === '--open') args.open = true;
    else if (a === '--dev') args.dev = true;
    else if (a === '--provider') args.provider = next();
    else if (a === '--base-url') args.baseUrl = next();
    else if (a === '--model') args.model = next();
    else if (a === '--context') args.context = Number(next());
    else if (a === '--agents') args.agents = next();
    else if (a === '--no-missions') args.missions = false;
    else if (a === '--report') args.report = resolve(next() ?? '');
    else if (a === '--api-key-env') args.apiKeyEnv = next();
    else if (a === '--timeout') args.timeoutMin = Number(next());
    else if (a === '--keep') args.keep = true;
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

const HELP = `Agentic OS: a local knowledge system with AI agents

Usage:
  aos serve [--port N] [--data-dir PATH] [--ui-dir PATH] [--open]
  aos check-ai [--provider NAME] [--model NAME] [options]

serve:
  --port N         port of the local server (default: a free one)
  --data-dir PATH  application data folder (default: the system one, or AOS_DATA_DIR)
  --ui-dir PATH    folder of the built interface (default: apps/ui/dist)
  --open           open the interface in the browser

The server listens on 127.0.0.1 only. The login link is printed at startup.

check-ai: runs the AI part end to end against a real model, in a temporary system
(your notes and settings are not touched) and writes a report.
  --provider NAME      ollama (default), lmstudio, openai-compatible (llama.cpp server,
                       vLLM…), anthropic, openai
  --base-url URL       server address (default: the provider's usual local address)
  --model NAME         model to use (default: the first chat model of the server)
  --context N          context window in tokens (Ollama: sent as num_ctx; default 16384)
  --agents LIST        all (default), none, or agent ids separated by commas
  --no-missions        skip the end-to-end missions
  --timeout MIN        limit per mission in minutes (default 30)
  --report PATH        where to write the Markdown report (default ./aos-live-check.md)
  --api-key-env VAR    cloud providers: the environment variable that holds the API key
  --keep               keep the temporary data folder for inspection`;

const PROVIDERS: LiveProvider[] = ['ollama', 'lmstudio', 'openai-compatible', 'anthropic', 'openai'];

async function checkAi(args: Args): Promise<number> {
  const provider = (args.provider ?? 'ollama') as LiveProvider;
  if (!PROVIDERS.includes(provider)) throw new Error(`unknown provider "${provider}" (${PROVIDERS.join(', ')})`);
  const cloud = provider === 'anthropic' || provider === 'openai';
  // the key is read from the environment only, so it never lands in the shell history or the report
  const apiKey = args.apiKeyEnv ? process.env[args.apiKeyEnv] : undefined;
  if (cloud && !apiKey) throw new Error(`a cloud provider needs a key: pass --api-key-env VAR with the key in that environment variable`);
  const root = await mkdtemp(join(tmpdir(), 'aos-live-check-'));
  const core = await AppCore.start({ dataDir: join(root, 'appdata'), logLevel: 'warn' });
  const controller = new AbortController();
  process.on('SIGINT', () => controller.abort());
  try {
    process.stdout.write(`\n  Agentic OS: live AI check (${provider}${args.model ? `, ${args.model}` : ''})\n  Temporary data: ${root}\n\n`);
    const report = await runLiveCheck(core, {
      provider,
      ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(apiKey ? { apiKey } : {}),
      ...(args.context ? { contextLength: args.context } : {}),
      agents: !args.agents || args.agents === 'all' ? 'all' : args.agents === 'none' ? 'none' : args.agents.split(',').map((x) => x.trim()),
      missions: args.missions,
      ...(args.timeoutMin ? { missionTimeoutMinutes: args.timeoutMin } : {}),
      workDir: join(root, 'systems'),
      onProgress: (line) => process.stdout.write(`  ${line}\n`),
      signal: controller.signal,
    });
    const path = args.report ?? resolve('aos-live-check.md');
    await writeFile(path, liveCheckMarkdown(report));
    process.stdout.write(`\n  ${report.ok ? 'PASSED' : 'NOT PASSED'}: ${report.agents.filter((a) => a.ok).length}/${report.agents.length} agents, ${report.missions.filter((m) => m.status === 'completed' || m.status === 'partially_completed').length}/${report.missions.length} missions finished, ${report.usage.calls} model calls.\n  Report: ${path}\n\n`);
    return report.ok ? 0 : 1;
  } finally {
    await core.stop();
    if (!args.keep) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'check-ai') process.exit(await checkAi(args));
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
      '  Agentic OS is running',
      `  Application data: ${app.core.services.paths.dataDir}`,
      `  Interface:        ${uiDir ?? 'not built (npm run build)'}`,
      '',
      `  Open in the browser: ${app.http.loginUrl}`,
      '',
      '  The link contains an access token that is valid until the server stops: do not share it. Stop: Ctrl+C',
      '',
    ].join('\n'),
  );
  if (args.open) openBrowser(app.http.loginUrl);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    process.stdout.write('\n  Stopping…\n');
    await app.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((e) => {
  process.stderr.write(`Could not start Agentic OS: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
