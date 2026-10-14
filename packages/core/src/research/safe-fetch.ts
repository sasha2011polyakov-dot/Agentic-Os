import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { NetworkPolicy } from '../net/policy.ts';
import { AppError } from '../util/errors.ts';

const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
blocked.addAddress('255.255.255.255', 'ipv4');
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['100::', 64]] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** True when the address is public (not loopback/private/link-local/CGNAT/multicast/reserved, incl. IPv4-mapped IPv6). */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, 'ipv4');
  if (family === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower) ?? /^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPublicAddress(mapped[1]!);
    if (/^::ffff:[0-9a-f]+:[0-9a-f]+$/.test(lower)) return false; // hex-form mapped IPv4: refuse rather than decode
    return !blocked.check(address, 'ipv6');
  }
  return false;
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  redirects: string[];
  truncated: boolean;
}

export interface FetchOptions {
  maxBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  systemId?: string;
  accept?: string[];
  allowHttp?: boolean;
}

export type Transport = (url: URL, opts: { lookup: typeof dnsLookup; timeoutMs: number; signal?: AbortSignal; headers: Record<string, string> }) => Promise<IncomingMessage>;

const DEFAULT_ACCEPT = ['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'application/json', 'text/x-markdown'];

function defaultTransport(url: URL, opts: { lookup: typeof dnsLookup; timeoutMs: number; signal?: AbortSignal; headers: Record<string, string> }): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const fn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = fn(url, { method: 'GET', headers: opts.headers, lookup: opts.lookup, timeout: opts.timeoutMs, ...(opts.signal ? { signal: opts.signal } : {}) }, resolve);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * SSRF-safe page loader for agents. Every hop: scheme check → NetworkPolicy (offline!) → DNS resolution with
 * ALL addresses validated → connection pinned to a validated address → manual redirect handling (≤5) →
 * content-type allow-list → streamed size limit. No cookies, no credentials.
 */
export class SafeFetcher {
  constructor(
    private readonly policy: NetworkPolicy,
    private readonly transport: Transport = defaultTransport,
    /** Tests can widen this; production never does. */
    private readonly addressAllowed: (address: string) => boolean = isPublicAddress,
  ) {}

  private pinnedLookup(): typeof dnsLookup {
    const allowed = this.addressAllowed;
    return ((hostname: string, options: unknown, callback: (err: NodeJS.ErrnoException | null, address?: string | LookupAddress[], family?: number) => void) => {
      const opts = typeof options === 'object' && options !== null ? (options as { all?: boolean }) : {};
      dnsLookup(hostname, { all: true }, (err, addresses) => {
        if (err) return callback(err);
        const list = addresses as LookupAddress[];
        const bad = list.find((a) => !allowed(a.address));
        if (bad || list.length === 0) {
          const e = new Error(`blocked address ${bad?.address ?? '(none)'}`) as NodeJS.ErrnoException;
          e.code = 'EAOS_BLOCKED';
          return callback(e);
        }
        if (opts.all) return callback(null, list);
        return callback(null, list[0]!.address, list[0]!.family);
      });
    }) as unknown as typeof dnsLookup;
  }

  async fetch(rawUrl: string, opts: FetchOptions = {}): Promise<FetchedPage> {
    const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
    const timeoutMs = opts.timeoutMs ?? 20_000;
    const accept = opts.accept ?? DEFAULT_ACCEPT;
    const redirects: string[] = [];
    let current: URL;
    try {
      current = new URL(rawUrl);
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Invalid URL.');
    }
    for (let hop = 0; hop <= 5; hop++) {
      if (current.protocol !== 'https:' && !(current.protocol === 'http:' && opts.allowHttp)) {
        throw new AppError('FETCH_BLOCKED', `Only HTTPS addresses are allowed (got ${current.protocol}).`);
      }
      if (current.username || current.password) throw new AppError('FETCH_BLOCKED', 'URLs with credentials are not allowed.');
      this.policy.check(current, 'web-research', opts.systemId);
      const host = current.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host) && !this.addressAllowed(host)) throw new AppError('FETCH_BLOCKED', undefined, { details: { host } });
      if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw new AppError('FETCH_BLOCKED', undefined, { details: { host } });
      let res: IncomingMessage;
      try {
        res = await this.transport(current, {
          lookup: this.pinnedLookup(),
          timeoutMs,
          ...(opts.signal ? { signal: opts.signal } : {}),
          headers: { 'user-agent': 'AgenticOS/0.1 (local research assistant)', accept: accept.join(', ') + ';q=0.9, */*;q=0.1', 'accept-language': 'ru,en;q=0.8' },
        });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        if (err.code === 'EAOS_BLOCKED' || /blocked address/.test(err.message)) throw new AppError('FETCH_BLOCKED', undefined, { details: { host, reason: err.message } });
        if (err.name === 'AbortError') throw new AppError('CANCELLED');
        throw new AppError('FETCH_FAILED', `Could not download ${current.host}: ${err.message}`);
      }
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        let next: URL;
        try {
          next = new URL(res.headers.location, current);
        } catch {
          throw new AppError('FETCH_FAILED', 'Invalid redirect address.');
        }
        redirects.push(next.toString());
        current = next;
        continue;
      }
      const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
      const mime = contentType.split(';')[0]!.trim();
      if (status >= 400) {
        res.resume();
        throw new AppError('FETCH_FAILED', `The server responded ${status}.`, { details: { status, url: current.toString() } });
      }
      if (mime && !accept.includes(mime)) {
        res.resume();
        throw new AppError('FETCH_FAILED', `The content type ${mime} is not supported for analysis.`, { details: { contentType: mime } });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      for await (const chunk of res) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) {
          truncated = true;
          res.destroy();
          break;
        }
        chunks.push(chunk as Buffer);
      }
      return { url: rawUrl, finalUrl: current.toString(), status, contentType: mime, body: Buffer.concat(chunks), redirects, truncated };
    }
    throw new AppError('FETCH_FAILED', 'Too many redirects.');
  }
}
