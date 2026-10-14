import { useState } from 'react';
import { api, q } from '../api.ts';
import { sysApi, useApp } from '../ctx.tsx';
import { navigate, paths } from '../router.tsx';
import { Empty, ErrorBox, Icon, Spinner, useAsync } from '../ui.tsx';
import { GraphCanvas } from '../graph.tsx';
import type { GraphResult } from '../types.ts';

export function GraphPage({ sid }: { sid: string }) {
  const { docsVersion } = useApp();
  const [filter, setFilter] = useState('');
  const [showUnresolved, setShowUnresolved] = useState(true);
  const graph = useAsync(() => api.get<GraphResult>(`${sysApi(sid)}/graph${q({ limit: 3000, includeUnresolved: showUnresolved ? 1 : 0 })}`), [sid, docsVersion, showUnresolved]);
  const data = graph.data;
  const notes = data?.nodes.filter((n) => n.type === 'note').length ?? 0;
  const unresolved = data?.nodes.filter((n) => n.type === 'unresolved').length ?? 0;

  return (
    <div className="graph-page">
      <div className="graph-bar card aos-themable">
        <Icon name="graph" />
        <strong>Knowledge graph</strong>
        <span className="muted small">
          {data ? `${notes} notes · ${unresolved} not created · ${data.edges.length} links${data.truncated ? ' · part of the graph is shown' : ''}` : ''}
        </span>
        <span className="grow" />
        <label className="check small">
          <input type="checkbox" checked={showUnresolved} onChange={(e) => setShowUnresolved(e.target.checked)} />
          notes not created yet
        </label>
        <div className="search-input sm">
          <Icon name="search" size={15} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Highlight nodes…" aria-label="Highlight nodes" />
        </div>
      </div>
      <div className="graph-stage">
        {graph.loading && !data ? (
          <Spinner label="Building the graph…" />
        ) : graph.error ? (
          <ErrorBox error={graph.error} onRetry={graph.reload} />
        ) : data && data.nodes.length === 0 ? (
          <Empty icon="graph" title="The graph is empty">
            Link notes with links like <code>[[Note title]]</code>: the links appear here.
          </Empty>
        ) : data ? (
          <GraphCanvas data={data} highlight={filter.trim().toLowerCase() || undefined} onOpen={(n) => n.refId && n.type === 'note' && navigate(paths.note(sid, n.refId))} />
        ) : null}
        <div className="graph-legend card small">
          <span>
            <i className="dot note" /> note
          </span>
          <span>
            <i className="dot unresolved" /> not created yet
          </span>
          <span className="muted">wheel: zoom · drag: pan · click: open</span>
        </div>
      </div>
    </div>
  );
}
