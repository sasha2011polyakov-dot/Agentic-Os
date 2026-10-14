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
        <strong>Граф знаний</strong>
        <span className="muted small">
          {data ? `${notes} заметок · ${unresolved} несозданных · ${data.edges.length} связей${data.truncated ? ' · показана часть графа' : ''}` : ''}
        </span>
        <span className="grow" />
        <label className="check small">
          <input type="checkbox" checked={showUnresolved} onChange={(e) => setShowUnresolved(e.target.checked)} />
          несозданные заметки
        </label>
        <div className="search-input sm">
          <Icon name="search" size={15} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Подсветить узлы…" aria-label="Подсветить узлы" />
        </div>
      </div>
      <div className="graph-stage">
        {graph.loading && !data ? (
          <Spinner label="Строю граф…" />
        ) : graph.error ? (
          <ErrorBox error={graph.error} onRetry={graph.reload} />
        ) : data && data.nodes.length === 0 ? (
          <Empty icon="graph" title="Граф пока пуст">
            Свяжите заметки ссылками вида <code>[[Название заметки]]</code> — связи появятся здесь.
          </Empty>
        ) : data ? (
          <GraphCanvas data={data} highlight={filter.trim().toLowerCase() || undefined} onOpen={(n) => n.refId && n.type === 'note' && navigate(paths.note(sid, n.refId))} />
        ) : null}
        <div className="graph-legend card small">
          <span>
            <i className="dot note" /> заметка
          </span>
          <span>
            <i className="dot unresolved" /> ещё не создана
          </span>
          <span className="muted">колесо — масштаб · перетаскивание — сдвиг · клик — открыть</span>
        </div>
      </div>
    </div>
  );
}
