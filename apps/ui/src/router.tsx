import { useEffect, useState, type AnchorHTMLAttributes, type MouseEvent } from 'react';

/** Minimal client router over the History API: every screen has its own URL, back/forward work. */

const listeners = new Set<() => void>();

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (to === location.pathname + location.search) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  for (const l of listeners) l();
}

window.addEventListener('popstate', () => {
  for (const l of listeners) l();
});

export interface Location {
  path: string;
  query: URLSearchParams;
}

export function useLocation(): Location {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

/** Matches `/s/:sid/note/:docId` style patterns; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i]!.startsWith(':')) out[p[i]!.slice(1)] = decodeURIComponent(s[i]!);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  return (
    <a
      href={to}
      {...rest}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
    />
  );
}

export const paths = {
  system: (sid: string) => `/s/${encodeURIComponent(sid)}`,
  note: (sid: string, docId: string) => `/s/${encodeURIComponent(sid)}/note/${encodeURIComponent(docId)}`,
  search: (sid: string, query = '') => `/s/${encodeURIComponent(sid)}/search${query ? `?q=${encodeURIComponent(query)}` : ''}`,
  graph: (sid: string) => `/s/${encodeURIComponent(sid)}/graph`,
  missions: (sid: string) => `/s/${encodeURIComponent(sid)}/missions`,
  newMission: (sid: string) => `/s/${encodeURIComponent(sid)}/missions/new`,
  mission: (sid: string, mid: string) => `/s/${encodeURIComponent(sid)}/missions/${encodeURIComponent(mid)}`,
  newSystem: () => '/systems/new',
};
