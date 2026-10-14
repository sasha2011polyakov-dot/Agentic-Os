import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, onServerEvent } from './api.ts';
import { AppCtx, type AppState, type Theme } from './ctx.tsx';
import { match, navigate, paths, useLocation } from './router.tsx';
import { ErrorBox, Icon, Spinner } from './ui.tsx';
import type { AppInfo, SystemInfo } from './types.ts';
import { Shell } from './Shell.tsx';
import { CreateSystem } from './pages/CreateSystem.tsx';
import { Palette } from './Palette.tsx';

function initialTheme(): Theme {
  try {
    const t = localStorage.getItem('aos.theme');
    if (t === 'light' || t === 'dark') return t;
  } catch {
    // storage unavailable
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function App() {
  const loc = useLocation();
  const [app, setApp] = useState<AppInfo | null>(null);
  const [systems, setSystems] = useState<SystemInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [palette, setPalette] = useState(false);
  const [docsVersion, setDocsVersion] = useState(0);

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([api.get<AppInfo>('/api/app'), api.get<{ systems: SystemInfo[] }>('/api/systems')]);
      setApp(a);
      setSystems(s.systems);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('aos.theme', theme);
    } catch {
      // storage unavailable
    }
  }, [theme]);

  const sid = match('/s/:sid', loc.path.split('/').slice(0, 3).join('/'))?.sid ?? null;

  useEffect(() => {
    if (!app) return;
    return onServerEvent((e) => {
      if (e.type === 'systems.changed' || e.type === 'system.updated') void load();
      if ((e.type === 'docs.changed' || e.type === 'index.done') && (!e.systemId || e.systemId === sid)) setDocsVersion((n) => n + 1);
    });
  }, [app, load, sid]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  // "/" → the active (or first) system, or the first-run screen
  useEffect(() => {
    if (!app || !systems || loc.path !== '/') return;
    const target = systems.find((s) => s.systemId === app.activeSystemId) ?? systems[0];
    navigate(target ? paths.system(target.systemId) : paths.newSystem(), { replace: true });
  }, [app, systems, loc.path]);

  const state: AppState | null = useMemo(
    () => (app && systems ? { app, systems, reloadSystems: () => void load(), theme, setTheme: setThemeState, openPalette: () => setPalette(true), docsVersion } : null),
    [app, systems, load, theme, docsVersion],
  );

  if (error instanceof ApiError && error.status === 401) return <LoginRequired />;
  if (error) {
    return (
      <div className="center-screen">
        <ErrorBox error={error} onRetry={() => void load()} />
      </div>
    );
  }
  if (!state) {
    return (
      <div className="center-screen">
        <Spinner label="Starting Agentic OS…" />
      </div>
    );
  }

  let page;
  if (loc.path === paths.newSystem()) page = <CreateSystem />;
  else if (sid) page = <Shell sid={sid} />;
  else page = <Spinner />;

  return (
    <AppCtx.Provider value={state}>
      {page}
      {palette && <Palette sid={sid} onClose={() => setPalette(false)} />}
    </AppCtx.Provider>
  );
}

function LoginRequired() {
  return (
    <div className="center-screen">
      <div className="card login-card aos-protected">
        <div className="brand-mark big">
          <Icon name="spark" size={26} />
        </div>
        <h1>Agentic OS</h1>
        <p>No session found. The interface works only with the local server on this computer.</p>
        <ol>
          <li>Find the terminal window where Agentic OS is running.</li>
          <li>Open the link "Open in the browser: http://127.0.0.1:…/auth?token=…".</li>
        </ol>
        <p className="muted small">If the server was restarted, you need the new link: the old one stops working.</p>
      </div>
    </div>
  );
}
