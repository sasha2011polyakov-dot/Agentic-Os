import { useEffect, useMemo, useRef, useState } from 'react';
import { api, q } from './api.ts';
import { sysApi, useApp } from './ctx.tsx';
import { navigate, paths } from './router.tsx';
import { Icon, useToast, errorText } from './ui.tsx';
import type { Doc } from './types.ts';

interface Item {
  id: string;
  icon: string;
  label: string;
  hint?: string;
  run: () => void | Promise<void>;
}

/** Ctrl/Cmd+K: jump to a note or run a command, entirely from the keyboard. */
export function Palette({ sid, onClose }: { sid: string | null; onClose: () => void }) {
  const { systems, theme, setTheme } = useApp();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [docs, setDocs] = useState<{ id: string; title: string; relPath: string }[]>([]);
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!sid) return;
    let alive = true;
    const t = setTimeout(() => {
      api.get<{ items: { id: string; title: string; relPath: string }[] }>(`${sysApi(sid)}/docs/suggest${q({ q: query.trim(), limit: 8 })}`).then(
        (r) => alive && setDocs(r.items),
        () => alive && setDocs([]),
      );
    }, 80);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [sid, query]);

  const items = useMemo(() => {
    const go = (to: string) => () => {
      onClose();
      navigate(to);
    };
    const commands: Item[] = [];
    if (sid) {
      commands.push(
        { id: 'daily', icon: 'calendar', label: 'Daily note', run: async () => {
          onClose();
          try {
            const r = await api.post<{ doc: Doc }>(`${sysApi(sid)}/daily`, {});
            navigate(paths.note(sid, r.doc.id));
          } catch (e) {
            toast('bad', errorText(e));
          }
        } },
        { id: 'graph', icon: 'graph', label: 'Open the knowledge graph', run: go(paths.graph(sid)) },
        { id: 'missions', icon: 'target', label: 'Missions', run: go(paths.missions(sid)) },
        { id: 'new-mission', icon: 'plus', label: 'New mission', run: go(paths.newMission(sid)) },
        { id: 'home', icon: 'database', label: 'System overview', run: go(paths.system(sid)) },
      );
    }
    commands.push({ id: 'theme', icon: theme === 'dark' ? 'sun' : 'moon', label: theme === 'dark' ? 'Light theme' : 'Dark theme', run: () => {
      setTheme(theme === 'dark' ? 'light' : 'dark');
      onClose();
    } });
    commands.push({ id: 'new-system', icon: 'plus', label: 'New knowledge system', run: go(paths.newSystem()) });
    for (const s of systems) if (s.systemId !== sid) commands.push({ id: `sys:${s.systemId}`, icon: 'database', label: `Go to the system "${s.name}"`, run: go(paths.system(s.systemId)) });
    const ql = query.trim().toLowerCase();
    const cmds = ql ? commands.filter((c) => c.label.toLowerCase().includes(ql)) : commands;
    const noteItems: Item[] = docs.map((d) => ({ id: `doc:${d.id}`, icon: 'file', label: d.title, hint: d.relPath, run: go(paths.note(sid!, d.id)) }));
    const search: Item[] = sid && ql ? [{ id: 'search', icon: 'search', label: `Search all notes for "${query.trim()}"`, run: go(paths.search(sid, query.trim())) }] : [];
    return ql ? [...noteItems, ...search, ...cmds] : [...cmds, ...noteItems];
  }, [sid, systems, theme, setTheme, docs, query, onClose, toast]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    list.current?.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette card" role="dialog" aria-modal="true" aria-label="Commands and navigation">
        <div className="palette-input">
          <Icon name="search" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Note title or command…"
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setIndex((i) => Math.min(items.length - 1, i + 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setIndex((i) => Math.max(0, i - 1));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                void items[index]?.run();
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" ref={list}>
          {items.length === 0 && <div className="muted small pad">Nothing found.</div>}
          {items.map((it, i) => (
            <button type="button" key={it.id} className={`menu-item ${i === index ? 'active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => void it.run()}>
              <Icon name={it.icon} size={16} />
              <span className="grow ellipsis">{it.label}</span>
              {it.hint && <span className="muted small ellipsis">{it.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
