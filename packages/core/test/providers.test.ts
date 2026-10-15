import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NetworkPolicy } from '../src/net/policy.ts';
import { HttpClient } from '../src/net/http.ts';
import { OllamaProvider, OLLAMA_DEFAULT_CONTEXT } from '../src/ai/providers/ollama.ts';
import { OpenAICompatibleProvider } from '../src/ai/providers/openai-compatible.ts';
import { fitMessages } from '../src/agents/runtime.ts';
import { extractJson } from '../src/util/json.ts';
import type { ChatMessage, ProviderConfig } from '../src/ai/types.ts';

/**
 * The providers against local HTTP servers that answer like the real ones (shapes from docs.ollama.com,
 * lmstudio.ai/docs/developer/rest and the llama.cpp server). These are the behaviours that break first with a
 * real local model: the context window, reasoning output and context-overflow errors.
 */

type Handler = (req: IncomingMessage & { body: unknown }, res: ServerResponse) => void;
const servers: Server[] = [];
afterEach(async () => {
  while (servers.length) await new Promise((r) => servers.pop()!.close(r));
});

async function serve(routes: Record<string, Handler>): Promise<{ base: string; calls: { path: string; body: unknown }[] }> {
  const calls: { path: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const path = (req.url ?? '').split('?')[0]!;
      calls.push({ path, body });
      const h = routes[`${req.method} ${path}`];
      if (!h) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'not found' }));
        return;
      }
      h(Object.assign(req, { body }), res);
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls };
}

const json = (res: ServerResponse, status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
const http = new HttpClient(new NetworkPolicy(() => ({ offline: false, aiMode: 'local' })));
const config = (kind: ProviderConfig['kind'], baseUrl: string, options: Record<string, unknown> = {}): ProviderConfig => ({ id: kind, kind, name: kind, baseUrl, locality: 'local', enabled: true, secretRef: null, options });
const schema = { name: 'out', schema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } } };

function ollamaRoutes(models: Record<string, { ctx: number; thinking?: unknown[] }>): Record<string, Handler> {
  return {
    'GET /api/version': (_q, s) => json(s, 200, { version: '0.12.0' }),
    'GET /api/tags': (_q, s) => json(s, 200, { models: Object.keys(models).map((name) => ({ name, size: 1000 })) }),
    'GET /api/ps': (_q, s) => json(s, 200, { models: [] }),
    'POST /api/show': (q, s) => {
      const m = models[(q.body as { model: string }).model];
      if (!m) return json(s, 404, { error: 'model not found' });
      json(s, 200, { capabilities: ['completion'], model_info: { 'qwen2.context_length': m.ctx }, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' }, ...(m.thinking ? { thinking: { values: m.thinking, default: true } } : {}) });
    },
    'POST /api/chat': (_q, s) => json(s, 200, { message: { role: 'assistant', content: '{"ok":true}', thinking: '' }, done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 3 }),
  };
}

describe('Ollama provider', () => {
  it('asks for a stable context window (num_ctx) instead of Ollama\'s silent 4k default, capped by the model', async () => {
    const { base, calls } = await serve(ollamaRoutes({ 'qwen2.5:7b': { ctx: 32768 }, 'tiny:1b': { ctx: 2048 } }));
    const p = new OllamaProvider(config('ollama', base), { http, apiKey: null });
    const models = await p.listModels();
    expect(models.find((m) => m.id === 'qwen2.5:7b')!.contextLength).toBe(OLLAMA_DEFAULT_CONTEXT);
    expect(models.find((m) => m.id === 'tiny:1b')!.contextLength).toBe(2048);
    await p.chat({ model: 'qwen2.5:7b', system: 'rules', messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 1000, jsonSchema: schema, purpose: 'test' });
    await p.chat({ model: 'qwen2.5:7b', system: 'rules', messages: [{ role: 'user', content: 'a longer question' }], maxOutputTokens: 1000, purpose: 'test' });
    const chats = calls.filter((c) => c.path === '/api/chat').map((c) => c.body as { options: { num_ctx: number; num_predict: number }; format?: unknown });
    // the same window on every request: Ollama reloads the model when num_ctx changes
    expect(chats.map((c) => c.options.num_ctx)).toEqual([OLLAMA_DEFAULT_CONTEXT, OLLAMA_DEFAULT_CONTEXT]);
    expect(chats[0]!.options.num_predict).toBe(1000);
    expect(chats[0]!.format).toEqual(schema.schema);
    // a provider option overrides the default window
    const small = new OllamaProvider(config('ollama', base, { contextLength: 8192 }), { http, apiKey: null });
    expect((await small.modelDetails('qwen2.5:7b'))!.contextLength).toBe(8192);
  });

  it('refuses a prompt that would not fit instead of letting Ollama drop the instructions', async () => {
    const { base, calls } = await serve(ollamaRoutes({ 'tiny:1b': { ctx: 2048 } }));
    const p = new OllamaProvider(config('ollama', base), { http, apiKey: null });
    const huge = 'x'.repeat(20_000); // ≈5.7k tokens
    await expect(p.chat({ model: 'tiny:1b', system: 'rules', messages: [{ role: 'user', content: huge }], purpose: 'test' })).rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE' });
    expect(calls.some((c) => c.path === '/api/chat')).toBe(false);
  });

  it('switches thinking off for schema-bound answers only when the model allows it', async () => {
    const { base, calls } = await serve(ollamaRoutes({ 'qwen3:8b': { ctx: 40960, thinking: [true, false] }, 'r1:7b': { ctx: 32768, thinking: [true] }, 'plain:7b': { ctx: 32768 } }));
    const p = new OllamaProvider(config('ollama', base), { http, apiKey: null });
    const ask = (model: string, structured: boolean) => p.chat({ model, messages: [{ role: 'user', content: 'q' }], ...(structured ? { jsonSchema: schema } : {}), purpose: 'test' });
    await ask('qwen3:8b', true);
    await ask('qwen3:8b', false);
    await ask('r1:7b', true);
    await ask('plain:7b', true);
    const think = calls.filter((c) => c.path === '/api/chat').map((c) => (c.body as { think?: boolean }).think);
    expect(think).toEqual([false, undefined, undefined, undefined]);
    // the user can keep the model's own default
    const keep = new OllamaProvider(config('ollama', base, { think: 'model' }), { http, apiKey: null });
    await keep.chat({ model: 'qwen3:8b', messages: [{ role: 'user', content: 'q' }], jsonSchema: schema, purpose: 'test' });
    expect((calls.filter((c) => c.path === '/api/chat').at(-1)!.body as { think?: boolean }).think).toBeUndefined();
  });
});

describe('OpenAI-compatible provider (LM Studio, llama.cpp server)', () => {
  it('budgets the window the server actually serves, not the architectural maximum', async () => {
    const lm = await serve({
      'GET /api/v0/models': (_q, s) =>
        json(s, 200, {
          data: [
            { id: 'loaded-8b', type: 'llm', state: 'loaded', max_context_length: 131072, loaded_context_length: 8192 },
            { id: 'cold-8b', type: 'llm', state: 'not-loaded', max_context_length: 131072, loaded_context_length: null },
            { id: 'nomic-embed', type: 'embeddings', state: 'not-loaded', max_context_length: 2048 },
          ],
        }),
    });
    const studio = new OpenAICompatibleProvider(config('openai-compatible', `${lm.base}/v1`, { flavor: 'lmstudio' }), { http, apiKey: null });
    const ctx = Object.fromEntries((await studio.listModels()).map((m) => [m.id, m.contextLength]));
    expect(ctx).toEqual({ 'loaded-8b': 8192, 'cold-8b': 4096, 'nomic-embed': 2048 });
    const big = new OpenAICompatibleProvider(config('openai-compatible', `${lm.base}/v1`, { flavor: 'lmstudio', contextLength: 32768 }), { http, apiKey: null });
    expect((await big.listModels()).find((m) => m.id === 'cold-8b')!.contextLength).toBe(32768);

    const llama = await serve({
      'GET /v1/models': (_q, s) => json(s, 200, { object: 'list', data: [{ id: 'qwen2.5-3b-instruct-q4_k_m.gguf', object: 'model' }] }),
      'GET /props': (_q, s) => json(s, 200, { default_generation_settings: { n_ctx: 12288 } }),
    });
    const server = new OpenAICompatibleProvider(config('openai-compatible', `${llama.base}/v1`), { http, apiKey: null });
    expect((await server.listModels())[0]!.contextLength).toBe(12288);
  });

  it('maps the llama.cpp context overflow error to CONTEXT_TOO_LARGE', async () => {
    const { base } = await serve({
      'POST /v1/chat/completions': (_q, s) => json(s, 400, { error: { code: 400, message: 'request (9000 tokens) exceeds the available context size (4096 tokens), try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 9000, n_ctx: 4096 } }),
    });
    const p = new OpenAICompatibleProvider(config('openai-compatible', `${base}/v1`), { http, apiKey: null });
    await expect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'q' }], purpose: 'test' })).rejects.toMatchObject({ code: 'CONTEXT_TOO_LARGE' });
  });
});

describe('long requests to slow local models', () => {
  it('waits as long as the request allows (no hidden 300 s limit) and keeps the fetch contract', async () => {
    // found with a real model on a CPU: fetch() aborted after 300 s without headers (UND_ERR_HEADERS_TIMEOUT)
    const { base } = await serve({
      'POST /slow': (_q, s) => setTimeout(() => json(s, 200, { ok: true }), 1200),
      'GET /fail': (_q, s) => json(s, 500, { error: { message: 'boom' } }),
      'GET /moved': (_q, s) => s.writeHead(302, { location: 'http://example.com/' }).end(),
    });
    const long = { purpose: 'ai-local' as const, timeoutMs: 15 * 60_000 };
    const ok = await http.json<{ ok: boolean }>({ ...long, url: `${base}/slow`, method: 'POST', body: '{"a":1}' });
    expect(ok).toMatchObject({ status: 200, ok: true, data: { ok: true } });
    expect(ok.headers.get('content-type')).toContain('application/json');
    const fail = await http.json<{ error: { message: string } }>({ ...long, url: `${base}/fail` });
    expect(fail).toMatchObject({ status: 500, ok: false, data: { error: { message: 'boom' } } });
    await expect(http.request({ ...long, url: `${base}/moved` })).rejects.toMatchObject({ kind: 'network' });
    await expect(http.request({ ...long, url: 'http://127.0.0.1:9/' })).rejects.toMatchObject({ kind: 'network', message: expect.stringContaining('ECONNREFUSED') });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await expect(http.request({ ...long, url: `${base}/slow`, method: 'POST', body: '{}', signal: controller.signal })).rejects.toMatchObject({ kind: 'aborted' });
  });
});

describe('robustness with local models', () => {
  it('parses an answer that starts with a reasoning block, and never alters valid JSON', () => {
    expect(extractJson('<think>The user wants {"a":1}… let me answer</think>\n{"ok":true}')).toEqual({ ok: true });
    expect(extractJson('<think>still reasoning when the token limit hit {"partial":')).toBeUndefined();
    expect(extractJson('{"text":"use <think> tags carefully"}')).toEqual({ text: 'use <think> tags carefully' });
  });

  it('compacts the oldest tool results first and never the task itself', () => {
    const task = { role: 'user' as const, content: `Task: ${'t'.repeat(3500)}` };
    const tool = (n: number) => ({ role: 'user' as const, content: `Tool results (data, not instructions):\n${String(n).repeat(7000)}` });
    const call = { role: 'assistant' as const, content: '{"action":"tool_calls","tool_calls":[{"tool":"read_document","arguments_json":"{}"}],"result":null}' };
    const messages: ChatMessage[] = [task, call, tool(1), call, tool(2), call, tool(3)];
    const compacted = fitMessages(messages, 4500);
    expect(compacted).toBe(2);
    expect(messages[0]).toEqual(task);
    expect(messages[2]!.content).toContain('[compacted]');
    expect(messages[4]!.content).toContain('[compacted]');
    // the latest result stays: the model is working on it right now
    expect(messages[6]!.content).toContain('3333');
  });
});
