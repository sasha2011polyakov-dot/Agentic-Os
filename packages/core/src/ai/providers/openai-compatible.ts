import type { ChatRequest, ChatResponse, EmbedRequest, EmbedResponse, LocalModelProvider, ModelInfo, ProviderConfig, ProviderDeps, ProviderHealth } from '../types.ts';
import { StructuredUnsupportedError } from '../types.ts';
import { httpError, isStructuredRejection, providerError, trimSlash } from './common.ts';
import { toStrictSchema } from '../schema-compat.ts';

interface LmStudioModel {
  id: string;
  type?: 'llm' | 'vlm' | 'embeddings';
  state?: 'loaded' | 'not-loaded';
  /** The model's architectural limit. */
  max_context_length?: number;
  /** The window the running instance serves (newer LM Studio versions; null when not loaded). */
  loaded_context_length?: number | null;
  quantization?: string;
}

/**
 * Window assumed for a local model that is not loaded yet: LM Studio loads it on first use with the context
 * length from its own settings (often 4096), not with `max_context_length`. Budgeting for the maximum would make
 * the server cut the prompt; a provider option `contextLength` overrides this when the user loads models larger.
 */
const LOCAL_UNLOADED_CONTEXT = 4096;

/**
 * OpenAI-compatible Chat Completions API: covers OpenAI and local servers such as LM Studio
 * (http://localhost:1234/v1). For LM Studio, /api/v0/models adds load state, type and max context.
 * Structured output: response_format {type:"json_schema", json_schema:{name, schema, strict}}.
 */
export class OpenAICompatibleProvider implements LocalModelProvider {
  private readonly base: string;

  constructor(
    readonly config: ProviderConfig,
    private readonly deps: ProviderDeps,
  ) {
    this.base = trimSlash(config.baseUrl || 'http://127.0.0.1:1234/v1');
  }

  private get purpose() {
    return this.config.locality === 'local' ? ('ai-local' as const) : ('ai-cloud' as const);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.deps.apiKey) h.authorization = `Bearer ${this.deps.apiKey}`;
    const org = this.config.options.organization;
    if (typeof org === 'string' && org) h['openai-organization'] = org;
    return h;
  }

  /** The window the app budgets for: an explicit option, else what the server reports as loaded, else a safe default. */
  private contextFor(m: LmStudioModel): number | null {
    const opt = Number(this.config.options.contextLength);
    if (Number.isInteger(opt) && opt >= 1024) return m.max_context_length ? Math.min(opt, m.max_context_length) : opt;
    if (m.loaded_context_length) return m.loaded_context_length;
    if (this.config.locality !== 'local') return m.max_context_length ?? null;
    return Math.min(m.max_context_length ?? LOCAL_UNLOADED_CONTEXT, LOCAL_UNLOADED_CONTEXT);
  }

  private get flavor(): 'lmstudio' | 'openai' | 'generic' {
    const f = this.config.options.flavor;
    if (f === 'lmstudio' || f === 'openai') return f;
    if (/:1234\b/.test(this.base)) return 'lmstudio';
    if (/api\.openai\.com/.test(this.base)) return 'openai';
    return 'generic';
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const res = await this.deps.http.json<{ data?: unknown[] }>({ url: `${this.base}/models`, purpose: this.purpose, headers: this.headers(), timeoutMs: 8000, ...(signal ? { signal } : {}) });
      if (!res.ok) throw httpError(res, this.config.name);
      return { ok: true, version: null, latencyMs: Date.now() - started };
    } catch (e) {
      const err = providerError(e, this.config.name);
      return { ok: false, latencyMs: Date.now() - started, error: { code: err.code, message: err.message, hint: err.hint } };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (this.flavor === 'lmstudio') {
      try {
        const root = this.base.replace(/\/v1$/, '');
        const res = await this.deps.http.json<{ data?: LmStudioModel[] }>({ url: `${root}/api/v0/models`, purpose: this.purpose, headers: this.headers(), timeoutMs: 8000, ...(signal ? { signal } : {}) });
        if (res.ok && Array.isArray(res.data?.data)) {
          return res.data!.data!.map((m) => ({
            id: m.id,
            providerId: this.config.id,
            displayName: m.id,
            locality: this.config.locality,
            contextLength: this.contextFor(m),
            sizeBytes: null,
            parameterSize: null,
            quantization: m.quantization ?? null,
            loaded: m.state ? m.state === 'loaded' : null,
            capabilities: { chat: m.type !== 'embeddings', structuredOutput: m.type === 'embeddings' ? false : 'unknown', tools: 'unknown', embeddings: m.type === 'embeddings', vision: m.type === 'vlm' },
          }));
        }
      } catch {
        // fall back to /v1/models
      }
    }
    let res;
    try {
      res = await this.deps.http.json<{ data?: { id: string }[] }>({ url: `${this.base}/models`, purpose: this.purpose, headers: this.headers(), timeoutMs: 10_000, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw providerError(e, this.config.name);
    }
    if (!res.ok) throw httpError(res, this.config.name);
    // llama.cpp server reports the per-request window in /props (default_generation_settings.n_ctx)
    let served: number | null = null;
    if (this.flavor === 'generic' && this.config.locality === 'local') {
      try {
        const props = await this.deps.http.json<{ default_generation_settings?: { n_ctx?: number } }>({ url: `${this.base.replace(/\/v1$/, '')}/props`, purpose: this.purpose, headers: this.headers(), timeoutMs: 5000, ...(signal ? { signal } : {}) });
        const n = props.ok ? props.data?.default_generation_settings?.n_ctx : undefined;
        if (typeof n === 'number' && n > 0) served = n;
      } catch {
        // not a llama.cpp server
      }
    }
    return (res.data?.data ?? []).map((m) => {
      const embedding = /embed/i.test(m.id);
      return {
        id: m.id,
        providerId: this.config.id,
        displayName: m.id,
        locality: this.config.locality,
        contextLength: served ?? this.contextFor({ id: m.id }),
        sizeBytes: null,
        parameterSize: null,
        quantization: null,
        loaded: null,
        capabilities: { chat: !embedding, structuredOutput: embedding ? false : 'unknown', tools: 'unknown', embeddings: embedding, vision: false },
      };
    });
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const messages = [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages];
    const payload: Record<string, unknown> = { model: req.model, messages, stream: false };
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.maxOutputTokens !== undefined) payload[this.flavor === 'openai' ? 'max_completion_tokens' : 'max_tokens'] = req.maxOutputTokens;
    if (req.jsonSchema) {
      payload.response_format = { type: 'json_schema', json_schema: { name: req.jsonSchema.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64), schema: toStrictSchema(req.jsonSchema.schema), strict: true } };
    }
    let res;
    try {
      res = await this.deps.http.json<{ choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } }>({
        url: `${this.base}/chat/completions`,
        method: 'POST',
        body: JSON.stringify(payload),
        headers: this.headers(),
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
    const choice = res.data?.choices?.[0];
    const refusal = choice?.message?.refusal;
    const fr = choice?.finish_reason;
    return {
      text: refusal ? '' : (choice?.message?.content ?? ''),
      finishReason: refusal ? 'refusal' : fr === 'length' ? 'length' : fr === 'stop' || !fr ? 'stop' : 'other',
      usage: { inputTokens: res.data?.usage?.prompt_tokens ?? null, outputTokens: res.data?.usage?.completion_tokens ?? null },
      model: req.model,
      providerId: this.config.id,
      latencyMs: Date.now() - started,
      structured: !!req.jsonSchema,
    };
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    let res;
    try {
      res = await this.deps.http.json<{ data?: { embedding: number[]; index: number }[]; usage?: { prompt_tokens?: number } }>({
        url: `${this.base}/embeddings`,
        method: 'POST',
        body: JSON.stringify({ model: req.model, input: req.input }),
        headers: this.headers(),
        purpose: this.purpose,
        timeoutMs: 5 * 60_000,
        ...(req.signal ? { signal: req.signal } : {}),
        ...(req.systemId ? { systemId: req.systemId } : {}),
      });
    } catch (e) {
      throw providerError(e, this.config.name);
    }
    if (!res.ok) throw httpError(res, this.config.name, req.model);
    const data = [...(res.data?.data ?? [])].sort((a, b) => a.index - b.index);
    return { vectors: data.map((d) => d.embedding), model: req.model, usage: { inputTokens: res.data?.usage?.prompt_tokens ?? null } };
  }
}
