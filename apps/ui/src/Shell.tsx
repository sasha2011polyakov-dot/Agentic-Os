import { useEffect, useMemo, useState } from 'react';
import { api } from './api.ts';
import { sysApi, useApp } from './ctx.tsx';
import { Link, match, navigate, paths, useLocation } from './router.tsx';
import { Button, Empty, ErrorBoundary, ErrorBox, Icon, Modal, Spinner, useAsync, useToast, errorText } from './ui.tsx';
import type { Doc, DocListItem, SystemInfo } from './types.ts';
import { Home } from './pages/Home.tsx';
import { NotePage } from './pages/Note.tsx';
import { SearchPage } from './pages/Search.tsx';
import { GraphPage } from './pages/Graph.tsx';
import { MissionPage, MissionsPage, NewMissionPage } from './pages/Missions.tsx';

export function Shell({ sid }: { sid: string }) {
  const { systems, app } = useApp();
  const loc = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const system = systems.find((s) => s.systemId === sid) ?? null;

  useEffect(() => {
    if (system && app.activeSystemId !== sid) void api.post(`/api/systems/${encodeURIComponent(sid)}/switch`).catch(() => {});
  }, [sid, system, app.activeSystemId]);

  useEffect(() => setNavOpen(false), [loc.path]);

  if (!system) {
    return (
      <div className="center-screen">
        <Empty icon="database" title="Knowledge system not found">
          <p>It may have been removed from the list.</p>
          <Button variant="primary" onClick={() => navigate('/')}>
            Back to the systems
          </Button>
        </Empty>
      </div>
    );
  }

  const p = loc.path;
  let page;
  let m: Record<string, string> | null;
  if ((m = match('/s/:sid/note/:docId', p))) page = <NotePage sid={sid} docId={m.docId!} key={m.docId} />;
  else if (match('/s/:sid/search', p)) page = <SearchPage sid={sid} />;
  else if (match('/s/:sid/graph', p)) page = <GraphPage sid={sid} />;
  else if (match('/s/:sid/missions', p)) page = <MissionsPage sid={sid} />;
  else if (match('/s/:sid/missions/new', p)) page = <NewMissionPage sid={sid} />;
  else if ((m = match('/s/:sid/missions/:mid', p))) page = <MissionPage sid={sid} mid={m.mid!} key={m.mid} />;
  else page = <Home sid={sid} system={system} />;

  return (
    <div className={`shell ${navOpen ? 'nav-open' : ''}`} data-aos-theme-root>
      <aside className="sidebar aos-themable">
        <SystemSwitcher current={system} systems={systems} />
        <PaletteButton />
        <nav className="nav">
          <NavItem to={paths.system(sid)} icon="database" label="Overview" active={p === paths.system(sid)} />
          <NavItem to={paths.search(sid)} icon="search" label="Search" active={p.startsWith(paths.search(sid))} />
          <NavItem to={paths.graph(sid)} icon="graph" label="Knowledge graph" active={p.startsWith(paths.graph(sid))} />
          <NavItem to={paths.missions(sid)} icon="target" label="Missions" active={p.startsWith(paths.missions(sid))} />
        </nav>
        <NoteTree sid={sid} activeDocId={match('/s/:sid/note/:docId', p)?.docId ?? null} />
      </aside>
      <div className="nav-scrim" onClick={() => setNavOpen(false)} />
      <main className="main">
        <button type="button" className="icon-btn nav-toggle" onClick={() => setNavOpen(true)} aria-label="Menu">
          <Icon name="menu" />
        </button>
        <ErrorBoundary resetKey={p}>{page}</ErrorBoundary>
      </main>
    </div>
  );
}

function NavItem({ to, icon, label, active }: { to: string; icon: string; label: string; active: boolean }) {
  return (
    <Link to={to} className={`nav-item ${active ? 'active' : ''}`}>
      <Icon name={icon} />
      <span>{label}</span>
    </Link>
  );
}

function PaletteButton() {
  const { openPalette } = useApp();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <button type="button" className="palette-btn" onClick={openPalette}>
      <Icon name="search" size={16} />
      <span>Find or run…</span>
      <kbd>{mac ? '⌘' : 'Ctrl'} K</kbd>
    </button>
  );
}

function SystemSwitcher({ current, systems }: { current: SystemInfo; systems: SystemInfo[] }) {
  const [open, setOpen] = useState(false);
  const { theme, setTheme } = useApp();
  return (
    <div className="switcher">
      <button type="button" className="switcher-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="sys-dot" style={{ background: current.color || 'var(--aos-color-accent)' }} />
        <span className="switcher-name">{current.name}</span>
        <Icon name="chevron" size={14} className={open ? 'rot90' : ''} />
      </button>
      <button type="button" className="icon-btn" title={theme === 'dark' ? 'Light theme' : 'Dark theme'} onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
      {open && (
        <div className="switcher-menu card" onMouseLeave={() => setOpen(false)}>
          <div className="menu-label">Knowledge systems</div>
          {systems.map((s) => (
            <button
              type="button"
              key={s.systemId}
              className={`menu-item ${s.systemId === current.systemId ? 'active' : ''}`}
              onClick={() => {
                setOpen(false);
                navigate(paths.system(s.systemId));
              }}
            >
              <span className="sys-dot" style={{ background: s.color || 'var(--aos-color-accent)' }} />
              <span className="grow">{s.name}</span>
              {s.status !== 'connected' && <span className="muted small">{s.status}</span>}
            </button>
          ))}
          <div className="menu-sep" />
          <button type="button" className="menu-item" onClick={() => navigate(paths.newSystem())}>
            <Icon name="plus" size={16} />
            <span className="grow">New knowledge system</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ note tree

interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  docs: DocListItem[];
}

function buildTree(docs: DocListItem[]): TreeNode {
  const root: TreeNode = { name: '', path: '', folders: new Map(), docs: [] };
  for (const d of docs) {
    const parts = d.relPath.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.folders.get(part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, folders: new Map(), docs: [] };
        node.folders.set(part, next);
      }
      node = next;
    }
    node.docs.push(d);
  }
  return root;
}

function loadCollapsed(sid: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`aos.tree.${sid}`) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

function NoteTree({ sid, activeDocId }: { sid: string; activeDocId: string | null }) {
  const { docsVersion } = useApp();
  const docs = useAsync(() => api.get<{ items: DocListItem[]; total: number }>(`${sysApi(sid)}/docs?limit=1000&sort=path`), [sid, docsVersion]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(sid));
  const [creating, setCreating] = useState<string | null>(null);
  const toast = useToast();
  const tree = useMemo(() => buildTree(docs.data?.items ?? []), [docs.data]);

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
    try {
      localStorage.setItem(`aos.tree.${sid}`, JSON.stringify([...next]));
    } catch {
      // storage unavailable
    }
  };

  const daily = async () => {
    try {
      const r = await api.post<{ doc: Doc }>(`${sysApi(sid)}/daily`, {});
      navigate(paths.note(sid, r.doc.id));
    } catch (e) {
      toast('bad', errorText(e));
    }
  };

  const render = (node: TreeNode, depth: number) => {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, 'en'));
    const files = [...node.docs].sort((a, b) => a.title.localeCompare(b.title, 'en'));
    return (
      <>
        {folders.map((f) => (
          <div key={f.path}>
            <button type="button" className="tree-row folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(f.path)}>
              <Icon name="chevron" size={13} className={collapsed.has(f.path) ? '' : 'rot90'} />
              <Icon name="folder" size={15} />
              <span className="tree-label">{f.name}</span>
            </button>
            {!collapsed.has(f.path) && render(f, depth + 1)}
          </div>
        ))}
        {files.map((d) => (
          <Link key={d.id} to={paths.note(sid, d.id)} className={`tree-row file ${d.id === activeDocId ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 14 + 17 }} title={d.relPath}>
            <Icon name="file" size={15} />
            <span className="tree-label">{d.title}</span>
          </Link>
        ))}
      </>
    );
  };

  return (
    <div className="tree">
      <div className="tree-head">
        <span>Notes</span>
        <span className="muted small">{docs.data?.total ?? ''}</span>
        <span className="grow" />
        <button type="button" className="icon-btn sm" title="Daily note" onClick={() => void daily()}>
          <Icon name="calendar" size={16} />
        </button>
        <button type="button" className="icon-btn sm" title="New note" onClick={() => setCreating('')}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div className="tree-body">
        {docs.loading && !docs.data ? <Spinner /> : docs.error ? <ErrorBox error={docs.error} onRetry={docs.reload} /> : docs.data && docs.data.items.length === 0 ? <div className="muted small pad">No notes yet.</div> : render(tree, 0)}
      </div>
      {creating !== null && <NewNoteModal sid={sid} initialTitle={creating} onClose={() => setCreating(null)} />}
    </div>
  );
}

export function NewNoteModal({ sid, initialTitle, onClose }: { sid: string; initialTitle: string; onClose: () => void }) {
  const [title, setTitle] = useState(initialTitle);
  const [folder, setFolder] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const folders = useAsync(() => api.get<{ folders: string[] }>(`${sysApi(sid)}/folders`), [sid]);
  const templates = useAsync(() => api.get<{ templates: { id: string; name: string }[] }>(`${sysApi(sid)}/templates`), [sid]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ doc: Doc }>(`${sysApi(sid)}/docs`, { title: title.trim(), ...(folder ? { folder } : {}), ...(templateId ? { templateId } : {}) });
      onClose();
      navigate(paths.note(sid, r.doc.id) + '?edit=1');
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New note"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon="plus" busy={busy} disabled={!title.trim()} onClick={() => void submit()}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) void submit();
        }}
      >
        <label>
          Title
          <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="For example: Project ideas" maxLength={200} />
        </label>
        <label>
          Folder
          <select value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="">Vault root</option>
            {(folders.data?.folders ?? []).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label>
          Template
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">Empty note</option>
            {(templates.data?.templates ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {error != null && <ErrorBox error={error} />}
      </form>
    </Modal>
  );
}
