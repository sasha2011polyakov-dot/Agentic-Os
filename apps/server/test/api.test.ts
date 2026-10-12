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

describe('AI, agents and change sets over HTTP', () => {
  it('manages providers without ever returning keys, installs agents with explicit grants and imports packages', async () => {
    const sys = await api<{ system: { systemId: string } }>('POST', '/api/systems', { name: 'AI API', storagePath: join(root, 'sys-ai'), template: 'empty' });
    const sid = sys.data.system.systemId;
    const providers = await api<{ providers: { id: string; locality: string }[]; presets: unknown[] }>('GET', '/api/ai/providers');
    expect(providers.data.providers.map((p) => p.id).sort()).toEqual(['lmstudio', 'ollama']);
    const created = await api<{ provider: { id: string } }>('POST', '/api/ai/providers', { kind: 'openai-compatible', name: 'Cloud', baseUrl: 'https://api.openai.com/v1', locality: 'cloud' });
    expect(created.status).toBe(200);
    const key = 'sk-proj-SUPERSECRET-0123456789abcdef';
    const setKey = await api<{ key: { present: boolean; masked: string } }>('PUT', `/api/ai/providers/${created.data.provider.id}/key`, { apiKey: key, backend: 'session' });
    expect(setKey.data.key.present).toBe(true);
    const list = await fetch(`${app.http.url}/api/ai/providers`, { headers: { cookie } });
    expect(await list.text()).not.toContain('SUPERSECRET');
    // a "local" provider pointing to the internet is rejected
    const bad = await api<{ error: { code: string } }>('POST', '/api/ai/providers', { kind: 'ollama', name: 'x', baseUrl: 'https://example.com', locality: 'local' });
    expect(bad.data.error.code).toBe('VALIDATION_FAILED');
    // routes: local mode, no models cached → honest NO_MODEL_CONFIGURED per task type
    const routes = await api<{ routes: { taskType: string; route: unknown; error?: { code: string } }[] }>('GET', `/api/systems/${sid}/ai/routes`);
    expect(routes.data.routes.find((r) => r.taskType === 'generation')!.error!.code).toBe('NO_MODEL_CONFIGURED');

    const catalog = await api<{ catalog: { id: string; scope: string; installed: boolean }[] }>('GET', `/api/systems/${sid}/agents/catalog`);
    expect(catalog.data.catalog.filter((c) => c.scope === 'builtin')).toHaveLength(22);
    const inst = await api<{ agent: { enabled: boolean; grants: { permission: string }[] } }>('POST', `/api/systems/${sid}/agents/install`, { id: 'inventory-analyst', scope: 'builtin', grants: ['projects.read'] });
    expect(inst.data.agent.enabled).toBe(false);
    expect(inst.data.agent.grants.map((g) => g.permission)).toEqual(['projects.read']);
    const unknown = await api<{ error: { code: string } }>('POST', `/api/systems/${sid}/agents/install`, { id: 'inventory-analyst', scope: 'builtin', grants: ['root.all'] });
    expect(unknown.data.error.code).toBe('VALIDATION_FAILED');

    // export → import as a system package under a new id via the definitions API round trip
    const exp = await fetch(`${app.http.url}/api/systems/${sid}/agents/inventory-analyst/export`, { headers: { cookie } });
    expect(exp.headers.get('content-type')).toBe('application/zip');
    const zip = Buffer.from(await exp.arrayBuffer());
    const imp = await fetch(`${app.http.url}/api/systems/${sid}/agents/import`, { method: 'POST', headers: { cookie, 'content-type': 'application/zip', 'x-aos-request': '1', origin: app.http.url }, body: zip });
    const impData = (await imp.json()) as { error?: { code: string; message: string } };
    expect(impData.error?.code).toBe('AGENT_PACKAGE_INVALID'); // id is taken by the built-in agent
    expect(impData.error?.message).toContain('занят встроенным');

    const changes = await api<{ changeSets: unknown[] }>('GET', `/api/systems/${sid}/changes`);
    expect(changes.data.changeSets).toEqual([]);
    const usage = await api<{ byModel: unknown[] }>('GET', `/api/ai/usage?systemId=${sid}`);
    expect(usage.status).toBe(200);
  });
});
