import type { ChatRequest, ChatResponse, EmbedRequest, EmbedResponse, LocalModelProvider, ModelInfo, ProviderConfig, ProviderHealth } from '../types.ts';
import { sha256 } from '../../util/hash.ts';
import { AppError } from '../../util/errors.ts';

/**
 * Deterministic provider for automated tests ONLY. It is registered exclusively when
 * AOS_ENABLE_TEST_PROVIDER=1 and is labelled as a test provider in the UI, so it can never silently
 * replace a real model in normal use.
 */
export type TestResponder = (req: ChatRequest) => string | null | Promise<string | null>;

const responders: { match: (req: ChatRequest) => boolean; respond: TestResponder }[] = [];
const calls: ChatRequest[] = [];

export function registerTestResponder(match: (req: ChatRequest) => boolean, respond: TestResponder): () => void {
  const entry = { match, respond };
  responders.unshift(entry);
  return () => {
    const i = responders.indexOf(entry);
    if (i !== -1) responders.splice(i, 1);
  };
}

export function testProviderCalls(): ChatRequest[] {
  return calls;
}

export function resetTestProvider(): void {
  calls.length = 0;
}

export const TEST_MODELS = ['test-model', 'test-embed'];

export class TestProvider implements LocalModelProvider {
  constructor(readonly config: ProviderConfig) {}

  async health(): Promise<ProviderHealth> {
    return { ok: true, version: 'test', latencyMs: 0 };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'test-model', providerId: this.config.id, displayName: 'Test model', locality: 'local', contextLength: 32768, sizeBytes: null, parameterSize: null, quantization: null, loaded: true, capabilities: { chat: true, structuredOutput: true, tools: false, embeddings: false, vision: false } },
      { id: 'test-embed', providerId: this.config.id, displayName: 'Test embeddings', locality: 'local', contextLength: 8192, sizeBytes: null, parameterSize: null, quantization: null, loaded: true, capabilities: { chat: false, structuredOutput: false, tools: false, embeddings: true, vision: false } },
    ];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    calls.push(req);
    let text: string | null = null;
    // honour cancellation like real providers do (HTTP requests are aborted with the signal)
    const aborted = new Promise<never>((_, reject) => {
      if (!req.signal) return;
      const fail = () => reject(new AppError('CANCELLED', 'The model request was cancelled.'));
      if (req.signal.aborted) fail();
      else req.signal.addEventListener('abort', fail, { once: true });
    });
    aborted.catch(() => undefined);
    for (const r of responders) {
      if (r.match(req)) {
        text = await Promise.race([Promise.resolve(r.respond(req)), aborted]);
        if (text !== null) break;
      }
    }
    if (text === null) text = req.jsonSchema ? JSON.stringify(sampleFromSchema(req.jsonSchema.schema)) : `Test answer to: ${req.messages.at(-1)?.content.slice(0, 80) ?? ''}`;
    return {
      text,
      finishReason: 'stop',
      usage: { inputTokens: Math.ceil(JSON.stringify(req.messages).length / 4), outputTokens: Math.ceil(text.length / 4) },
      model: req.model,
      providerId: this.config.id,
      latencyMs: 1,
      structured: !!req.jsonSchema,
    };
  }

  /** Bag-of-words hashing embedding: similar texts get similar vectors, fully deterministic. */
  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const dim = 64;
    const vectors = req.input.map((text) => {
      const v = new Array<number>(dim).fill(0);
      for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((x) => x.length > 2)) {
        const h = parseInt(sha256(w.slice(0, 6)).slice(0, 8), 16);
        v[h % dim]! += 1;
      }
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norm);
    });
    return { vectors, model: req.model, usage: { inputTokens: null } };
  }
}

/** Minimal valid instance of a JSON schema (used when no scenario responder matches). */
export function sampleFromSchema(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 8) return null;
  const s = schema as Record<string, unknown>;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  if (s.const !== undefined) return s.const;
  if (Array.isArray(s.anyOf) && s.anyOf.length) return sampleFromSchema(s.anyOf[0], depth + 1);
  if (Array.isArray(s.oneOf) && s.oneOf.length) return sampleFromSchema(s.oneOf[0], depth + 1);
  const type = Array.isArray(s.type) ? (s.type as string[]).find((t) => t !== 'null') : (s.type as string | undefined);
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = (s.properties ?? {}) as Record<string, unknown>;
      const required = new Set((s.required as string[] | undefined) ?? []);
      for (const [k, v] of Object.entries(props)) if (required.has(k)) out[k] = sampleFromSchema(v, depth + 1);
      return out;
    }
    case 'array': {
      const min = typeof s.minItems === 'number' ? s.minItems : 0;
      return Array.from({ length: min }, () => sampleFromSchema(s.items, depth + 1));
    }
    case 'string': {
      const min = typeof s.minLength === 'number' ? s.minLength : 1;
      if (s.format === 'date') return '2026-01-01';
      if (s.format === 'date-time') return '2026-01-01T00:00:00Z';
      if (s.format === 'uri') return 'https://example.com';
      return 'x'.repeat(Math.max(1, min));
    }
    case 'integer':
    case 'number':
      return typeof s.minimum === 'number' ? s.minimum : 0;
    case 'boolean':
      return false;
    default:
      return null;
  }
}
