import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { api, ApiError, q } from '../api.ts';
import { sysApi, useApp } from '../ctx.tsx';
import { Link, navigate, paths, useLocation } from '../router.tsx';
import { Markdown, slug, type MdHandlers } from '../markdown.tsx';
import { Badge, Button, ErrorBox, Icon, Modal, Spinner, timeAgo, useAsync, useToast, errorText } from '../ui.tsx';
import type { Doc, GraphResult } from '../types.ts';
import { GraphCanvas } from '../graph.tsx';

interface Suggest {
  id: string;
  title: string;
  relPath: string;
}

export function NotePage({ sid, docId }: { sid: string; docId: string }) {
  const { docsVersion } = useApp();
  const loc = useLocation();
  const toast = useToast();
  const doc = useAsync(() => api.get<{ doc: Doc & { diskHash?: string } }>(`${sysApi(sid)}/docs/${encodeURIComponent(docId)}`).then((r) => r.doc), [sid, docId]);
  const [editing, setEditing] = useState(loc.query.get('edit') === '1');
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  const [createTarget, setCreateTarget] = useState<string | null>(null);
  const dirty = draft !== null && doc.data !== null && draft !== doc.data.content;

  // external changes: refresh when there is nothing unsaved; otherwise keep the draft (a save will report the conflict)
  const lastVersion = useRef(docsVersion);
  useEffect(() => {
    if (lastVersion.current === docsVersion) return;
    lastVersion.current = docsVersion;
    if (!dirty) doc.reload();
  }, [docsVersion, dirty, doc]);

  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const save = useCallback(async () => {
    if (!doc.data || draft === null || saving) return;
    setSaving(true);
    try {
      await api.put(`${sysApi(sid)}/docs/${encodeURIComponent(docId)}`, { content: draft, expectedHash: doc.data.diskHash ?? doc.data.hash });
      const fresh = await api.get<{ doc: Doc }>(`${sysApi(sid)}/docs/${encodeURIComponent(docId)}`);
      doc.setData(fresh.doc);
      setDraft(fresh.doc.content);
      setConflict(null);
      toast('ok', 'Saved');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'WRITE_CONFLICT') setConflict(String((e.details as { currentText?: string } | null)?.currentText ?? ''));
      else toast('bad', errorText(e));
    } finally {
      setSaving(false);
    }
  }, [doc, draft, saving, sid, docId, toast]);

  const resolvedMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const l of doc.data?.outgoing ?? []) if (l.targetRaw) m.set(l.targetRaw.split(/[#^|]/)[0]!.trim().toLowerCase(), !!l.resolved);
    return m;
  }, [doc.data]);

  const handlers: MdHandlers = useMemo(
    () => ({
      isResolved: (t) => resolvedMap.get(t.toLowerCase()) ?? null,
      onTag: (tag) => navigate(paths.search(sid, `tag:${tag}`)),
      attachmentUrl: (t) => `${sysApi(sid)}/attachment${q({ target: t, from: docId })}`,
      onLink: (target) => {
        void api.get<{ docId: string | null; suggestedPath: string }>(`${sysApi(sid)}/docs/resolve${q({ target, from: docId })}`).then(
          (r) => (r.docId ? navigate(paths.note(sid, r.docId)) : setCreateTarget(target)),
          (e) => toast('bad', errorText(e)),
        );
      },
    }),
    [resolvedMap, sid, docId, toast],
  );

  if (doc.loading && !doc.data) return <div className="page"><Spinner /></div>;
  if (doc.error) return <div className="page"><ErrorBox error={doc.error} onRetry={doc.reload} /></div>;
  const d = doc.data!;
  const folder = d.relPath.includes('/') ? d.relPath.slice(0, d.relPath.lastIndexOf('/')) : '';
  const text = draft ?? d.content;

  return (
    <div className="note-layout">
      <article className="note-main">
        <div className="note-toolbar">
          <div className="crumbs muted small">
            <span>{d.sourceName}</span>
            {folder.split('/').filter(Boolean).map((f, i) => (
              <span key={i}>
                <Icon name="chevron" size={12} /> {f}
              </span>
            ))}
          </div>
          <span className="grow" />
          {dirty && <span className="dirty muted small">not saved</span>}
          {!d.editable && <Badge tone="warn">read only</Badge>}
          {editing ? (
            <>
              <Button variant="ghost" icon="eye" onClick={() => setEditing(false)}>
                Preview
              </Button>
              <Button variant="primary" icon="save" busy={saving} disabled={!dirty} onClick={() => void save()}>
                Save
              </Button>
            </>
          ) : (
            d.editable && (
              <Button
                icon="edit"
                onClick={() => {
                  setDraft(draft ?? d.content);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )
          )}
        </div>

        {conflict !== null && (
          <div className="banner warn aos-protected" role="alert">
            <Icon name="alert" />
            <div className="grow">
              <strong>The file was changed outside the application after you opened it.</strong> Your text is not lost.
            </div>
            <Button
              onClick={() => {
                setDraft(conflict);
                setConflict(null);
                doc.reload();
              }}
            >
              Take the version from disk
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                const fresh = await api.get<{ doc: Doc }>(`${sysApi(sid)}/docs/${encodeURIComponent(docId)}`);
                doc.setData(fresh.doc);
                setConflict(null);
                toast('info', 'The version from disk is loaded: press "Save" to write your text over it.');
              }}
            >
              Keep my text
            </Button>
          </div>
        )}

        {editing ? (
          <Editor sid={sid} value={text} onChange={setDraft} onSave={() => void save()} />
        ) : (
          <div className="note-body aos-themable">
            {d.frontmatterError && (
              <div className="banner warn">
                <Icon name="alert" /> Error in the properties (frontmatter): {d.frontmatterError}
              </div>
            )}
            {!/^\s*(---[\s\S]*?---\s*)?#\s/.test(d.content) && <h1 className="note-title">{d.title}</h1>}
            <Markdown source={text} h={handlers} />
            <div className="note-meta muted small">
              {d.wordCount} words · changed {timeAgo(d.updatedAt)} · <span className="mono">{d.relPath}</span>
            </div>
          </div>
        )}
      </article>

      <aside className="note-side">
        <SidePanels sid={sid} doc={d} />
      </aside>

      {createTarget && (
        <Modal
          title="The note does not exist yet"
          onClose={() => setCreateTarget(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreateTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon="plus"
                onClick={async () => {
                  try {
                    const r = await api.post<{ doc: Doc }>(`${sysApi(sid)}/docs`, { title: createTarget, ...(folder ? { folder } : {}) });
                    setCreateTarget(null);
                    navigate(paths.note(sid, r.doc.id) + '?edit=1');
                  } catch (e) {
                    toast('bad', errorText(e));
                  }
                }}
              >
                Create "{createTarget}"
              </Button>
            </>
          }
        >
          <p>
            The link <code>[[{createTarget}]]</code> points to a note that does not exist yet. Create it {folder ? <>in the folder "{folder}"</> : 'in the vault root'}?
          </p>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ editor

const MIRROR_PROPS = ['boxSizing', 'width', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'textTransform', 'wordSpacing'] as const;

/** Caret position inside a textarea (measured on an invisible copy with the same text layout). */
function caretXY(el: HTMLTextAreaElement, pos: number): { top: number; left: number } {
  const st = getComputedStyle(el);
  const div = document.createElement('div');
  for (const p of MIRROR_PROPS) div.style[p] = st[p];
  Object.assign(div.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', top: '0', left: '-9999px' });
  div.textContent = el.value.slice(0, pos);
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  div.appendChild(mark);
  document.body.appendChild(div);
  const lineHeight = Number.parseFloat(st.lineHeight) || 22;
  const out = { top: mark.offsetTop + lineHeight - el.scrollTop + 4, left: mark.offsetLeft - el.scrollLeft };
  div.remove();
  return out;
}

function Editor({ sid, value, onChange, onSave }: { sid: string; value: string; onChange: (v: string) => void; onSave: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [sugg, setSugg] = useState<{ query: string; start: number; items: Suggest[]; index: number; top: number; left: number } | null>(null);

  const detect = (v: string, caret: number) => {
    const before = v.slice(0, caret);
    const m = /\[\[([^\]\n|#]*)$/.exec(before);
    if (!m) {
      setSugg(null);
      return;
    }
    const query = m[1]!;
    const start = caret - query.length;
    const el = ref.current;
    const xy = el ? caretXY(el, caret) : { top: 12, left: 12 };
    const width = el?.clientWidth ?? 600;
    const left = Math.max(8, Math.min(xy.left, width - 388));
    void api.get<{ items: Suggest[] }>(`${sysApi(sid)}/docs/suggest${q({ q: query, limit: 8 })}`).then(
      (r) => setSugg((s) => ({ query, start, items: r.items, index: s && s.query === query ? s.index : 0, top: xy.top, left })),
      () => setSugg(null),
    );
  };

  const insert = (title: string) => {
    const el = ref.current;
    if (!el || !sugg) return;
    const caret = el.selectionStart;
    const after = value.slice(caret);
    const closing = after.startsWith(']]') ? '' : ']]';
    const next = value.slice(0, sugg.start) + title + closing + after;
    onChange(next);
    setSugg(null);
    requestAnimationFrame(() => {
      const pos = sugg.start + title.length + 2;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onKey = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      onSave();
      return;
    }
    if (sugg && sugg.items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = sugg.items.length;
        setSugg({ ...sugg, index: (sugg.index + (e.key === 'ArrowDown' ? 1 : n - 1)) % n });
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insert(sugg.items[sugg.index]!.title);
      } else if (e.key === 'Escape') setSugg(null);
    }
  };

  return (
    <div className="editor-wrap">
      <textarea
        ref={ref}
        className="editor"
        value={value}
        spellCheck
        autoFocus
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={onKey}
        onBlur={() => setTimeout(() => setSugg(null), 150)}
      />
      {sugg && sugg.items.length > 0 && (
        <div className="suggest card" style={{ top: sugg.top, left: sugg.left }}>
          <div className="menu-label">Link to a note</div>
          {sugg.items.map((s, i) => (
            <button type="button" key={s.id} className={`menu-item ${i === sugg.index ? 'active' : ''}`} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(s.title)}>
              <Icon name="file" size={15} />
              <span className="grow ellipsis">{s.title}</span>
              <span className="muted small ellipsis">{s.relPath}</span>
            </button>
          ))}
        </div>
      )}
      <div className="editor-hint muted small">
        Markdown · <kbd>[[</kbd> link to a note · <kbd>#</kbd> tag · <kbd>Ctrl S</kbd> save
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ side panels

function SidePanels({ sid, doc }: { sid: string; doc: Doc }) {
  const [showUnlinked, setShowUnlinked] = useState(false);
  const unlinked = useAsync(
    () => (showUnlinked ? api.get<{ mentions: { docId: string; title: string; snippet: string }[] }>(`${sysApi(sid)}/docs/${encodeURIComponent(doc.id)}/unlinked`) : Promise.resolve({ mentions: [] })),
    [sid, doc.id, showUnlinked],
  );
  const local = useAsync(() => api.get<GraphResult>(`${sysApi(sid)}/graph/local${q({ node: `doc:${doc.id}`, depth: 1 })}`), [sid, doc.id, doc.hash]);
  const outgoing = doc.outgoing.filter((l) => l.kind !== 'tag');
  const unresolved = outgoing.filter((l) => l.resolved === false);
  const resolved = outgoing.filter((l) => l.resolved !== false);
  const uniq = <T extends { docId: string; title: string }>(xs: T[]) => [...new Map(xs.map((x) => [x.docId || x.title, x])).values()];

  return (
    <>
      {doc.properties.length > 0 && (
        <section className="side-panel">
          <h3>Properties</h3>
          <dl className="props">
            {doc.properties.map((p) => (
              <div key={p.key} className="prop">
                <dt>{p.key}</dt>
                <dd>
                  {p.type === 'tags' || Array.isArray(p.values)
                    ? p.values.map((v, i) => (
                        <span key={i} className="chip">
                          {String(v)}
                        </span>
                      ))
                    : String(p.values)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {doc.tags.length > 0 && (
        <section className="side-panel">
          <h3>Tags</h3>
          <div className="chips">
            {doc.tags.map((t) => (
              <Link key={t} to={paths.search(sid, `tag:${t}`)} className="tag">
                #{t}
              </Link>
            ))}
          </div>
        </section>
      )}

      {doc.headings.length > 1 && (
        <section className="side-panel">
          <h3>Outline</h3>
          <ul className="outline">
            {doc.headings.map((h, i) => (
              <li key={i} style={{ paddingLeft: (h.level - 1) * 12 }}>
                <a
                  href={`#${slug(h.text)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(slug(h.text))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="side-panel">
        <h3>
          Backlinks <span className="count">{uniq(doc.backlinks).length}</span>
        </h3>
        {doc.backlinks.length === 0 ? (
          <p className="muted small">No notes link here yet.</p>
        ) : (
          <ul className="links">
            {uniq(doc.backlinks).map((l) => (
              <li key={l.docId}>
                <Link to={paths.note(sid, l.docId)} className="link-title">
                  <Icon name="link" size={14} /> {l.title}
                </Link>
                {l.context && <div className="link-context muted small">{l.context}</div>}
              </li>
            ))}
          </ul>
        )}
        <button type="button" className="link small" onClick={() => setShowUnlinked((s) => !s)}>
          {showUnlinked ? 'Hide unlinked mentions' : 'Unlinked mentions…'}
        </button>
        {showUnlinked &&
          (unlinked.loading ? (
            <Spinner />
          ) : unlinked.data?.mentions.length ? (
            <ul className="links">
              {unlinked.data.mentions.map((m) => (
                <li key={m.docId}>
                  <Link to={paths.note(sid, m.docId)} className="link-title">
                    {m.title}
                  </Link>
                  <div className="link-context muted small">{m.snippet.replace(/\u0002|\u0003/g, '')}</div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">No unlinked mentions.</p>
          ))}
      </section>

      <section className="side-panel">
        <h3>
          Outgoing links <span className="count">{uniq(resolved).length}</span>
        </h3>
        {resolved.length === 0 && unresolved.length === 0 && <p className="muted small">No links.</p>}
        <ul className="links">
          {uniq(resolved).map((l) => (
            <li key={l.docId || l.title}>
              {l.docId ? (
                <Link to={paths.note(sid, l.docId)} className="link-title">
                  <Icon name="link" size={14} /> {l.title}
                </Link>
              ) : (
                <span>{l.title}</span>
              )}
            </li>
          ))}
          {unresolved.map((l, i) => (
            <li key={`u${i}`}>
              <span className="link-title unresolved" title="The note does not exist yet">
                <Icon name="plus" size={14} /> {l.targetRaw ?? l.title}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="side-panel">
        <h3>Local graph</h3>
        <div className="mini-graph">
          {local.data ? <GraphCanvas data={local.data} focusId={`doc:${doc.id}`} compact onOpen={(n) => n.refId && n.type === 'note' && navigate(paths.note(sid, n.refId))} /> : local.error ? <p className="muted small">The graph is unavailable.</p> : <Spinner />}
        </div>
      </section>
    </>
  );
}
