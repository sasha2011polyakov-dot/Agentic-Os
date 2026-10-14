import { useEffect, useState, type ReactNode } from 'react';
import { api, q } from '../api.ts';
import { sysApi, useApp } from '../ctx.tsx';
import { Link, navigate, paths, useLocation } from '../router.tsx';
import { Empty, ErrorBox, Icon, Spinner, useAsync } from '../ui.tsx';
import type { SearchResult } from '../types.ts';

/** Snippets mark matches with U+0002 … U+0003. */
export function Snippet({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /\u0002([\s\S]*?)\u0003/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={i++}>{m[1]}</mark>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

const HELP: [string, string][] = [
  ['word another', 'both words'],
  ['"exact phrase"', 'the whole phrase'],
  ['cat OR kitten', 'any of the words'],
  ['-draft', 'exclude a word'],
  ['agent*', 'beginning of a word'],
  ['tag:project', 'by tag'],
  ['path:Concepts', 'by folder'],
  ['[status:active]', 'by property'],
];

export function SearchPage({ sid }: { sid: string }) {
  const loc = useLocation();
  const { docsVersion } = useApp();
  const query = loc.query.get('q') ?? '';
  const [input, setInput] = useState(query);
  useEffect(() => setInput(query), [query]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (input !== query) navigate(paths.search(sid, input), { replace: true });
    }, 250);
    return () => clearTimeout(t);
  }, [input, query, sid]);

  const res = useAsync(() => (query.trim() ? api.get<SearchResult>(`${sysApi(sid)}/search${q({ q: query, limit: 50 })}`) : Promise.resolve(null)), [sid, query, docsVersion]);

  return (
    <div className="page narrow">
      <div className="search-input big card aos-themable">
        <Icon name="search" size={20} />
        <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="Search notes and connected projects…" aria-label="Search query" />
        {res.data && <span className="muted small nowrap">{res.data.total} · {res.data.tookMs} ms</span>}
      </div>
      {res.data?.explain && <div className="explain muted small">Understood the query as: {res.data.explain}</div>}

      {!query.trim() ? (
        <div className="search-help card aos-themable">
          <h3>How to search</h3>
          <div className="help-grid">
            {HELP.map(([ex, what]) => (
              <button type="button" key={ex} className="help-item" onClick={() => setInput(ex)}>
                <code>{ex}</code>
                <span className="muted small">{what}</span>
              </button>
            ))}
          </div>
        </div>
      ) : res.loading && !res.data ? (
        <Spinner />
      ) : res.error ? (
        <ErrorBox error={res.error} />
      ) : res.data && res.data.hits.length === 0 ? (
        <Empty icon="search" title="Nothing found">
          Search matches exact word forms. Try the beginning of a word with an asterisk, for example <code>{query.trim().split(/\s+/)[0]?.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 5) || 'word'}*</code>.
        </Empty>
      ) : (
        <ul className="results">
          {res.data?.hits.map((h) => (
            <li key={h.docId} className="result card aos-themable">
              <Link to={paths.note(sid, h.docId)} className="result-title">
                <Icon name="file" size={16} /> {h.title}
              </Link>
              <div className="muted small">
                {h.sourceName} · <span className="mono">{h.relPath}</span>
              </div>
              {h.snippet && (
                <p className="result-snippet">
                  <Snippet text={h.snippet} />
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
