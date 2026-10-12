import { AppError } from '../../util/errors.ts';
import type { AIProvider, ChatRequest, ChatResponse, ModelInfo, ProviderConfig, ProviderDeps, ProviderHealth } from '../types.ts';
import { StructuredUnsupportedError } from '../types.ts';
import { httpError, isStructuredRejection, providerError, trimSlash } from './common.ts';
import { toStrictSchema } from '../schema-compat.ts';

const VERSION = '2023-06-01';

/**
 * Anthropic Messages API (POST /v1/messages, headers x-api-key + anthropic-version). Structured output via
 * output_config.format = {type:"json_schema", schema} (no beta header required as of 2026-10).
 * Model names are listed from GET /v1/models — nothing is hard-coded.
 */
export class AnthropicProvider implements AIProvider {
  private readonly base: string;

  constructor(
    readonly config: ProviderConfig,
    private readonly deps: ProviderDeps,
  ) {
    this.base = trimSlash(config.baseUrl || 'https://api.anthropic.com');
  }

  private headers(): Record<string, string> {
    if (!this.deps.apiKey) throw new AppError('PROVIDER_AUTH_FAILED', 'Для Anthropic не задан API-ключ.', { hint: 'Добавьте ключ в разделе «AI и модели» → «API-провайдеры».' });
    return { 'x-api-key': this.deps.apiKey, 'anthropic-version': VERSION };
  }

  async health(signal?: AbortSignal): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const res = await this.deps.http.json({ url: `${this.base}/v1/models?limit=1`, headers: this.headers(), purpose: 'ai-cloud', timeoutMs: 10_000, ...(signal ? { signal } : {}) });
      if (!res.ok) throw httpError(res, this.config.name);
      return { ok: true, version: VERSION, latencyMs: Date.now() - started };
    } catch (e) {
      const err = providerError(e, this.config.name);
      return { ok: false, latencyMs: Date.now() - started, error: { code: err.code, message: err.message, hint: err.hint } };
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    let res;
    try {
      res = await this.deps.http.json<{ data?: { id: string; display_name?: string }[] }>({ url: `${this.base}/v1/models?limit=100`, headers: this.headers(), purpose: 'ai-cloud', timeoutMs: 15_000, ...(signal ? { signal } : {}) });
    } catch (e) {
      throw providerError(e, this.config.name);
    }
    if (!res.ok) throw httpError(res, this.config.name);
    return (res.data?.data ?? []).map((m) => ({
      id: m.id,
      providerId: this.config.id,
      displayName: m.display_name ?? m.id,
      locality: 'cloud',
      contextLength: null,
      sizeBytes: null,
      parameterSize: null,
      quantization: null,
      loaded: null,
      capabilities: { chat: true, structuredOutput: 'unknown', tools: true, embeddings: false, vision: true },
    }));
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const started = Date.now();
    const payload: Record<string, unknown> = { model: req.model, max_tokens: req.maxOutputTokens ?? 8000, messages: req.messages };
    if (req.system) payload.system = req.system;
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    if (req.jsonSchema) payload.output_config = { format: { type: 'json_schema', schema: toStrictSchema(req.jsonSchema.schema, { anthropic: true }) } };
    let res;
    try {
      res = await this.deps.http.json<{ content?: { type: string; text?: string }[]; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } }>({
        url: `${this.base}/v1/messages`,
        method: 'POST',
        body: JSON.stringify(payload),
        headers: this.headers(),
        purpose: 'ai-cloud',
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
    const text = (res.data?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const stop = res.data?.stop_reason;
    return {
      text,
      finishReason: stop === 'refusal' ? 'refusal' : stop === 'max_tokens' || stop === 'model_context_window_exceeded' ? 'length' : stop === 'end_turn' || stop === 'stop_sequence' ? 'stop' : 'other',
      usage: { inputTokens: res.data?.usage?.input_tokens ?? null, outputTokens: res.data?.usage?.output_tokens ?? null },
      model: req.model,
      providerId: this.config.id,
      latencyMs: Date.now() - started,
      structured: !!req.jsonSchema,
    };
  }
}
