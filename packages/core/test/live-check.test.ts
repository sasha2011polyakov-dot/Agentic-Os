import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { liveCheckMarkdown, runLiveCheck } from '../src/ai/live-check.ts';
import { startTestApp, type TestApp } from './helpers.ts';

/**
 * The live check itself (the harness), against a local server that speaks the Ollama protocol and answers every
 * schema-bound request with the SMALLEST value that satisfies the schema. This proves that the check drives every
 * stage and reports honestly; it says nothing about model quality — that needs a real model.
 */

function sample(schema: Record<string, unknown> | undefined, depth = 0): unknown {
  if (!schema || depth > 12) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum)) return (schema.enum as unknown[]).includes('final') ? 'final' : schema.enum[0];
  if (Array.isArray(schema.anyOf)) return sample(schema.anyOf[0] as Record<string, unknown>, depth + 1);
  if (Array.isArray(schema.oneOf)) return sample(schema.oneOf[0] as Record<string, unknown>, depth + 1);
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string | undefined];
  const type = types.find((t) => t && t !== 'null') ?? (schema.properties ? 'object' : schema.items ? 'array' : 'string');
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries((schema.properties as Record<string, Record<string, unknown>>) ?? {})) out[k] = sample(v, depth + 1);
      return out;
    }
    case 'array':
      return Array.from({ length: Number(schema.minItems ?? 0) }, () => sample(schema.items as Record<string, unknown>, depth + 1));
    case 'integer':
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : typeof schema.maximum === 'number' && schema.maximum < 1 ? schema.maximum : 1;
    case 'boolean':
      return false;
    case 'string': {
      const p = typeof schema.pattern === 'string' ? schema.pattern : '';
      const m = /^\^([A-Z]+-?)\[0-9\](?:\+|\{(\d)\})\$$/.exec(p);
      if (m) return `${m[1]}${'1'.padStart(Number(m[2] ?? 1), '0')}`;
      return 'x'.repeat(Math.max(1, Number(schema.minLength ?? 1)));
    }
    default:
      return null;
  }
}

const servers: Server[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  while (servers.length) await new Promise((r) => servers.pop()!.close(r));
});

async function fakeOllama(): Promise<{ base: string; chats: () => number }> {
  let chats = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const send = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.url === '/api/version') return send({ version: '0.12.0' });
      if (req.url === '/api/tags') return send({ models: [{ name: 'schema-echo:1b', size: 1 }] });
      if (req.url === '/api/ps') return send({ models: [] });
      if (req.url === '/api/show') return send({ capabilities: ['completion'], model_info: { 'llama.context_length': 32768 }, details: { parameter_size: '1B', quantization_level: 'Q4_K_M' } });
      if (req.url === '/api/chat') {
        chats++;
        const format = body.format as Record<string, unknown> | undefined;
        return send({ message: { role: 'assistant', content: JSON.stringify(format ? sample(format) : { text: 'ok' }) }, done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 20 });
      }
      res.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, chats: () => chats };
}

describe('live AI check (the harness)', () => {
  it('drives the provider, the agents and the missions, and reports what happened without embellishing it', async () => {
    const t: TestApp = await startTestApp();
    cleanups.push(() => t.cleanup());
    const server = await fakeOllama();
    const lines: string[] = [];
    const report = await runLiveCheck(t.core, { provider: 'ollama', baseUrl: server.base, agents: ['mission-analyst', 'documenter', 'verifier'], workDir: join(t.root, 'live'), missionTimeoutMinutes: 2, onProgress: (l) => lines.push(l) });

    expect(report.provider).toMatchObject({ kind: 'ollama', model: 'schema-echo:1b', contextLength: 16384, locality: 'local' });
    expect(report.steps.map((s) => [s.name, s.status])).toEqual([
      ['Provider answers', 'passed'],
      ['Model is available', 'passed'],
      ['Structured answer (JSON schema)', 'passed'],
    ]);
    // every requested agent ran its own test cases against the server
    expect(report.agents.map((a) => a.id)).toEqual(['documenter', 'mission-analyst', 'verifier']);
    // both missions ran to an end state; with minimal answers they cannot be "Completed" honestly
    expect(report.missions).toHaveLength(2);
    for (const m of report.missions) expect(['completed', 'partially_completed', 'failed', 'cancelled', 'needs_input', 'awaiting_approval']).toContain(m.status);
    expect(report.usage.calls).toBeGreaterThan(3);
    expect(report.usage.calls).toBe(server.chats());
    const md = liveCheckMarkdown(report);
    expect(md).toContain('schema-echo:1b');
    expect(md).toContain('## Mission: Plan over the notes (plan)');
    expect(lines.some((l) => l.startsWith('✓ Provider answers'))).toBe(true);
  }, 120_000);

  it('reports an unreachable provider as failed and does not pretend the rest ran', async () => {
    const t: TestApp = await startTestApp();
    cleanups.push(() => t.cleanup());
    const report = await runLiveCheck(t.core, { provider: 'ollama', baseUrl: 'http://127.0.0.1:9', workDir: join(t.root, 'live') });
    expect(report.ok).toBe(false);
    expect(report.steps.map((s) => s.status)).toEqual(['failed', 'not_run', 'not_run', 'not_run', 'not_run']);
    expect(report.steps[0]!.detail).toMatch(/cannot connect/);
    expect(report.agents).toEqual([]);
    expect(report.missions).toEqual([]);
  });
});
