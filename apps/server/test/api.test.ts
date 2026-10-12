import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, type RunningApp } from '../src/index.ts';

let app: RunningApp;
let root: string;
let cookie = '';

async function api<T = unknown>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${app.http.url}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-aos-request': '1', origin: app.http.url } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, data: (await res.json()) as T };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'aos-api-'));
  app = await startApp({ dataDir: join(root, 'data'), port: 0, logLevel: 'error' });
  const res = await fetch(app.http.loginUrl, { redirect: 'manual' });
  cookie = res.headers.get('set-cookie')!.split(';')[0]!;
});

afterAll(async () => {
  await app.stop();
  await rm(root, { recursive: true, force: true });
});

describe('local API security', () => {
  it('rejects unauthenticated, cross-origin and header-less mutating requests', async () => {
    expect((await fetch(`${app.http.url}/api/systems`)).status).toBe(401);
    const noHeader = await fetch(`${app.http.url}/api/systems`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(noHeader.status).toBe(401);
    const evil = await api('POST', '/api/systems', { name: 'x', storagePath: '/tmp/x' }, { origin: 'https://evil.example' });
    expect(evil.status).toBe(401);
    const wrongLogin = await fetch(`${app.http.url}/auth?token=nope`, { redirect: 'manual' });
    expect(wrongLogin.status).toBe(401);
  });
});

describe('systems and documents over HTTP', () => {
  it('creates a system, a document, searches it and returns structured errors', async () => {
    const created = await api<{ system: { systemId: string } }>('POST', '/api/systems', { name: 'API', storagePath: join(root, 'sys'), template: 'starter' });
    expect(created.status).toBe(200);
    const sid = created.data.system.systemId;
    const doc = await api<{ doc: { id: string; diskHash: string } }>('POST', `/api/systems/${sid}/docs`, { title: 'HTTP заметка', content: 'Текст про пингвинов' });
    expect(doc.status).toBe(200);
    const search = await api<{ total: number; hits: { title: string }[] }>('GET', `/api/systems/${sid}/search?q=${encodeURIComponent('пингвин')}`);
    expect(search.data.hits[0]!.title).toBe('HTTP заметка');
    const conflict = await api<{ error: { code: string; hint: string } }>('PUT', `/api/systems/${sid}/docs/${doc.data.doc.id}`, { content: 'x', expectedHash: 'stale' });
    expect(conflict.status).toBe(409);
    expect(conflict.data.error.code).toBe('WRITE_CONFLICT');
    expect(conflict.data.error.hint).toBeTruthy();
    const missing = await api<{ error: { code: string } }>('GET', `/api/systems/sys_00000000000000000000000000/docs`);
    expect(missing.data.error.code).toBe('NOT_FOUND');
    const graph = await api<{ nodes: unknown[] }>('GET', `/api/systems/${sid}/graph`);
    expect(graph.data.nodes.length).toBeGreaterThanOrEqual(3);
  });
});
