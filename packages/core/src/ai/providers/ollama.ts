import { AppError } from '../../util/errors.ts';
import type { ChatRequest, ChatResponse, EmbedRequest, EmbedResponse, LocalModelProvider, ModelInfo, ProviderConfig, ProviderDeps, ProviderHealth, PullProgress } from '../types.ts';
import { StructuredUnsupportedError } from '../types.ts';
import { httpError, isStructuredRejection, providerError, trimSlash } from './common.ts';

interface TagModel {
  name: string;
  model?: string;
  size?: number;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
}

interface ShowResponse {
  capabilities?: string[];
  model_info?: Record<string, unknown>;
  details?: { parameter_size?: string; quantization_level?: string };
  /** Thinking controls (docs.ollama.com/capabilities/thinking): `values: [false]` means no thinking. */
  thinking?: { values?: unknown[]; default?: unknown };
}

/**
 * Context window the app asks Ollama for when the provider sets none. Ollama itself defaults to 4k on machines
 * with less than 24 GiB of VRAM and SILENTLY drops the beginning of longer prompts (docs.ollama.com/context-length);
 * agent prompts (rules + instructions + schema + data) regularly exceed 4k, so the app always sets `num_ctx`.
 * 16k fits the agents with room for materials and keeps the KV cache of a 7–8B model around 1–2 GB.
 */
export const OLLAMA_DEFAULT_CONTEXT = 16_384;
const MIN_CONTEXT = 2048;

/** Rough prompt size in tokens; the same estimate as the agent runtime (≈3.5 characters per token). */
function estimateTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}

/** Ollama native API (docs.ollama.com/api): /api/version, /api/tags, /api/show, /api/chat, /api/embed, /api/pull, /api/delete, /api/ps. */
export class OllamaProvider implements LocalModelProvider {
  private readonly base: string;
  private readonly detailsCache = new Map<string, ModelInfo>();
  /** Models whose thinking can be switched off (`think: false`), from /api/show. */
  private readonly canDisableThinking = new Map<string, boolean>();

  constructor(
    readonly config: ProviderConfig,
    private readonly deps: ProviderDeps,
  ) {
    this.base = trimSlash(config.baseUrl || 'http://127.0.0.1:11434');
  }

  private get purpose() {
    return this.config.locality === 'local' ? ('ai-local' as const) : ('ai-cloud' as const);
  }

  /**
   * The context window used for every request: the provider option `contextLength` (or the default), never more
   * than the model supports. One stable value per model, because Ollama reloads a model whenever `num_ctx` changes.
   */
  effectiveContext(modelMax: number | null): number {
    const opt = Number(this.config.options.contextLength);
    const cap = Number.isInteger(opt) && opt >= MIN_CONTEXT ? opt : OLLAMA_DEFAULT_CONTEXT;
    return Math.max(MIN_CONTEXT, modelMax && modelMax > 0 ? Math.min(modelMax, cap) : cap);
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const res = await this.deps.http.json<{ version?: string }>({ url: `${this.base}/api/version`, purpose: this.purpose, timeoutMs: 5000, ...(signal ? { signal } : {}) });
      if (!res.ok) throw httpError(res, this.config.name);
      return { ok: true, version: res.data?.version ?? null, latencyMs: Date.now() - started };
    } catch (e) {
      const err = providerError(e, this.config.name);
      return { ok: false, latencyMs: Date.now() - started, error: { code: err.code, message: err.message, hint: err.hint } };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let res;
    try {
      res = await this.deps.http.json<{ models?: TagModel[] }>({ url: `${this.base}/api/tags`, purpose: this.purpose, timeoutMs: 10_000, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw providerError(e, this.config.name);
    }
    if (!res.ok) throw httpError(res, this.config.name);
    let running = new Set<string>();
    try {
      const ps = await this.deps.http.json<{ models?: { name: string }[] }>({ url: `${this.base}/api/ps`, purpose: this.purpose, timeoutMs: 5000 });
      running = new Set((ps.data?.models ?? []).map((m) => m.name));
    } catch {
      // /api/ps is optional information
    }
    const out: ModelInfo[] = [];
    for (const m of res.data?.models ?? []) {
      const details = await this.modelDetails(m.name, signal).catch(() => null);
      out.push(
        details ?? {
          id: m.name,
          providerId: this.config.id,
          displayName: m.name,
          locality: this.config.locality,
          contextLength: this.effectiveContext(null),
          sizeBytes: m.size ?? null,
          parameterSize: m.details?.parameter_size ?? null,
          quantization: m.details?.quantization_level ?? null,
          loaded: running.has(m.name),
          capabilities: { chat: true, structuredOutput: 'unknown', tools: 'unknown', embeddings: /embed/i.test(m.name), vision: false },
        },
      );
      const last = out[out.length - 1]!;
      last.sizeBytes = m.size ?? last.sizeBytes;
      last.loaded = running.has(m.name);
    }
    return out;
  }

  async modelDetails(name: string, signal?: AbortSignal): Promise<ModelInfo | null> {
    const cached = this.detailsCache.get(name);
    if (cached) return { ...cached };
    const res = await this.deps.http.json<ShowResponse>({ url: `${this.base}/api/show`, method: 'POST', body: JSON.stringify({ model: name }), purpose: this.purpose, timeoutMs: 10_000, ...(signal ? { signal } : {}) });
    if (!res.ok) return null;
    const caps = res.data?.capabilities ?? [];
    let ctx: number | null = null;
    for (const [k, v] of Object.entries(res.data?.model_info ?? {})) {
      if (k.endsWith('.context_length') && typeof v === 'number') ctx = v;
    }
    const isEmbedding = caps.includes('embedding') && !caps.includes('completion');
    const thinkValues = res.data?.thinking?.values;
    this.canDisableThinking.set(name, Array.isArray(thinkValues) && thinkValues.includes(false));
    const info: ModelInfo = {
      id: name,
      providerId: this.config.id,
      displayName: name,
      locality: this.config.locality,
      // the window the app will actually request (num_ctx), not the architectural maximum
      contextLength: this.effectiveContext(ctx),
      sizeBytes: null,
      parameterSize: res.data?.details?.parameter_size ?? null,
      quantization: res.data?.details?.quantization_level ?? null,
      loaded: null,
      capabilities: {
        chat: caps.length ? caps.includes('completion') : !isEmbedding,
        // Ollama enforces `format` (JSON schema) with grammar sampling for completion models.
        structuredOutput: caps.length ? caps.includes('completion') : 'unknown',
        tools: caps.length ? caps.includes('tools') : 'unknown',
        embeddings: caps.includes('embedding') || /embed/i.test(name),
        vision: caps.includes('vision'),
      },
    };
    this.detailsCache.set(name, info);
    return { ...info };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages];
    // the model's limits come from /api/show (cached); an unreachable /api/show falls back to the default window
    const info = await this.modelDetails(req.model, req.signal).catch(() => null);
    const numCtx = info?.contextLength ?? this.effectiveContext(null);
    const promptTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
    const outputTokens = req.maxOutputTokens ?? 2048;
    if (promptTokens + Math.min(outputTokens, 1024) > numCtx) {
      // Ollama would silently drop the beginning of the prompt (the instructions): refuse instead of guessing
      throw new AppError('CONTEXT_TOO_LARGE', `${this.config.name}: the request (≈${promptTokens} tokens) does not fit into the context window of ${numCtx} tokens of model "${req.model}".`, {
        hint: 'Raise the context window in the provider settings (it needs more memory), choose a model with a larger window, or narrow the materials of the task.',
        details: { promptTokens, numCtx },
      });
    }
    const options: Record<string, unknown> = { num_ctx: numCtx };
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxOutputTokens !== undefined) options.num_predict = Math.min(req.maxOutputTokens, Math.max(256, numCtx - promptTokens));
    const payload: Record<string, unknown> = { model: req.model, messages, stream: false, options };
    if (req.jsonSchema) {
      payload.format = req.jsonSchema.schema;
      // Reasoning tokens count against num_predict and are slow on local hardware; schema-bound answers do not
      // need them. Only sent when the model declares that thinking can be switched off (option think: "model" keeps
      // the model default).
      if (this.config.options.think !== 'model' && this.canDisableThinking.get(req.model)) payload.think = false;
    }
    let res;
    try {
      res = await this.deps.http.json<{ message?: { content?: string; thinking?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number }>({
        url: `${this.base}/api/chat`,
        method: 'POST',
        body: JSON.stringify(payload),
        purpose: this.purpose,
        timeoutMs: 15 * 60_000,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.systemId ? { systemId: req.systemId } : {}),
      });
    } catch (e) {
      throw providerError(e, this.config.name);
    }
    if (!res.ok) {
      if (req.jsonSchema && isStructuredRejection(res)) throw new StructuredUnsupportedError(res.text.slice(0, 200));
      throw httpError(res, this.config.name, req.model);
    }
    const reason = res.data?.done_reason;
    return {
      text: res.data?.message?.content ?? '',
      finishReason: reason === 'length' ? 'length' : reason === 'stop' || !reason ? 'stop' : 'other',
      usage: { inputTokens: res.data?.prompt_eval_count ?? null, outputTokens: res.data?.eval_count ?? null },
      model: req.model,
      providerId: this.config.id,
      latencyMs: Date.now() - started,
      structured: !!req.jsonSchema,
    };
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    let res;
    try {
      res = await this.deps.http.json<{ embeddings?: number[][]; prompt_eval_count?: number }>({
        url: `${this.base}/api/embed`,
        method: 'POST',
        body: JSON.stringify({ model: req.model, input: req.input }),
        purpose: this.purpose,
        timeoutMs: 5 * 60_000,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.systemId ? { systemId: req.systemId } : {}),
      });
    } catch (e) {
      throw providerError(e, this.config.name);
    }
    if (!res.ok) throw httpError(res, this.config.name, req.model);
    const vectors = res.data?.embeddings ?? [];
    if (vectors.length !== req.input.length) throw new AppError('PROVIDER_ERROR', 'Ollama returned an unexpected number of embeddings.');
    return { vectors, model: req.model, usage: { inputTokens: res.data?.prompt_eval_count ?? null } };
  }

  /** Streams NDJSON progress of /api/pull. Large downloads are only started after explicit user confirmation (UI). */
  async pullModel(name: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await this.deps.http.request({ url: `${this.base}/api/pull`, method: 'POST', body: JSON.stringify({ model: name, stream: true }), headers: { 'content-type': 'application/json' }, purpose: 'model-download', timeoutMs: 6 * 60 * 60_000, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw providerError(e, this.config.name);
    }
    if (!res.ok || !res.body) {
      const text = await res.text();
      throw httpError({ status: res.status, ok: false, headers: res.headers, data: safeJson(text), text }, this.config.name, name);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const evt = safeJson(line) as { status?: string; completed?: number; total?: number; error?: string } | undefined;
        if (!evt) continue;
        if (evt.error) throw new AppError('PROVIDER_ERROR', `Ollama: ${evt.error}`);
        onProgress({ status: evt.status ?? '', ...(evt.completed !== undefined ? { completed: evt.completed } : {}), ...(evt.total !== undefined ? { total: evt.total } : {}) });
      }
    }
    this.detailsCache.delete(name);
  }

  async deleteModel(name: string): Promise<void> {
    let res;
    try {
      res = await this.deps.http.json({ url: `${this.base}/api/delete`, method: 'DELETE', body: JSON.stringify({ model: name }), purpose: this.purpose, timeoutMs: 60_000 });
    } catch (e) {
      throw providerError(e, this.config.name);
    }
    if (!res.ok) throw httpError(res, this.config.name, name);
    this.detailsCache.delete(name);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
