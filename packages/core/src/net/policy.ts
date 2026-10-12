import { isIP } from 'node:net';
import { AppError } from '../util/errors.ts';

/** Why a request leaves the process. Every outbound request must declare one. */
export type NetPurpose = 'ai-local' | 'ai-cloud' | 'web-research' | 'model-download';

export type AiMode = 'local' | 'cloud' | 'hybrid';

export interface NetworkState {
  offline: boolean;
  aiMode: AiMode;
}

export interface EgressRecord {
  host: string;
  purpose: NetPurpose;
  allowed: boolean;
  reason?: string;
  systemId?: string;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (h.startsWith('::ffff:')) return isLoopbackHost(h.slice(7));
  return false;
}

/** RFC1918 / ULA / link-local literals and mDNS names — "local network" for user-configured local AI servers. */
export function isPrivateNetworkHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopbackHost(h)) return true;
  if (h.endsWith('.local')) return true;
  if (isIP(h) === 4) {
    const [a, b] = h.split('.').map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  if (isIP(h) === 6) return h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80');
  return false;
}

/**
 * Central egress decision point. Checked BEFORE any DNS lookup so that offline/local modes never leak
 * even the hostname. Records every decision for the audit trail.
 */
export class NetworkPolicy {
  constructor(
    private readonly getState: (systemId?: string) => NetworkState,
    private readonly record: (r: EgressRecord) => void = () => {},
  ) {}

  /** Effective state for a request; systemId lets a system's AI-mode override apply. */
  state(systemId?: string): NetworkState {
    return this.getState(systemId);
  }

  check(url: URL, purpose: NetPurpose, systemId?: string): void {
    const state = this.getState(systemId);
    const host = url.hostname;
    const deny = (code: 'OFFLINE_MODE' | 'NETWORK_POLICY_DENIED', reason: string): never => {
      this.record({ host, purpose, allowed: false, reason, ...(systemId ? { systemId } : {}) });
      throw new AppError(code, undefined, { details: { host, purpose, reason } });
    };
    if (url.protocol !== 'http:' && url.protocol !== 'https:') deny('NETWORK_POLICY_DENIED', `protocol ${url.protocol} is not allowed`);
    const loopback = isLoopbackHost(host);
    if (state.offline && !loopback) deny('OFFLINE_MODE', 'offline mode allows loopback only');
    if (purpose === 'ai-local' && !isPrivateNetworkHost(host)) {
      deny('NETWORK_POLICY_DENIED', 'a provider marked as local must point to this computer or the local network');
    }
    if (purpose === 'ai-cloud' && state.aiMode === 'local') deny('NETWORK_POLICY_DENIED', 'AI mode "local" forbids cloud providers');
    this.record({ host, purpose, allowed: true, ...(systemId ? { systemId } : {}) });
  }
}
