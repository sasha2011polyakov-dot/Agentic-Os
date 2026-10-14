import { useEffect, useMemo, useRef, useState } from 'react';
import { api, onServerEvent, q } from '../api.ts';
import { sysApi } from '../ctx.tsx';
import { Link, navigate, paths } from '../router.tsx';
import { Badge, Button, Empty, ErrorBox, Icon, Spinner, timeAgo, useAsync, useToast, errorText } from '../ui.tsx';
import type { MissionEvent, MissionListItem, MissionStatus, MissionView, Pending, Preflight } from '../types.ts';

export function missionTone(s: MissionStatus): 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'accent' {
  if (s === 'completed') return 'ok';
  if (s === 'partially_completed' || s === 'needs_input' || s === 'awaiting_approval' || s === 'needs_fix') return 'warn';
  if (s === 'failed') return 'bad';
  if (s === 'cancelled' || s === 'draft' || s === 'paused') return 'neutral';
  return 'info';
}

const ACTIVE: MissionStatus[] = ['analyzing', 'researching', 'planning', 'ready', 'executing', 'verifying', 'needs_fix', 'awaiting_approval', 'needs_input', 'paused'];

// ================================================================================================ list

export function MissionsPage({ sid }: { sid: string }) {
  const [tab, setTab] = useState<'active' | 'done' | 'all'>('all');
  const list = useAsync(() => api.get<{ items: MissionListItem[]; total: number }>(`${sysApi(sid)}/missions${q({ limit: 200 })}`), [sid]);
  useEffect(() => onServerEvent((e) => e.type === 'mission.updated' && e.systemId === sid && list.reload()), [sid, list]);
  const items = (list.data?.items ?? []).filter((m) => (tab === 'all' ? true : tab === 'active' ? ACTIVE.includes(m.status) : !ACTIVE.includes(m.status)));
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Icon name="target" size={14} /> Missions
          </div>
          <h1>Tasks for agents</h1>
          <p className="muted">A task in plain words → analysis, plan, execution, verification with evidence. Changes to projects happen only with your permission.</p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => navigate(paths.newMission(sid))}>
          New mission
        </Button>
      </header>
      <div className="seg">
        {(
          [
            ['all', 'All'],
            ['active', 'In progress'],
            ['done', 'Finished'],
          ] as const
        ).map(([k, l]) => (
          <button type="button" key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <ErrorBox error={list.error} onRetry={list.reload} />
      ) : items.length === 0 ? (
        <Empty icon="target" title={list.data?.items.length ? 'Nothing in this section' : 'No missions yet'}>
          For example: "Study my notes about the project and draft a release plan" or "Find where the project handles login and propose a fix".
        </Empty>
      ) : (
        <div className="mission-list">
          {items.map((m) => (
            <Link key={m.id} to={paths.mission(sid, m.id)} className="mission-row card aos-themable">
              <span className="mono small muted">{m.key}</span>
              <div className="grow">
                <div className="mission-title">{m.title}</div>
                <div className="muted small ellipsis">{m.statusReason ?? m.phaseLabel}</div>
              </div>
              <Badge tone="neutral">{m.mode === 'plan' ? 'research and plan' : 'execute'}</Badge>
              <Badge tone={missionTone(m.status)}>{m.statusLabel}</Badge>
              <span className="muted small nowrap">{timeAgo(m.updatedAt)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ================================================================================================ new

export function NewMissionPage({ sid }: { sid: string }) {
  const toast = useToast();
  const [request, setRequest] = useState('');
  const [mode, setMode] = useState<'plan' | 'execute'>('plan');
  const [allowWeb, setAllowWeb] = useState(false);
  const [priority, setPriority] = useState('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const pre = useAsync(() => api.post<{ preflight: Preflight }>(`${sysApi(sid)}/missions/preflight`, { mode, scope: { allowWeb } }).then((r) => r.preflight), [sid, mode, allowWeb]);
  const [preparing, setPreparing] = useState(false);
  const agentsMissing = pre.data?.agents.some((a) => !a.enabled) ?? false;

  const setup = async () => {
    setPreparing(true);
    try {
      await api.post(`${sysApi(sid)}/missions/setup-agents`);
      toast('ok', 'The mission agents are installed and enabled');
      pre.reload();
    } catch (e) {
      toast('bad', errorText(e));
    } finally {
      setPreparing(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ mission: MissionView }>(`${sysApi(sid)}/missions`, { request: request.trim(), mode, priority, scope: { allowWeb } });
      navigate(paths.mission(sid, r.mission.id));
    } catch (e) {
      setError(e);
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <header className="page-head">
        <div>
          <div className="eyebrow">
            <Link to={paths.missions(sid)} className="link">
              Missions
            </Link>{' '}
            / new
          </div>
          <h1>New mission</h1>
        </div>
      </header>
      <div className="card panel aos-themable">
        <div className="form">
          <label>
            What needs to be done?
            <textarea className="request" autoFocus value={request} onChange={(e) => setRequest(e.target.value)} rows={6} maxLength={20000} placeholder="Describe the task in your own words: what you need, what matters, what must not be done." />
          </label>
          <div className="field">
            <span>Mode</span>
            <div className="seg">
              <button type="button" className={mode === 'plan' ? 'on' : ''} onClick={() => setMode('plan')}>
                Research and plan
              </button>
              <button type="button" className={mode === 'execute' ? 'on' : ''} onClick={() => setMode('execute')}>
                Execute the task
              </button>
            </div>
            <span className="hint">{mode === 'plan' ? 'Nothing changes: analysis, solution options and a plan.' : 'Agents carry out the plan. Changes to project files are only proposed: only you can apply them.'}</span>
          </div>
          <div className="row wrap">
            <label className="check">
              <input type="checkbox" checked={allowWeb} onChange={(e) => setAllowWeb(e.target.checked)} />
              Allow internet search
            </label>
            <span className="grow" />
            <label className="inline">
              Priority
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="critical">critical</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
            </label>
          </div>
        </div>
      </div>

      <div className="card panel aos-themable">
        <div className="panel-head">
          <h2>Readiness</h2>
          {pre.data && <Badge tone={pre.data.ok ? 'ok' : 'warn'}>{pre.data.ok ? 'ready to run' : 'needs setup'}</Badge>}
        </div>
        {pre.loading && !pre.data ? (
          <Spinner label="Checking agents and models…" />
        ) : pre.error ? (
          <ErrorBox error={pre.error} onRetry={pre.reload} />
        ) : pre.data ? (
          <>
            <p className="muted small">
              AI mode: <strong>{pre.data.aiMode === 'local' ? 'local models only' : pre.data.aiMode === 'hybrid' ? 'hybrid' : 'cloud'}</strong>
              {pre.data.offline ? ' · offline' : ''}
            </p>
            {pre.data.problems.map((p, i) => (
              <div key={i} className="line bad">
                <Icon name="alert" size={15} /> {p}
              </div>
            ))}
            {pre.data.warnings.map((w, i) => (
              <div key={i} className="line warn">
                <Icon name="spark" size={15} /> {w}
              </div>
            ))}
            {agentsMissing && (
              <div className="row">
                <Button icon="check" busy={preparing} onClick={() => void setup()}>
                  Set up agents
                </Button>
                <span className="muted small">Installs and enables the built-in mission agents in this system. Agents are never installed without your action.</span>
              </div>
            )}
            {!agentsMissing && pre.data.agents.some((a) => a.routeError) && (
              <p className="muted small">Agents need a model. A local model (Ollama, LM Studio) needs no key; there is no switch to the cloud without your decision.</p>
            )}
          </>
        ) : null}
      </div>

      {error != null && <ErrorBox error={error} />}
      <div className="row end">
        <Button variant="ghost" onClick={() => navigate(paths.missions(sid))}>
          Cancel
        </Button>
        <Button variant="primary" icon="play" busy={busy} disabled={request.trim().length < 3} onClick={() => void submit()}>
          Start the mission
        </Button>
      </div>
    </div>
  );
}

// ================================================================================================ detail

const CRITERION: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'neutral' | 'info' }> = {
  pending: { label: 'pending', tone: 'neutral' },
  met: { label: 'met', tone: 'ok' },
  partially_met: { label: 'partially met', tone: 'warn' },
  not_met: { label: 'not met', tone: 'bad' },
  unverifiable: { label: 'not confirmed', tone: 'warn' },
  not_applicable: { label: 'not applicable', tone: 'neutral' },
};

const STEP_STATUS: Record<string, string> = { pending: 'pending', running: 'running', completed: 'done', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled', waiting_for_approval: 'waiting for a decision' };

export function MissionPage({ sid, mid }: { sid: string; mid: string }) {
  const toast = useToast();
  const m = useAsync(() => api.get<{ mission: MissionView }>(`${sysApi(sid)}/missions/${encodeURIComponent(mid)}`).then((r) => r.mission), [sid, mid]);
  const [events, setEvents] = useState<MissionEvent[]>([]);
  const lastEvent = useRef(0);
  const [requirement, setRequirement] = useState('');

  const loadEvents = useRef(async () => {});
  loadEvents.current = async () => {
    try {
      const r = await api.get<{ events: MissionEvent[] }>(`${sysApi(sid)}/missions/${encodeURIComponent(mid)}/events${q({ after: lastEvent.current, limit: 500 })}`);
      if (r.events.length) {
        lastEvent.current = r.events[r.events.length - 1]!.id;
        setEvents((ev) => {
          const seen = new Set(ev.map((e) => e.id));
          return [...ev, ...r.events.filter((e) => !seen.has(e.id))].slice(-400);
        });
      }
    } catch {
      // the log is secondary; the mission view shows errors
    }
  };

  useEffect(() => {
    void loadEvents.current();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = onServerEvent((e) => {
      if (!(e.type === 'mission.updated' || e.type === 'mission.event') || (e.data as { missionId?: string }).missionId !== m.data?.id) return;
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        m.reload();
        void loadEvents.current();
      }, 300);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sid, mid, m.data?.id]);

  const act = async (path: string, body: unknown = {}) => {
    try {
      const r = await api.post<{ mission: MissionView }>(`${sysApi(sid)}/missions/${encodeURIComponent(mid)}/${path}`, body);
      if (r?.mission) m.setData(r.mission);
      void loadEvents.current();
    } catch (e) {
      toast('bad', errorText(e));
    }
  };

  if (m.loading && !m.data) return <div className="page"><Spinner /></div>;
  if (m.error) return <div className="page"><ErrorBox error={m.error} onRetry={m.reload} /></div>;
  const v = m.data!;
  const finished = ['completed', 'partially_completed', 'failed', 'cancelled'].includes(v.status);
  const working = ['analyzing', 'researching', 'planning', 'ready', 'executing', 'verifying', 'needs_fix'].includes(v.status);

  return (
    <div className="page mission-page">
      <header className="page-head">
        <div className="grow">
          <div className="eyebrow">
            <Link to={paths.missions(sid)} className="link">
              Missions
            </Link>{' '}
            / <span className="mono">{v.key}</span> · {v.mode === 'plan' ? 'research and plan' : 'execute the task'}
          </div>
          <h1>{v.title}</h1>
          <div className="row wrap">
            <Badge tone={missionTone(v.status)}>{v.statusLabel}</Badge>
            {working && <span className="spinner" aria-hidden="true" />}
            {v.statusReason && <span className="muted small">{v.statusReason}</span>}
          </div>
        </div>
        <div className="row">
          {(working || v.status === 'awaiting_approval' || v.status === 'needs_input') && (
            <Button icon="pause" onClick={() => void act('pause')}>
              Pause
            </Button>
          )}
          {v.status === 'paused' && (
            <Button variant="primary" icon="play" onClick={() => void act('resume')}>
              Resume
            </Button>
          )}
          {v.status === 'draft' && (
            <Button variant="primary" icon="play" onClick={() => void act('start')}>
              Start
            </Button>
          )}
          {!finished && (
            <Button variant="ghost" icon="stop" onClick={() => confirm('Cancel the mission? Intermediate results will be kept.') && void act('cancel')}>
              Cancel
            </Button>
          )}
        </div>
      </header>

      <Stepper phases={v.progress.phases} />

      {v.pending && <PendingCard sid={sid} mission={v} pending={v.pending} onDecided={(mv) => m.setData(mv)} />}

      {v.error && !v.pending && (
        <div className="banner bad">
          <Icon name="alert" /> {v.error.message} {v.error.hint && <span className="muted">{v.error.hint}</span>}
        </div>
      )}

      {v.summary && finished && <SummaryCard v={v} sid={sid} />}

      <div className="grid-2">
        <section className="card panel aos-themable">
          <div className="panel-head">
            <h2>Acceptance criteria</h2>
            <span className="muted small">{v.criteria.filter((c) => c.status === 'met').length} of {v.criteria.filter((c) => c.status !== 'not_applicable').length}</span>
          </div>
          {v.criteria.length === 0 ? (
            <p className="muted small">They appear after the task analysis.</p>
          ) : (
            <ul className="criteria">
              {v.criteria.map((c) => (
                <li key={c.id}>
                  <div className="row">
                    <span className="mono small muted">{c.id}</span>
                    <span className="grow">{c.text}</span>
                    <Badge tone={CRITERION[c.status]?.tone ?? 'neutral'}>{CRITERION[c.status]?.label ?? c.status}</Badge>
                  </div>
                  {c.evidence && <div className="small evidence">Evidence: {c.evidence}</div>}
                  {c.notes && <div className="small muted">{c.notes}</div>}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card panel aos-themable">
          <div className="panel-head">
            <h2>Plan</h2>
            {v.progress.steps.total > 0 && (
              <span className="muted small">
                {v.progress.steps.done} of {v.progress.steps.total}
              </span>
            )}
          </div>
          {v.plan.length === 0 ? (
            <p className="muted small">The plan appears after the analysis{v.mode === 'plan' ? ' and the research' : ''}.</p>
          ) : (
            <ol className="plan">
              {v.plan.map((p) => {
                const st = [...v.steps].reverse().find((s) => s.phase === 'execution' && s.planStep === p.id);
                return (
                  <li key={p.id} className={`plan-step st-${st?.status ?? 'pending'}`}>
                    <span className="mono small muted">{p.id}</span>
                    <div className="grow">
                      <div>{p.title}</div>
                      <div className="muted small">
                        {p.role}
                        {p.depends_on.length ? ` · after ${p.depends_on.join(', ')}` : ''}
                        {st?.error ? ` · ${st.error.message}` : ''}
                      </div>
                    </div>
                    <span className="small muted nowrap">{STEP_STATUS[st?.status ?? 'pending'] ?? st?.status}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      </div>

      <div className="grid-2">
        <section className="card panel aos-themable">
          <div className="panel-head">
            <h2>Original request</h2>
          </div>
          <blockquote className="request-quote">{v.originalRequest}</blockquote>
          {v.assumptions.length > 0 && (
            <>
              <h3>Assumptions</h3>
              <ul className="bullets">
                {v.assumptions.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </>
          )}
          {v.extraRequirements.length > 0 && (
            <>
              <h3>Added by you</h3>
              <ul className="bullets">
                {v.extraRequirements.map((r) => (
                  <li key={r.id}>
                    <span className="mono small muted">{r.id}</span> {r.text}
                  </li>
                ))}
              </ul>
            </>
          )}
          {v.status !== 'cancelled' && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                if (requirement.trim().length >= 3) void act('requirements', { text: requirement.trim() }).then(() => setRequirement(''));
              }}
            >
              <input className="grow" value={requirement} onChange={(e) => setRequirement(e.target.value)} placeholder="Add a requirement: the plan will be recalculated" maxLength={2000} />
              <Button icon="plus" disabled={requirement.trim().length < 3} onClick={() => void act('requirements', { text: requirement.trim() }).then(() => setRequirement(''))}>
                Add
              </Button>
            </form>
          )}
        </section>

        <section className="card panel aos-themable">
          <div className="panel-head">
            <h2>Log</h2>
            <span className="muted small">{events.length}</span>
          </div>
          <EventLog events={events} />
        </section>
      </div>

      {(v.limitations.length > 0 || v.notExecuted.length > 0) && !finished && (
        <section className="card panel aos-themable">
          <h2>Limitations</h2>
          <ul className="bullets">
            {v.limitations.map((l, i) => (
              <li key={i} className={v.notExecuted.includes(l) ? 'gap' : ''}>
                {l}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stepper({ phases }: { phases: MissionView['progress']['phases'] }) {
  return (
    <ol className="stepper" aria-label="Stages">
      {phases.map((p) => (
        <li key={p.phase} className={`step step-${p.state}`}>
          <span className="step-dot">{p.state === 'done' ? <Icon name="check" size={12} /> : null}</span>
          <span className="step-label">{p.label}</span>
        </li>
      ))}
    </ol>
  );
}

function EventLog({ events }: { events: MissionEvent[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const shown = useMemo(() => events.filter((e) => e.level !== 'debug'), [events]);
  useEffect(() => {
    const el = ref.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }, [shown.length]);
  if (!shown.length) return <p className="muted small">No events yet.</p>;
  return (
    <div className="event-log" ref={ref}>
      {shown.map((e) => (
        <div key={e.id} className={`event lvl-${e.level}`}>
          <span className="event-time mono">{new Date(e.ts).toLocaleTimeString('en-US')}</span>
          <span className="event-msg">{e.message}</span>
        </div>
      ))}
    </div>
  );
}

function SummaryCard({ v, sid }: { v: MissionView; sid: string }) {
  const s = v.summary!;
  return (
    <section className={`card panel summary tone-${missionTone(v.status)} aos-themable`}>
      <div className="panel-head">
        <h2>Outcome: {v.statusLabel}</h2>
        {v.reportDocId && (
          <Link to={paths.note(sid, v.reportDocId)} className="link">
            Open the report
          </Link>
        )}
      </div>
      <p>{s.statusReason}</p>
      <div className="grid-2 tight">
        {s.done.length > 0 && (
          <div>
            <h3>What was done</h3>
            <ul className="bullets">
              {s.done.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        {v.notExecuted.length > 0 && (
          <div>
            <h3>What did not run</h3>
            <ul className="bullets gap">
              {v.notExecuted.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        {s.checksNotRun.length > 0 && (
          <div>
            <h3>Checks that were not run</h3>
            <ul className="bullets">
              {s.checksNotRun.map((x, i) => (
                <li key={i}>
                  {x.name}: {x.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.limitations.filter((l) => !v.notExecuted.includes(l)).length > 0 && (
          <div>
            <h3>Limitations and notes</h3>
            <ul className="bullets">
              {s.limitations
                .filter((l) => !v.notExecuted.includes(l))
                .map((x, i) => (
                  <li key={i}>{x}</li>
                ))}
            </ul>
          </div>
        )}
        {s.nextSteps.length > 0 && (
          <div>
            <h3>Next steps</h3>
            <ul className="bullets">
              {s.nextSteps.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        )}
        {s.resultsLocation.length > 0 && (
          <div>
            <h3>Where the results are</h3>
            <ul className="bullets">
              {s.resultsLocation.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}

// ================================================================================================ decisions

function PendingCard({ sid, mission, pending, onDecided }: { sid: string; mission: MissionView; pending: Pending; onDecided: (m: MissionView) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [comment, setComment] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [optionId, setOptionId] = useState<string>(String(pending.data.selected ?? ''));
  const checks = (pending.data.checks as { sourceId: string; sourceName: string; name: string; command: string; required: boolean }[] | undefined) ?? [];
  const [approved, setApproved] = useState<Set<string>>(() => new Set(checks.map((c) => `${c.sourceId}:${c.name}`)));
  const risks = (pending.data.risks as { id: string; title: string; what: string; danger: string; severity: string }[] | undefined) ?? [];
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const paused = mission.status === 'paused';

  const decide = async (decision: string, extra: Record<string, unknown> = {}) => {
    setBusy(decision);
    try {
      const r = await api.post<{ mission: MissionView }>(`${sysApi(sid)}/missions/${encodeURIComponent(mission.id)}/decide`, { decision, pendingId: pending.id, ...(comment.trim() ? { comment: comment.trim() } : {}), ...extra });
      onDecided(r.mission);
      setComment('');
    } catch (e) {
      toast('bad', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const btn = (decision: string, label: string, variant: 'primary' | 'default' | 'ghost' | 'danger' = 'default', extra: Record<string, unknown> = {}, disabled = false) => (
    <Button variant={variant} busy={busy === decision} disabled={!!busy || paused || disabled} onClick={() => void decide(decision, extra)}>
      {label}
    </Button>
  );

  const k = pending.kind;
  const questions = (pending.data.questions as { text: string }[] | undefined) ?? [];
  const options = (pending.data.options as { id: string; name: string; description: string; pros: string[]; cons: string[] }[] | undefined) ?? [];
  const plan = (pending.data.plan as { id: string; title: string; role: string; risk: string; depends_on: string[] }[] | undefined) ?? [];
  const files = (pending.data.files as { id: string; source: string; path: string; op: string; added?: number; removed?: number }[] | undefined) ?? [];
  const reasons = (pending.data.reasons as string[] | undefined) ?? [];

  return (
    <section className="card panel pending aos-protected" role="region" aria-label="Your decision is needed">
      <div className="panel-head">
        <h2>
          <Icon name="alert" /> {pending.title}
        </h2>
        <span className="muted small">{timeAgo(pending.createdAt)}</span>
      </div>
      <p>{pending.message}</p>
      {paused && <p className="muted small">The mission is paused: press "Resume" to answer.</p>}

      {k === 'questions' && (
        <div className="form">
          {questions.map((qq) => (
            <label key={qq.text}>
              {qq.text}
              <input value={answers[qq.text] ?? ''} onChange={(e) => setAnswers({ ...answers, [qq.text]: e.target.value })} />
            </label>
          ))}
        </div>
      )}

      {k === 'strategy' && options.length > 0 && (
        <div className="options">
          {options.map((o) => (
            <label key={o.id} className={`option card ${optionId === o.id ? 'on' : ''}`}>
              <input type="radio" name="opt" checked={optionId === o.id} onChange={() => setOptionId(o.id)} />
              <div>
                <strong>
                  {o.id}. {o.name}
                </strong>
                {o.id === pending.data.selected && <Badge tone="accent">recommended</Badge>}
                <p className="small">{o.description}</p>
                {o.pros.length > 0 && <div className="small ok-text">+ {o.pros.join('; ')}</div>}
                {o.cons.length > 0 && <div className="small bad-text">− {o.cons.join('; ')}</div>}
              </div>
            </label>
          ))}
        </div>
      )}

      {k === 'plan' && (
        <>
          {reasons.length > 0 && (
            <ul className="bullets small">
              {reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          <ol className="plan compact">
            {plan.map((p) => (
              <li key={p.id} className="plan-step">
                <span className="mono small muted">{p.id}</span>
                <span className="grow">{p.title}</span>
                <span className="muted small">{p.role}</span>
                {p.risk === 'high' && <Badge tone="warn">risk</Badge>}
              </li>
            ))}
          </ol>
          {checks.length > 0 && (
            <div className="checks">
              <h3>Allow the checks to run in an isolated work copy</h3>
              {checks.map((c) => {
                const key = `${c.sourceId}:${c.name}`;
                return (
                  <label key={key} className="check">
                    <input
                      type="checkbox"
                      checked={approved.has(key)}
                      onChange={(e) => {
                        const n = new Set(approved);
                        if (e.target.checked) n.add(key);
                        else n.delete(key);
                        setApproved(n);
                      }}
                    />
                    <span>
                      {c.sourceName}/{c.name}: <code>{c.command}</code>
                    </span>
                  </label>
                );
              })}
            </div>
          )}
        </>
      )}

      {k === 'apply_changes' && (
        <>
          <ul className="files">
            {files.map((f) => (
              <li key={f.id} className="mono small">
                <span className={`op op-${f.op}`}>{f.op}</span> {f.source}: {f.path}
                {f.added !== undefined && (
                  <span className="muted">
                    {' '}
                    +{f.added} −{f.removed}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {risks.length > 0 && (
            <div className="risks">
              <h3>Confirm the risks</h3>
              {risks.map((r) => (
                <label key={r.id} className="check risk">
                  <input
                    type="checkbox"
                    checked={confirmed.has(r.id)}
                    onChange={(e) => {
                      const n = new Set(confirmed);
                      if (e.target.checked) n.add(r.id);
                      else n.delete(r.id);
                      setConfirmed(n);
                    }}
                  />
                  <span>
                    <strong>{r.title}.</strong> {r.what} <span className="muted">{r.danger}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </>
      )}

      {(k === 'questions' || k === 'strategy' || k === 'plan' || k === 'conflict') && (
        <textarea className="comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} placeholder={k === 'questions' ? 'Or clarify the task in your own words…' : 'Comment (needed for "Change")'} />
      )}

      <div className="row wrap decision-row">
        {k === 'setup_agents' && (
          <>
            {btn('approve', 'Set up agents', 'primary')}
            {btn('reject', 'Cancel the mission', 'ghost')}
          </>
        )}
        {(k === 'model' || k === 'budget') && (
          <>
            {btn('retry', 'Retry', 'primary')}
            {btn('reject', 'Cancel the mission', 'ghost')}
          </>
        )}
        {k === 'questions' && (
          <>
            {btn('approve', 'Answer', 'primary', { answers: questions.map((qq) => ({ question: qq.text, answer: answers[qq.text] ?? '' })) }, questions.some((qq) => !(answers[qq.text] ?? '').trim()))}
            {btn('revise', 'Clarify the task', 'default', {}, !comment.trim())}
            {btn('reject', 'Cancel', 'ghost')}
          </>
        )}
        {k === 'strategy' && (
          <>
            {btn('approve', 'Choose this option', 'primary', optionId ? { optionId } : {})}
            {btn('revise', 'Change', 'default', {}, !comment.trim())}
            {btn('reject', 'Cancel', 'ghost')}
          </>
        )}
        {k === 'plan' && (
          <>
            {btn('approve', 'Approve the plan', 'primary', { approvedChecks: checks.filter((c) => approved.has(`${c.sourceId}:${c.name}`)).map((c) => ({ sourceId: c.sourceId, name: c.name })) })}
            {btn('revise', 'Change the plan', 'default', {}, !comment.trim())}
            {btn('reject', 'Cancel', 'ghost')}
          </>
        )}
        {k === 'conflict' && (
          <>
            {btn('approve', 'The new requirement wins', 'primary')}
            {btn('reject', 'Cancel the new requirement', 'default')}
            {btn('revise', 'Resolve differently', 'ghost', {}, !comment.trim())}
          </>
        )}
        {k === 'error' && (
          <>
            {btn('retry', 'Retry', 'primary')}
            {btn('skip', 'Skip (the result will be partial)', 'default')}
            {btn('reject', 'Cancel the mission', 'ghost')}
          </>
        )}
        {k === 'apply_changes' && (
          <>
            {btn('apply', 'Apply to the project', 'danger', { confirmRisks: [...confirmed], contentHash: pending.data.contentHash }, risks.some((r) => !confirmed.has(r.id)))}
            {btn('skip', 'Do not apply', 'default')}
          </>
        )}
      </div>
    </section>
  );
}
