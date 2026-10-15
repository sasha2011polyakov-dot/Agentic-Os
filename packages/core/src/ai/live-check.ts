import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppCore } from '../app.ts';
import { services } from '../wiring.ts';
import { AppError, toAppError, type ErrorCode } from '../util/errors.ts';
import type { MissionView } from '../missions/types.ts';
import { appAI } from './app-ai.ts';
import type { ModelInfo, ProviderKind } from './types.ts';

/**
 * A live end-to-end check of the AI part against a REAL model: the provider answers, a schema-bound answer comes
 * back, every built-in agent passes its own test cases, and missions run from a request to an honest result.
 * Runs in a separate, temporary system, so it never touches the user's notes. Nothing is simulated: a step that
 * could not run is reported as not run.
 */

export type LiveProvider = 'ollama' | 'lmstudio' | 'openai-compatible' | 'anthropic' | 'openai';

export interface LiveCheckOptions {
  provider: LiveProvider;
  baseUrl?: string;
  model?: string;
  /** Cloud providers only. Kept in memory for this run; never written to disk or the report. */
  apiKey?: string;
  /** Context window to use (Ollama: num_ctx; others: what the server was started with). */
  contextLength?: number;
  /** Built-in agents whose test cases run: all, none, or a list of ids. */
  agents?: 'all' | 'none' | string[];
  /** Run the end-to-end missions (default true). */
  missions?: boolean;
  /** Folder for the temporary system. */
  workDir: string;
  /** Limit per mission (default 30 minutes; local models on a CPU are slow). */
  missionTimeoutMinutes?: number;
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
}

export interface CheckStep {
  name: string;
  status: 'passed' | 'failed' | 'not_run';
  ms: number;
  detail: string;
}

export interface MissionCheck {
  name: string;
  request: string;
  mode: 'plan' | 'execute';
  status: string;
  statusReason: string;
  ms: number;
  decisions: string[];
  criteria: { id: string; text: string; status: string }[];
  plan: string[];
  documents: string[];
  limitations: string[];
  error: string | null;
}

export interface LiveCheckReport {
  startedAt: string;
  provider: { kind: LiveProvider; baseUrl: string; model: string | null; contextLength: number | null; locality: 'local' | 'cloud' };
  steps: CheckStep[];
  agents: { id: string; ok: boolean; ms: number; cases: { name: string; ok: boolean; problems: string[] }[] }[];
  missions: MissionCheck[];
  usage: { calls: number; inputTokens: number; outputTokens: number; errors: number };
  ok: boolean;
}

const PRESET: Record<LiveProvider, { kind: ProviderKind; baseUrl: string; locality: 'local' | 'cloud'; options: Record<string, unknown> }> = {
  ollama: { kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', locality: 'local', options: {} },
  lmstudio: { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234/v1', locality: 'local', options: { flavor: 'lmstudio' } },
  'openai-compatible': { kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8080/v1', locality: 'local', options: { flavor: 'generic' } },
  anthropic: { kind: 'anthropic', baseUrl: 'https://api.anthropic.com', locality: 'cloud', options: {} },
  openai: { kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', locality: 'cloud', options: { flavor: 'openai' } },
};

/** Requests of the end-to-end missions: one plan-mode task over the notes, one task that must produce a document. */
export const LIVE_MISSIONS: { name: string; mode: 'plan' | 'execute'; request: string }[] = [
  {
    name: 'Plan over the notes',
    mode: 'plan',
    request: 'Look at the notes of this system and propose how to organise them into projects and areas. Explain the trade-offs of your proposal.',
  },
  {
    name: 'Create a document',
    mode: 'execute',
    request: 'Write a short "Getting started" note for this system that explains how to create a note and how to link two notes with [[links]]. Save it in the Notes folder.',
  },
];

const DEFAULT_ANSWER = 'Use your best judgement and keep the result simple; state the assumptions you make.';

export async function runLiveCheck(core: AppCore, opts: LiveCheckOptions): Promise<LiveCheckReport> {
  const say = (line: string) => opts.onProgress?.(line);
  const ai = appAI(core.services);
  const preset = PRESET[opts.provider];
  const baseUrl = opts.baseUrl ?? preset.baseUrl;
  const report: LiveCheckReport = {
    startedAt: new Date().toISOString(),
    provider: { kind: opts.provider, baseUrl, model: opts.model ?? null, contextLength: null, locality: preset.locality },
    steps: [],
    agents: [],
    missions: [],
    usage: { calls: 0, inputTokens: 0, outputTokens: 0, errors: 0 },
    ok: false,
  };
  const step = async (name: string, fn: () => Promise<string>): Promise<boolean> => {
    const started = Date.now();
    say(`… ${name}`);
    try {
      const detail = await fn();
      report.steps.push({ name, status: 'passed', ms: Date.now() - started, detail });
      say(`✓ ${name}: ${detail}`);
      return true;
    } catch (e) {
      const err = toAppError(e);
      const detail = `${err.message}${err.hint ? ` (${err.hint})` : ''}`;
      report.steps.push({ name, status: 'failed', ms: Date.now() - started, detail });
      say(`✗ ${name}: ${detail}`);
      return false;
    }
  };
  const notRun = (name: string, why: string) => {
    report.steps.push({ name, status: 'not_run', ms: 0, detail: why });
    say(`– ${name}: not run (${why})`);
  };

  // 1. the provider
  const options = { ...preset.options, ...(opts.contextLength ? { contextLength: opts.contextLength } : {}) };
  const provider = await ai.providers.create({ kind: preset.kind, name: `Live check: ${opts.provider}`, baseUrl, locality: preset.locality, options, ...(opts.apiKey ? { apiKey: opts.apiKey, secretBackend: 'session' } : {}) });
  let model: ModelInfo | null = null;
  const reachable = await step('Provider answers', async () => {
    const h = await ai.providers.health(provider.id, opts.signal);
    if (!h.ok) throw new AppError((h.error?.code ?? 'PROVIDER_UNREACHABLE') as ErrorCode, h.error?.message ?? 'no answer', h.error?.hint ? { hint: h.error.hint } : {});
    return `${baseUrl} answered in ${h.latencyMs} ms${h.version ? `, version ${h.version}` : ''}`;
  });
  if (reachable) {
    await step('Model is available', async () => {
      const list = await ai.providers.models(provider.id, { refresh: true });
      if (list.error) throw new AppError(list.error.code as ErrorCode, list.error.message, list.error.hint ? { hint: list.error.hint } : {});
      const chat = list.models.filter((m) => m.capabilities.chat);
      model = opts.model ? (list.models.find((m) => m.id === opts.model) ?? null) : (chat[0] ?? null);
      if (!model) throw new Error(opts.model ? `the model "${opts.model}" is not on the server (available: ${chat.map((m) => m.id).join(', ') || 'none'})` : 'the server has no chat model');
      report.provider.model = model.id;
      report.provider.contextLength = model.contextLength;
      return `${model.id}${model.parameterSize ? ` (${model.parameterSize}${model.quantization ? `, ${model.quantization}` : ''})` : ''}, context window used: ${model.contextLength ?? 'unknown'} tokens`;
    });
  } else notRun('Model is available', 'the provider did not answer');

  // 2. a temporary system that uses this model
  const sysDir = join(opts.workDir, `live-check-${Date.now()}`);
  await mkdir(opts.workDir, { recursive: true });
  const sys = await core.systems.create({ name: 'Live check', storagePath: sysDir, template: 'starter' });
  const rt = await core.systems.runtime(sys.systemId);
  const s = services(rt);
  await s.indexer.indexSource(rt.primaryVaultId());
  const chosen = model as ModelInfo | null;
  if (chosen) {
    rt.settings.set('ai.mode', preset.locality === 'cloud' ? 'cloud' : 'local');
    rt.settings.set('ai.defaultModel', { providerId: provider.id, model: chosen.id });
  }

  // 3. one schema-bound answer
  if (chosen) {
    await step('Structured answer (JSON schema)', async () => {
      const schema = { type: 'object', required: ['capital', 'languages'], properties: { capital: { type: 'string' }, languages: { type: 'array', items: { type: 'string' } } } };
      const res = await ai.ai.chat(
        { rt, purpose: 'live-check', policy: { providerId: provider.id, model: chosen.id, allowFallback: false }, taskType: 'extraction', containsConfidential: false, ...(opts.signal ? { signal: opts.signal } : {}) },
        { system: 'Answer with JSON only.', messages: [{ role: 'user', content: 'What is the capital of Canada and which languages are official there?' }], temperature: 0, maxOutputTokens: 300, jsonSchema: { name: 'country', schema } },
      );
      const value = JSON.parse(res.response.text) as { capital?: unknown; languages?: unknown };
      if (typeof value.capital !== 'string' || !Array.isArray(value.languages)) throw new Error(`unexpected answer: ${res.response.text.slice(0, 200)}`);
      return `"${value.capital}", ${value.languages.length} languages; ${res.response.latencyMs} ms; schema enforced by the provider: ${res.nativeStructured ? 'yes' : 'no (prompt mode)'}`;
    });
  } else notRun('Structured answer (JSON schema)', 'no model');

  // 4. built-in agents on their own test cases
  const wanted = opts.agents ?? 'all';
  const catalogIds = ai.catalog.builtinEntries().map((e) => e.id).sort();
  const ids = wanted === 'none' ? [] : wanted === 'all' ? catalogIds : catalogIds.filter((id) => wanted.includes(id));
  if (chosen && ids.length) {
    for (const id of ids) {
      const pkg = ai.catalog.builtinPackage(id);
      if (!pkg) continue;
      await s.agents.install({ id, scope: 'builtin', grants: pkg.manifest.permissions.map((p) => p.permission) });
      await s.agents.setEnabled(id, true);
      const started = Date.now();
      say(`… agent ${id}`);
      const r = await s.agents.testRun(id, opts.signal ? { signal: opts.signal } : {});
      report.agents.push({ id, ok: r.ok, ms: Date.now() - started, cases: r.cases.map((c) => ({ name: c.name, ok: c.ok, problems: c.problems })) });
      say(`${r.ok ? '✓' : '✗'} agent ${id}: ${r.message}${r.ok ? '' : ` ${r.cases.flatMap((c) => c.problems).slice(0, 2).join('; ')}`}`);
    }
  } else if (ids.length) notRun('Agent test cases', 'no model');

  // 5. missions from a request to a result
  if (chosen && opts.missions !== false) {
    await s.missions.setupAgents('live-check');
    for (const spec of LIVE_MISSIONS) {
      if (opts.signal?.aborted) break;
      report.missions.push(await runMission(s, spec, (opts.missionTimeoutMinutes ?? 30) * 60_000, say, opts.signal));
    }
  } else if (opts.missions !== false) notRun('Missions', 'no model');

  // usage of this run (all model calls of the temporary system)
  const u = core.services.registryDb.get<{ calls: number; it: number | null; ot: number | null; errors: number | null }>(
    "SELECT COUNT(*) AS calls, SUM(COALESCE(input_tokens,0)) AS it, SUM(COALESCE(output_tokens,0)) AS ot, SUM(status = 'error') AS errors FROM ai_usage WHERE system_id = ?",
    sys.systemId,
  );
  report.usage = { calls: u?.calls ?? 0, inputTokens: u?.it ?? 0, outputTokens: u?.ot ?? 0, errors: u?.errors ?? 0 };
  report.ok =
    report.steps.every((x) => x.status === 'passed') &&
    report.agents.every((a) => a.ok) &&
    report.missions.every((m) => m.status === 'completed' || m.status === 'partially_completed');
  return report;
}

async function runMission(s: ReturnType<typeof services>, spec: (typeof LIVE_MISSIONS)[number], timeoutMs: number, say: (l: string) => void, signal?: AbortSignal): Promise<MissionCheck> {
  const started = Date.now();
  const decisions: string[] = [];
  say(`… mission "${spec.name}" (${spec.mode})`);
  let m: MissionView = await s.missions.create({ request: spec.request, mode: spec.mode, actor: 'live-check', policy: { saveReport: 'auto' } });
  let lastPhase = '';
  let error: string | null = null;
  for (;;) {
    if (signal?.aborted) {
      error = 'cancelled';
      break;
    }
    m = s.missions.get(m.id);
    if (m.phase !== lastPhase) {
      lastPhase = m.phase;
      say(`    phase: ${m.phaseLabel}`);
    }
    if (['completed', 'partially_completed', 'failed', 'cancelled'].includes(m.status)) break;
    if (Date.now() - started > timeoutMs) {
      error = `the mission did not finish in ${Math.round(timeoutMs / 60_000)} min (now: ${m.statusLabel}, ${m.phaseLabel})`;
      await s.missions.cancel(m.id, 'live-check', 'The live check timed out.').catch(() => undefined);
      m = s.missions.get(m.id);
      break;
    }
    const p = m.pending;
    if (p && (m.status === 'awaiting_approval' || m.status === 'needs_input')) {
      // answer like a cooperative user — but never apply changes to a project, never retry endlessly
      if (decisions.length >= 6) {
        error = `too many questions: ${p.title}: ${p.message}`;
        break;
      }
      if (p.kind === 'questions') {
        const qs = ((p.data.questions as { text: string }[] | undefined) ?? []).map((q) => ({ question: q.text, answer: DEFAULT_ANSWER }));
        decisions.push(`answered ${qs.length} question(s): ${qs.map((q) => q.question).join(' | ')}`);
        m = await s.missions.decide(m.id, { decision: 'approve', answers: qs, pendingId: p.id }, 'live-check');
      } else if (p.kind === 'plan' || p.kind === 'strategy' || p.kind === 'conflict') {
        decisions.push(`approved: ${p.title}`);
        m = await s.missions.decide(m.id, { decision: 'approve', pendingId: p.id }, 'live-check');
      } else if (p.kind === 'apply_changes') {
        decisions.push('did not apply changes to a project (skipped)');
        m = await s.missions.decide(m.id, { decision: 'skip', pendingId: p.id }, 'live-check');
      } else {
        error = `${p.title}: ${p.message}`;
        break;
      }
      continue;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const ms = Date.now() - started;
  const result: MissionCheck = {
    name: spec.name,
    request: spec.request,
    mode: spec.mode,
    status: m.status,
    statusReason: m.statusReason ?? '',
    ms,
    decisions,
    criteria: m.criteria.map((c) => ({ id: c.id, text: c.text, status: c.status })),
    plan: m.plan.map((x) => `${x.id} [${x.role}] ${x.title}`),
    documents: m.artifacts.filter((a) => a.type === 'document' || a.type === 'report').map((a) => a.path ?? a.title),
    limitations: m.limitations,
    error,
  };
  say(`${['completed', 'partially_completed'].includes(m.status) ? '✓' : '✗'} mission "${spec.name}": ${m.statusLabel}${m.statusReason ? `: ${m.statusReason}` : ''}${error ? ` (${error})` : ''} [${Math.round(ms / 1000)} s]`);
  return result;
}

/** The report as Markdown: what ran, what passed, what did not run, with the numbers — and nothing else. */
export function liveCheckMarkdown(r: LiveCheckReport): string {
  const mark = (s: string) => (s === 'passed' ? '✓' : s === 'failed' ? '✗' : '–');
  const out: string[] = [
    '# Agentic OS: live AI check',
    '',
    `- Date: ${r.startedAt}`,
    `- Provider: ${r.provider.kind} at ${r.provider.baseUrl} (${r.provider.locality})`,
    `- Model: ${r.provider.model ?? 'none'}; context window used: ${r.provider.contextLength ?? 'unknown'}`,
    `- Model calls: ${r.usage.calls} (errors: ${r.usage.errors}); tokens in/out: ${r.usage.inputTokens}/${r.usage.outputTokens}`,
    `- Overall: **${r.ok ? 'passed' : 'not passed'}**`,
    '',
    '## Steps',
    '',
    '| | Step | Time | Detail |',
    '|---|---|---|---|',
    ...r.steps.map((s) => `| ${mark(s.status)} | ${s.name} | ${Math.round(s.ms / 1000)} s | ${s.detail.replace(/\|/g, '\\|')} |`),
    '',
  ];
  if (r.agents.length) {
    out.push('## Built-in agents (their own test cases)', '', '| | Agent | Time | Problems |', '|---|---|---|---|');
    for (const a of r.agents) out.push(`| ${a.ok ? '✓' : '✗'} | ${a.id} | ${Math.round(a.ms / 1000)} s | ${a.cases.flatMap((c) => c.problems.map((p) => `${c.name}: ${p}`)).join('; ').replace(/\|/g, '\\|').slice(0, 400) || '—'} |`);
    out.push('', `Passed: ${r.agents.filter((a) => a.ok).length} of ${r.agents.length}.`, '');
  }
  for (const m of r.missions) {
    out.push(`## Mission: ${m.name} (${m.mode})`, '', `> ${m.request}`, '', `- Outcome: **${m.status}** in ${Math.round(m.ms / 1000)} s. ${m.statusReason}`);
    if (m.error) out.push(`- Stopped: ${m.error}`);
    if (m.decisions.length) out.push(`- Decisions taken by the check: ${m.decisions.join('; ')}`);
    if (m.plan.length) out.push('- Plan:', ...m.plan.map((p) => `  - ${p}`));
    if (m.criteria.length) out.push('- Acceptance criteria:', ...m.criteria.map((c) => `  - ${c.id} (${c.status}): ${c.text}`));
    if (m.documents.length) out.push(`- Documents: ${m.documents.join(', ')}`);
    if (m.limitations.length) out.push('- Limitations:', ...m.limitations.map((l) => `  - ${l}`));
    out.push('');
  }
  return out.join('\n');
}
