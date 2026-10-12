import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppCore } from '@aos/core';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  body: unknown;
  core: AppCore;
  /** Set when the handler takes over the response (files, SSE). */
  handled?: boolean;
}

export type Handler = (ctx: RouteContext) => unknown | Promise<unknown>;

export interface RawResponse {
  __raw: true;
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export function raw(body: Buffer | string, headers: Record<string, string>, status = 200): RawResponse {
  return { __raw: true, status, headers, body };
}

export function isRaw(v: unknown): v is RawResponse {
  return typeof v === 'object' && v !== null && (v as { __raw?: unknown }).__raw === true;
}

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
  maxBodyBytes: number;
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts: { maxBodyBytes?: number } = {}): void {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler, maxBodyBytes: opts.maxBodyBytes ?? 2 * 1024 * 1024 });
  }

  get(p: string, h: Handler) {
    this.add('GET', p, h);
  }
  post(p: string, h: Handler, opts?: { maxBodyBytes?: number }) {
    this.add('POST', p, h, opts);
  }
  put(p: string, h: Handler, opts?: { maxBodyBytes?: number }) {
    this.add('PUT', p, h, opts);
  }
  patch(p: string, h: Handler) {
    this.add('PATCH', p, h);
  }
  delete(p: string, h: Handler) {
    this.add('DELETE', p, h);
  }

  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | { notAllowed: true } | null {
    const parts = pathname.split('/').filter(Boolean).map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i]!;
        if (seg.startsWith(':')) params[seg.slice(1)] = parts[i]!;
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route, params };
    }
    return methodMismatch ? { notAllowed: true } : null;
  }
}
