import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.ts';
import { useApp } from '../ctx.tsx';
import { navigate, paths } from '../router.tsx';
import { Button, ErrorBox, Icon, Spinner, useAsync } from '../ui.tsx';
import type { DirListing, SystemInfo } from '../types.ts';

const COLORS = ['#7c5cff', '#2f80ed', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#ec4899', '#64748b'];

/** First run and «Новая система знаний»: a folder of Markdown files the user owns, plus the service folder .aos. */
export function CreateSystem() {
  const { systems, reloadSystems } = useApp();
  const [name, setName] = useState(systems.length ? '' : 'Мои знания');
  const [path, setPath] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [template, setTemplate] = useState<'starter' | 'empty'>('starter');
  const [color, setColor] = useState(COLORS[0]!);
  const [adopt, setAdopt] = useState(false);
  const [browse, setBrowse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const home = useAsync(() => api.get<DirListing>('/api/fs/list'), []);

  useEffect(() => {
    if (pathTouched || !home.data) return;
    const safe = (name.trim() || 'Знания').replace(/[\\/:*?"<>|]+/g, ' ').trim();
    setPath(`${home.data.path.replace(/[\\/]+$/, '')}/Agentic OS/${safe}`);
  }, [name, home.data, pathTouched]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ system: SystemInfo }>('/api/systems', { name: name.trim(), storagePath: path.trim(), template, color, adoptExistingFolder: adopt, open: true });
      reloadSystems();
      navigate(paths.system(r.system.systemId));
    } catch (e) {
      setError(e);
      setBusy(false);
      if (e instanceof ApiError && /не пуста/.test(e.message)) setAdopt(false);
    }
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card card aos-themable">
        <div className="brand">
          <div className="brand-mark big">
            <Icon name="spark" size={26} />
          </div>
          <div>
            <h1>{systems.length ? 'Новая система знаний' : 'Добро пожаловать в Agentic OS'}</h1>
            <p className="muted">
              Система знаний — это папка с обычными Markdown-файлами на вашем компьютере и служебная папка <code>.aos</code> с индексом. Системы полностью изолированы друг от друга: например, «Работа» и «Личное».
            </p>
          </div>
        </div>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <label>
            Название
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Например: Работа" />
          </label>
          <label>
            Папка хранилища
            <div className="row">
              <input
                className="grow mono"
                value={path}
                onChange={(e) => {
                  setPath(e.target.value);
                  setPathTouched(true);
                }}
                placeholder="/home/user/Знания"
              />
              <Button icon="folder" onClick={() => setBrowse((b) => !b)}>
                Выбрать…
              </Button>
            </div>
            <span className="hint">Если папки нет, она будет создана. Существующие файлы не изменяются.</span>
          </label>
          {browse && (
            <FolderBrowser
              start={path}
              onPick={(p) => {
                setPath(p);
                setPathTouched(true);
                setBrowse(false);
              }}
            />
          )}
          <label className="check">
            <input type="checkbox" checked={adopt} onChange={(e) => setAdopt(e.target.checked)} />
            <span>
              Создать систему в существующей непустой папке (например, хранилище Obsidian): добавится только <code>.aos</code>
            </span>
          </label>
          <div className="field">
            <span>Начальное содержимое</span>
            <div className="seg">
              <button type="button" className={template === 'starter' ? 'on' : ''} onClick={() => setTemplate('starter')}>
                Со стартовыми заметками
              </button>
              <button type="button" className={template === 'empty' ? 'on' : ''} onClick={() => setTemplate('empty')}>
                Пустая
              </button>
            </div>
          </div>
          <div className="field">
            <span>Цвет</span>
            <div className="swatches">
              {COLORS.map((c) => (
                <button type="button" key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Цвет ${c}`} />
              ))}
            </div>
          </div>
          {error != null && <ErrorBox error={error} />}
          <div className="row end">
            {systems.length > 0 && (
              <Button variant="ghost" onClick={() => history.back()}>
                Отмена
              </Button>
            )}
            <Button variant="primary" icon="check" busy={busy} disabled={!name.trim() || !path.trim()} onClick={() => void submit()}>
              Создать систему
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

function FolderBrowser({ start, onPick }: { start: string; onPick: (path: string) => void }) {
  const [dir, setDir] = useState<string | undefined>(undefined);
  const listing = useAsync(() => api.get<DirListing>(`/api/fs/list${dir ? `?path=${encodeURIComponent(dir)}` : ''}`), [dir]);
  useEffect(() => {
    // start from the nearest existing parent of the typed path
    const parent = start.replace(/[\\/][^\\/]*$/, '');
    if (parent) api.get<DirListing>(`/api/fs/list?path=${encodeURIComponent(parent)}`).then(() => setDir(parent), () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const d = listing.data;
  return (
    <div className="browser card">
      {listing.loading && !d ? (
        <Spinner />
      ) : listing.error ? (
        <ErrorBox error={listing.error} onRetry={listing.reload} />
      ) : d ? (
        <>
          <div className="browser-head">
            <button type="button" className="icon-btn sm" disabled={!d.parent} onClick={() => d.parent && setDir(d.parent)} aria-label="Вверх">
              <Icon name="back" size={16} />
            </button>
            <span className="mono small grow ellipsis">{d.path}</span>
            <Button variant="primary" onClick={() => onPick(d.path)}>
              Выбрать эту папку
            </Button>
          </div>
          <div className="browser-list">
            {d.entries.length === 0 && <div className="muted small pad">Вложенных папок нет.</div>}
            {d.entries.map((e) => (
              <button type="button" key={e.path} className="tree-row folder" onClick={() => setDir(e.path)}>
                <Icon name="folder" size={15} />
                <span className="tree-label">{e.name}</span>
                {e.isSystem && <span className="badge badge-accent">система</span>}
                {e.isGit && <span className="badge badge-neutral">git</span>}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
