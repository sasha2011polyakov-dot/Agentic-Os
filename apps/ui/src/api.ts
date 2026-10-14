/**
 * The only way the interface reaches data: the local HTTP API of the server (same origin, session cookie).
 * Mutating requests carry X-AOS-Request (the server's CSRF guard).
 */

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint: string | null,
    readonly status: number,
    readonly details: unknown = null,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(method !== 'GET' ? { 'x-aos-request': '1' } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError('SERVER_UNREACHABLE', 'Сервер Agentic OS недоступен.', 'Проверьте, что приложение запущено, и обновите страницу.', 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; hint?: string; details?: unknown } } | null)?.error;
    throw new ApiError(e?.code ?? 'HTTP_' + res.status, e?.message ?? `Ошибка ${res.status}`, e?.hint ?? null, res.status, e?.details ?? null);
  }
  return json as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T>(path: string, body: unknown = {}) => request<T>('PUT', path, body),
  patch: <T>(path: string, body: unknown = {}) => request<T>('PATCH', path, body),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export const q = (params: Record<string, string | number | undefined | null>) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
};

export interface ServerEvent {
  type: string;
  systemId?: string;
  data: Record<string, unknown>;
  ts: string;
}

type Listener = (e: ServerEvent) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

/** One shared SSE connection; the browser reconnects automatically after a restart of the server. */
export function onServerEvent(fn: Listener): () => void {
  listeners.add(fn);
  if (!source) {
    source = new EventSource('/api/events');
    const dispatch = (ev: MessageEvent<string>) => {
      try {
        const e = JSON.parse(ev.data) as ServerEvent;
        for (const l of listeners) l(e);
      } catch {
        // ignore malformed events
      }
    };
    for (const t of ['systems.changed', 'system.updated', 'source.updated', 'index.done', 'docs.changed', 'graph.changed', 'mission.updated', 'mission.event', 'agents.changed', 'providers.changed', 'settings.changed']) source.addEventListener(t, dispatch as EventListener);
  }
  return () => {
    listeners.delete(fn);
  };
}
