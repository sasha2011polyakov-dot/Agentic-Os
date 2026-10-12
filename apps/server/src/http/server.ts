import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { AppError, randomToken, toAppError, type AppCore, type AppEvent } from '@aos/core';
import { isRaw, Router, type RouteContext } from './router.ts';

export interface ServerOptions {
  core: AppCore;
  router: Router;
  port?: number;
  host?: string;
  uiDir?: string | null;
  /** Fixed token for tests; random otherwise. */
  token?: string;
  devCorsOrigin?: string;
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  token: string;
  /** One-time login URL: sets the session cookie and redirects to the UI. */
  loginUrl: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.md': 'text/markdown; charset=utf-8',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const COOKIE = 'aos_session';

function securityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res: ServerResponse, err: AppError): void {
  sendJson(res, err.status, { error: err.toJSON() });
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new AppError('VALIDATION_FAILED', 'Тело запроса слишком большое.');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  const type = req.headers['content-type'] ?? '';
  // binary uploads (agent packages, system archives, attachments) are passed through as bytes
  if (type.includes('application/zip') || type.includes('application/octet-stream')) return Buffer.concat(chunks);
  const text = Buffer.concat(chunks).toString('utf8');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Некорректный JSON в теле запроса.');
    }
  }
  return text;
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const host = opts.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error('Agentic OS API binds to loopback only.');
  }
  const token = opts.token ?? randomToken(32);
  const sessions = new Set<string>();
  let port = opts.port ?? 0;
  const uiDir = opts.uiDir ? resolve(opts.uiDir) : null;
  const log = opts.core.services.logger.child({ component: 'http' });

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = () => new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...(opts.devCorsOrigin ? [opts.devCorsOrigin] : [])]);

  const isAuthed = (req: IncomingMessage): boolean => {
    const cookie = parseCookies(req.headers.cookie)[COOKIE];
    if (cookie && sessions.has(cookie)) return true;
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ') && safeEqual(auth.slice(7), token)) return true;
    return false;
  };

  const server = createServer(async (req, res) => {
    securityHeaders(res);
    const started = Date.now();
    try {
      // DNS-rebinding protection: only our own loopback host names are accepted.
      if (!req.headers.host || !allowedHosts().has(req.headers.host)) {
        res.writeHead(421, { 'content-type': 'text/plain' });
        res.end('Misdirected request');
        return;
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const method = req.method ?? 'GET';

      if (opts.devCorsOrigin && req.headers.origin === opts.devCorsOrigin) {
        res.setHeader('Access-Control-Allow-Origin', opts.devCorsOrigin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, x-aos-request, authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE');
        if (method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }
      }

      if (url.pathname === '/auth') {
        const t = url.searchParams.get('token') ?? '';
        if (!safeEqual(t, token)) {
          res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('Неверный или устаревший токен. Перезапустите приложение и откройте новую ссылку из консоли.');
          return;
        }
        const session = randomToken(32);
        sessions.add(session);
        res.writeHead(303, { 'set-cookie': `${COOKIE}=${session}; HttpOnly; SameSite=Strict; Path=/`, location: '/' });
        res.end();
        return;
      }

      if (url.pathname === '/api/health') {
        sendJson(res, 200, { ok: true, authenticated: isAuthed(req) });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        if (!isAuthed(req)) return sendError(res, new AppError('UNAUTHORIZED'));
        const mutating = method !== 'GET' && method !== 'HEAD';
        if (mutating) {
          // CSRF: a custom header cannot be sent cross-origin without a preflight we never approve.
          if (req.headers['x-aos-request'] !== '1') return sendError(res, new AppError('UNAUTHORIZED', 'Отсутствует заголовок X-AOS-Request.'));
          const origin = req.headers.origin;
          if (origin && !allowedOrigins().has(origin)) return sendError(res, new AppError('UNAUTHORIZED', 'Запрос с чужого источника отклонён.'));
        }
        if (url.pathname === '/api/events' && method === 'GET') return handleSse(req, res, opts.core, url.searchParams.get('systemId'));
        const m = opts.router.match(method, url.pathname);
        if (!m) return sendError(res, new AppError('NOT_FOUND', 'Метод API не найден.'));
        if ('notAllowed' in m) return sendJson(res, 405, { error: { code: 'VALIDATION_FAILED', message: 'Метод не поддерживается.' } });
        const body = mutating ? await readBody(req, m.route.maxBodyBytes) : undefined;
        const ctx: RouteContext = { req, res, params: m.params, query: url.searchParams, body, core: opts.core };
        const result = await m.route.handler(ctx);
        if (ctx.handled) return;
        if (isRaw(result)) {
          res.writeHead(result.status, { 'cache-control': 'no-store', ...result.headers });
          res.end(result.body);
          return;
        }
        sendJson(res, 200, result === undefined ? { ok: true } : result);
        return;
      }

      if (method !== 'GET') {
        res.writeHead(405);
        res.end();
        return;
      }
      await serveStatic(res, uiDir, url.pathname);
    } catch (e) {
      const err = toAppError(e);
      if (err.code === 'INTERNAL') log.error('request failed', { method: req.method, url: req.url, error: e as Error });
      else log.debug('request error', { code: err.code, url: req.url });
      if (!res.headersSent) sendError(res, err);
      else res.end();
    } finally {
      log.debug('request', { method: req.method, url: req.url?.split('?')[0], ms: Date.now() - started, status: res.statusCode });
    }
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  });
  const addr = server.address();
  if (addr && typeof addr === 'object') port = addr.port;
  const base = `http://127.0.0.1:${port}`;
  return {
    server,
    port,
    url: base,
    token,
    loginUrl: `${base}/auth?token=${encodeURIComponent(token)}`,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

async function serveStatic(res: ServerResponse, uiDir: string | null, pathname: string): Promise<void> {
  if (!uiDir) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP });
    res.end('<!doctype html><meta charset="utf-8"><title>Agentic OS</title><p>Интерфейс не собран. Выполните <code>npm run build</code>.</p>');
    return;
  }
  let rel = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '');
  if (rel.split(sep).includes('..')) rel = 'index.html';
  let file = join(uiDir, rel || 'index.html');
  let isFile = false;
  try {
    isFile = (await stat(file)).isFile();
  } catch {
    isFile = false;
  }
  // SPA fallback: unknown paths (client routes) get index.html; missing assets get 404.
  if (!isFile) {
    if (extname(rel)) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
      return;
    }
    file = join(uiDir, 'index.html');
  }
  const ext = extname(file);
  const body = await readFile(file);
  const headers: Record<string, string> = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
  };
  if (ext === '.html') headers['content-security-policy'] = CSP;
  res.writeHead(200, headers);
  res.end(body);
}

function handleSse(req: IncomingMessage, res: ServerResponse, core: AppCore, _systemId: string | null): void {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(': connected\n\n');
  const send = (e: AppEvent) => {
    res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const off = core.services.events.on(send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    off();
  });
}
