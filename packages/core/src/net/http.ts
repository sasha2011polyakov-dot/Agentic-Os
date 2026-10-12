import { AppError } from '../util/errors.ts';
import type { NetPurpose, NetworkPolicy } from './policy.ts';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST' | 'DELETE' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  purpose: NetPurpose;
  timeoutMs?: number;
  signal?: AbortSignal;
  systemId?: string;
}

export interface HttpResponse<T> {
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
  text: string;
}

/** Thrown for transport failures (connection refused, DNS, timeout) — distinct from HTTP error statuses. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'aborted' | 'network',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'TransportError';
  }
}

/**
 * The only module in core allowed to call fetch(). Every request is checked by NetworkPolicy first,
 * so offline/local-only guarantees hold for all providers and tools (verified by a boundary test).
 */
export class HttpClient {
  constructor(private readonly policy: NetworkPolicy) {}

  async request(req: HttpRequest): Promise<Response> {
    const url = new URL(req.url);
    this.policy.check(url, req.purpose, req.systemId);
    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? 60_000;
    const timer = setTimeout(() => controller.abort(new TransportError(`timeout after ${timeoutMs} ms`, 'timeout')), timeoutMs);
    const onAbort = () => controller.abort(new TransportError('aborted', 'aborted'));
    if (req.signal) {
      if (req.signal.aborted) onAbort();
      else req.signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const init: RequestInit = { method: req.method ?? 'GET', headers: req.headers ?? {}, signal: controller.signal, redirect: 'error' };
      if (req.body !== undefined) init.body = req.body;
      return await fetch(url, init);
    } catch (e) {
      const reason = controller.signal.reason;
      if (reason instanceof TransportError) throw reason;
      throw new TransportError(e instanceof Error ? describeFetchError(e) : String(e), 'network', { cause: e });
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  async json<T>(req: HttpRequest): Promise<HttpResponse<T>> {
    const res = await this.request({ ...req, headers: { accept: 'application/json', ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}), ...req.headers } });
    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = undefined;
      }
    }
    return { status: res.status, ok: res.ok, headers: res.headers, data: data as T, text };
  }
}

function describeFetchError(e: Error): string {
  const cause = (e as { cause?: { code?: string; message?: string } }).cause;
  if (cause?.code) return `${cause.code}: ${cause.message ?? e.message}`;
  return e.message;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AppError('CANCELLED'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AppError('CANCELLED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
