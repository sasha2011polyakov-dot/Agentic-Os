import { useState } from 'react';
import { api } from '../api.ts';
import { sysApi, useApp } from '../ctx.tsx';
import { Link, navigate, paths } from '../router.tsx';
import { Badge, Button, ErrorBox, Icon, Spinner, timeAgo, useAsync, useToast, errorText } from '../ui.tsx';
import type { Doc, DocListItem, MissionListItem, SystemInfo } from '../types.ts';
import { NewNoteModal } from '../Shell.tsx';
import { missionTone } from './Missions.tsx';

interface GraphStats {
  nodes: number;
  edges: number;
  byType: Record<string, number>;
}

export function Home({ sid, system }: { sid: string; system: SystemInfo }) {
  const { docsVersion } = useApp();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const recent = useAsync(() => api.get<{ items: DocListItem[]; total: number }>(`${sysApi(sid)}/docs?limit=8&sort=updated`), [sid, docsVersion]);
  const stats = useAsync(() => api.get<GraphStats>(`${sysApi(sid)}/graph/stats`), [sid, docsVersion]);
  const missions = useAsync(() => api.get<{ items: MissionListItem[]; total: number }>(`${sysApi(sid)}/missions?limit=5`), [sid]);

  const daily = async () => {
    try {
      const r = await api.post<{ doc: Doc }>(`${sysApi(sid)}/daily`, {});
      navigate(paths.note(sid, r.doc.id));
    } catch (e) {
      toast('bad', errorText(e));
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <span className="sys-dot" style={{ background: system.color || 'var(--aos-color-accent)' }} /> Knowledge system
          </div>
          <h1>{system.name}</h1>
          {system.description && <p className="muted">{system.description}</p>}
          <p className="muted small mono">{system.storagePath}</p>
        </div>
      </header>

      <div className="quick">
        <button type="button" className="quick-card card aos-themable" onClick={() => setCreating(true)}>
          <Icon name="plus" size={22} />
          <span className="quick-title">New note</span>
          <span className="muted small">A Markdown file in your folder</span>
        </button>
        <button type="button" className="quick-card card aos-themable" onClick={() => void daily()}>
          <Icon name="calendar" size={22} />
          <span className="quick-title">Daily note</span>
          <span className="muted small">{new Date().toLocaleDateString('en-US', { day: 'numeric', month: 'long' })}</span>
        </button>
        <Link to={paths.newMission(sid)} className="quick-card card aos-themable">
          <Icon name="target" size={22} />
          <span className="quick-title">Give agents a task</span>
          <span className="muted small">Describe it in plain words</span>
        </Link>
        <Link to={paths.graph(sid)} className="quick-card card aos-themable">
          <Icon name="graph" size={22} />
          <span className="quick-title">Knowledge graph</span>
          <span className="muted small">{stats.data ? `${stats.data.byType.note ?? 0} notes · ${stats.data.edges} links` : 'links between notes'}</span>
        </Link>
      </div>

      <div className="grid-2">
        <section className="card panel aos-themable">
          <div className="panel-head">
            <h2>Recent notes</h2>
            <span className="muted small">{recent.data ? `${recent.data.total} in total` : ''}</span>
          </div>
          {recent.loading && !recent.data ? (
            <Spinner />
          ) : recent.error ? (
            <ErrorBox error={recent.error} onRetry={recent.reload} />
          ) : recent.data?.items.length ? (
            <ul className="list">
              {recent.data.items.map((d) => (
                <li key={d.id}>
                  <Link to={paths.note(sid, d.id)} className="list-row">
                    <Icon name="file" size={16} />
                    <span className="grow ellipsis">{d.title}</span>
                    <span className="muted small ellipsis path-hint">{d.relPath.includes('/') ? d.relPath.slice(0, d.relPath.lastIndexOf('/')) : ''}</span>
                    <span className="muted small nowrap">{timeAgo(d.updatedAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No notes yet: create the first one.</p>
          )}
        </section>

        <section className="card panel aos-themable">
          <div className="panel-head">
            <h2>Missions</h2>
            <Link to={paths.missions(sid)} className="link small">
              all
            </Link>
          </div>
          {missions.loading && !missions.data ? (
            <Spinner />
          ) : missions.error ? (
            <ErrorBox error={missions.error} onRetry={missions.reload} />
          ) : missions.data?.items.length ? (
            <ul className="list">
              {missions.data.items.map((m) => (
                <li key={m.id}>
                  <Link to={paths.mission(sid, m.id)} className="list-row">
                    <span className="mono small muted">{m.key}</span>
                    <span className="grow ellipsis">{m.title}</span>
                    <Badge tone={missionTone(m.status)}>{m.statusLabel}</Badge>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="muted">
              <p>Describe a task in plain words: agents analyze it, make a plan, carry it out and verify the result with evidence.</p>
              <Button variant="primary" icon="target" onClick={() => navigate(paths.newMission(sid))}>
                New mission
              </Button>
            </div>
          )}
        </section>
      </div>

      {stats.data && (
        <section className="stats">
          <div className="stat card aos-themable">
            <span className="stat-num">{stats.data.byType.note ?? 0}</span>
            <span className="muted small">notes</span>
          </div>
          <div className="stat card aos-themable">
            <span className="stat-num">{stats.data.edges}</span>
            <span className="muted small">links in the graph</span>
          </div>
          <div className="stat card aos-themable">
            <span className="stat-num">{stats.data.byType.unresolved ?? 0}</span>
            <span className="muted small">links to notes that do not exist yet</span>
          </div>
          <div className="stat card aos-themable">
            <span className="stat-num">{system.stats.projects ?? 0}</span>
            <span className="muted small">connected projects</span>
          </div>
        </section>
      )}
      {creating && <NewNoteModal sid={sid} initialTitle="" onClose={() => setCreating(false)} />}
    </div>
  );
}
