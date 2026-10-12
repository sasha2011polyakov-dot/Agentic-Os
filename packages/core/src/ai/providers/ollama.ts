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
}

/** Ollama native API (docs/api.md in github.com/ollama/ollama): /api/version, /api/tags, /api/show, /api/chat, /api/embed, /api/pull, /api/delete, /api/ps. */
export class OllamaProvider implements LocalModelProvider {
  private readonly base: string;
  private readonly detailsCache = new Map<string, ModelInfo>();

  constructor(
    readonly config: ProviderConfig,
    private readonly deps: ProviderDeps,
  ) {
    this.base = trimSlash(config.baseUrl || 'http://127.0.0.1:11434');
  }

  private get purpose() {
    return this.config.locality === 'local' ? ('ai-local' as const) : ('ai-cloud' as const);
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
          contextLength: null,
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
    const info: ModelInfo = {
      id: name,
      providerId: this.config.id,
      displayName: name,
      locality: this.config.locality,
      contextLength: ctx,
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
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options.temperature = req.temperature;
    if (req.maxOutputTokens !== undefined) options.num_predict = req.maxOutputTokens;
    const payload: Record<string, unknown> = { model: req.model, messages, stream: false, options };
    if (req.jsonSchema) payload.format = req.jsonSchema.schema;
    let res;
    try {
      res = await this.deps.http.json<{ message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number }>({
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
    if (vectors.length !== req.input.length) throw new AppError('PROVIDER_ERROR', 'Ollama вернула неожиданное число эмбеддингов.');
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
