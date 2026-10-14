import { Component, createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type ErrorInfo, type ReactNode } from 'react';
import { ApiError } from './api.ts';

// ------------------------------------------------------------------------------------------------ icons

const ICONS: Record<string, string> = {
  note: 'M6 3h9l4 4v14H6zM15 3v4h4M9 12h7M9 16h7M9 8h3',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-4-4',
  graph: 'M6 6m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M18 6m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M12 18m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M7.5 7.5l3.5 8.5M16.5 7.5L13 16M8 6h8',
  target: 'M12 12m-8 0a8 8 0 1 0 16 0 8 8 0 1 0-16 0M12 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0M12 12h.01',
  plus: 'M12 5v14M5 12h14',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4',
  chevron: 'M9 6l6 6-6 6',
  folder: 'M3 6h6l2 2h10v11H3z',
  file: 'M6 3h9l4 4v14H6zM15 3v4h4',
  sun: 'M12 12m-4 0a4 4 0 1 0 8 0 4 4 0 1 0-8 0M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0 3 3 0 1 0-6 0',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  back: 'M15 6l-6 6 6 6',
  x: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5 9-11',
  alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
  pause: 'M8 5v14M16 5v14',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  spark: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z',
  database: 'M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  command: 'M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  hash: 'M5 9h14M5 15h14M10 4L8 20M16 4l-2 16',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  menu: 'M4 7h16M4 12h16M4 17h16',
};

export function Icon({ name, size = 18, className }: { name: keyof typeof ICONS | string; size?: number; className?: string }) {
  return (
    <svg className={`icon ${className ?? ''}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name] ?? ICONS.note} />
    </svg>
  );
}

// ------------------------------------------------------------------------------------------------ basics

export function Button({ variant = 'default', icon, children, busy, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'primary' | 'ghost' | 'danger'; icon?: string; busy?: boolean }) {
  return (
    <button type="button" {...rest} disabled={rest.disabled || busy} className={`btn btn-${variant} ${variant === 'primary' ? 'button' : ''} ${rest.className ?? ''}`}>
      {busy ? <span className="spinner" aria-hidden="true" /> : icon ? <Icon name={icon} size={16} /> : null}
      {children}
    </button>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const e = error instanceof ApiError ? error : null;
  return (
    <div className="error-box aos-protected" role="alert">
      <Icon name="alert" />
      <div>
        <div className="error-title">{e?.message ?? (error instanceof Error ? error.message : String(error))}</div>
        {e?.hint && <div className="error-hint">{e.hint}</div>}
        {e && <div className="error-code">{e.code}</div>}
      </div>
      {onRetry && (
        <Button variant="ghost" icon="refresh" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Empty({ icon = 'note', title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={28} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal card ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 7) return `${Math.round(d / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A rendering error in one screen shows a message with a retry instead of a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Interface error:', error, info.componentStack);
  }

  override componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <ErrorBox error={new Error(`This screen could not be shown: ${this.state.error.message}. No data was changed.`)} onRetry={() => this.setState({ error: null })} />
      </div>
    );
  }
}

// ------------------------------------------------------------------------------------------------ async data

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: unknown; loading: boolean; reload: () => void; setData: (v: T) => void } {
  const [state, setState] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fnRef.current().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error) => alive && setState({ data: null, error, loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []), setData: useCallback((data: T) => setState({ data, error: null, loading: false }), []) };
}

// ------------------------------------------------------------------------------------------------ toasts

interface Toast {
  id: number;
  tone: 'ok' | 'bad' | 'info';
  text: string;
}

const ToastCtx = createContext<(tone: Toast['tone'], text: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === 'bad' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            <Icon name={t.tone === 'ok' ? 'check' : t.tone === 'bad' ? 'alert' : 'spark'} size={16} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast(): (tone: Toast['tone'], text: string) => void {
  return useContext(ToastCtx);
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.hint ? `${e.message} ${e.hint}` : e.message;
  return e instanceof Error ? e.message : String(e);
}
