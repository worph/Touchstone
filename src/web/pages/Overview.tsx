/**
 * Overview — the landing page. Answers, in order: is the system healthy, what
 * is broken, what do I fix first.
 *
 * The two status columns are the point. In the current corpus the functional
 * column is uniformly hatched and the story tells itself: nothing is wrong with
 * these apps' functional behaviour, we simply have not been able to look.
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { subjectName } from '@shared/subject';
import type { Leg, SubjectState } from '@shared/types';
import ReassayButton from '../components/ReassayButton';
import { StatusLegend } from '../components/StatusCell';
import SubjectTable, { SubjectSummary } from '../components/SubjectTable';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { getAlerts, getSubjects } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import { duration, num, plural } from '../lib/format';
import {
  applyShow, deriveBacklog, FRESH_DAYS, search, sortSubjects, tally,
  type BlockedBacklog, type LiveRun,
} from '../lib/overview';
import { useRunStatus } from '../data/runStatus';
import { liveLegs, progressLabel } from '../lib/run';
import { humaniseReason } from '../lib/status';
import type { ShowFilter, SortKey } from '../types';

const SHOW_OPTIONS: { value: ShowFilter; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'failing', label: 'failing' },
  { value: 'compliant', label: 'compliant' },
  { value: 'blocked', label: 'blocked' },
  { value: 'not-run', label: 'not yet run' },
  { value: 'running', label: 'running' },
  { value: 'stale', label: `stale (≥ ${FRESH_DAYS}d)` },
];

export default function Overview() {
  const { data, error, loading, reload } = useAsync(getSubjects, []);
  /**
   * The live environment, beside the archive's memory of it.
   *
   * These answer different questions and the page needs both: an open alert says the *next*
   * audit will be narrower, a blocked record says an *old* one already was. Reading the second
   * as the first is how this page came to announce a bench outage over a healthy pool.
   */
  const alerts = useAsync(getAlerts, []);
  const [params, setParams] = useSearchParams();
  const status = useRunStatus();

  const q = params.get('q') ?? '';
  const show = (params.get('show') as ShowFilter) ?? 'all';
  const leg = (params.get('leg') as 'any' | Leg) ?? 'any';
  const sort = (params.get('sort') as SortKey) ?? 'risk';
  const dir = (params.get('dir') as 'asc' | 'desc') ?? 'desc';

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || v === 'all' || v === 'any') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const subjects = useMemo(() => data ?? [], [data]);

  /**
   * The audit in flight, overlaid on the table.
   *
   * `◴ running` was in the vocabulary from the start — the cell, the tally and the filter all
   * knew how to draw it — and nothing ever produced one, because the runner writes a report
   * only when it has a verdict. This is where it comes from: not a placeholder file in the
   * archive, but the live run applied at render time.
   */
  const live: LiveRun | null = useMemo(() => {
    const running = status?.running;
    if (!running) return null;
    const counted = progressLabel(status?.progress);
    return {
      subject: running.subject,
      legs: liveLegs(running),
      started_at: running.started_at,
      ...(counted ? { note: counted } : {}),
    };
  }, [status?.running, status?.progress]);

  const t = useMemo(() => tally(subjects, live), [subjects, live]);
  const backlog = useMemo(() => deriveBacklog(subjects, live), [subjects, live]);
  const openAlerts = alerts.data?.open ?? [];

  const rows = useMemo(() => {
    const filtered = subjects.filter((s) => search(s, q) && applyShow(s, show, leg, live));
    return sortSubjects(filtered, sort, dir);
  }, [subjects, q, show, leg, sort, dir, live]);

  // Derived from the rows rather than fetched: the Overview already knows every subject's
  // store, and a second request to learn a boolean it can count would be a request that can
  // fail on its own.
  const showOrigin = useMemo(() => new Set(subjects.map((s) => s.origin)).size > 1, [subjects]);

  if (loading) return <div className="page"><Loading what="subjects" /></div>;
  if (error) {
    return (
      <div className="page">
        <Notice tone="error" title="Could not load the subject list">
          {error.message}
        </Notice>
      </div>
    );
  }
  if (subjects.length === 0) {
    return (
      <div className="page">
        <EmptyState
          glyph="⬜"
          title="No subjects yet"
          sub="The index is empty. Audit an app from its page, or arm the scheduler, and reports will appear under data/reports as markdown files."
        />
      </div>
    );
  }

  const toggleShow = (value: ShowFilter, forLeg: 'any' | Leg) => {
    const active = show === value && leg === forLeg;
    set({ show: active ? null : value, leg: active ? null : forLeg });
  };

  return (
    <div className="page page--wide">
      <SubjectSummary t={t} show={show} leg={leg} onPick={toggleShow} />

      {/*
        Two different facts, and only one of them is chrome-worthy.

        An OPEN alert changes what the next audit will do, so it gets the banner. A blocked
        record with no open alert is a leftover: the environment recovered and nobody has been
        back. That reads as a to-do, not an alarm — and saying "pool unavailable" over a
        healthy pool is how this page used to contradict Activity one click away.
      */}
      {openAlerts.length > 0 ? (
        <div style={{ marginTop: 12 }}>
          <Notice
            tone="warn"
            title={
              <>
                {openAlerts[0]!.title}
                {openAlerts.length > 1 ? ` · and ${openAlerts.length - 1} more` : ''} — open{' '}
                <span className="num">{duration(openAlerts[0]!.opened_at)}</span>
              </>
            }
          >
            {openAlerts[0]!.detail ? <>{openAlerts[0]!.detail}. </> : null}
            Audits still run: a section that needs nothing missing gets its verdict, the rest are
            recorded blocked. No app is charged a retry for this and no verdict is reached about
            one — a blocked cell is grey and hatched, never red.
          </Notice>
        </div>
      ) : backlog ? (
        <BacklogNote backlog={backlog} onShow={() => toggleShow('blocked', 'any')} onFinished={reload} />
      ) : null}

      <div className="toolbar">
        <label>
          show
          <select
            className="control"
            value={show}
            onChange={(e) => set({ show: e.target.value })}
          >
            {SHOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>

        <label>
          in
          <select className="control" value={leg} onChange={(e) => set({ leg: e.target.value })}>
            <option value="any">either section</option>
            <option value="static">static only</option>
            <option value="functional">functional only</option>
          </select>
        </label>

        <span className="search">
          <span className="glyph" aria-hidden="true">⌕</span>
          <input
            className="control"
            type="search"
            placeholder="subject, rule, image, ref…"
            value={q}
            onChange={(e) => set({ q: e.target.value })}
            aria-label="Search subjects"
          />
        </span>

        <span className="spacer" />
        <span className="result-count">
          {rows.length === subjects.length
            ? plural(rows.length, 'subject')
            : `${num(rows.length)} of ${num(subjects.length)} subjects`}
        </span>
      </div>

      <div className="panel">
        {rows.length === 0 ? (
          <EmptyState
            glyph="⌕"
            title="Nothing matches"
            sub="No subject satisfies this combination of filter and search."
            action={
              <button className="btn" type="button" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                Clear filters
              </button>
            }
          />
        ) : (
          <SubjectTable
            rows={rows}
            sort={sort}
            dir={dir}
            onSort={(k, d) => set({ sort: k, dir: d })}
            href={(s) => `/s/${encodeURIComponent(s.name)}`}
            live={live}
            showOrigin={showOrigin}
          />
        )}
        <StatusLegend />
      </div>
    </div>
  );
}

/**
 * The leftover, in the past tense, naming who it is about.
 *
 * Deliberately not a `Notice`: nothing is wrong right now, and warning chrome for a to-do is
 * how a page teaches people to ignore its warnings. It says what has no verdict, why, how long
 * it has been outstanding — and offers the two things a reader would go looking for: the rows
 * themselves, and the re-assay that clears it.
 */
function BacklogNote({
  backlog,
  onShow,
  onFinished,
}: {
  backlog: BlockedBacklog;
  onShow: () => void;
  onFinished: () => void;
}) {
  const named = backlog.items.slice(0, 3);
  const rest = backlog.count - named.length;
  const only = backlog.items.length === 1 ? backlog.items[0]! : null;

  return (
    <div className="backlog-note">
      <span className="backlog-note__mark" aria-hidden="true">▨</span>
      <span className="backlog-note__text">
        {plural(backlog.count, 'section')} carrying no verdict —{' '}
        {named.map((it, i) => (
          <span key={`${it.subject}-${it.section}`}>
            {i > 0 ? ', ' : ''}
            <Link to={`/s/${encodeURIComponent(it.subject)}`}>{subjectName(it.subject)}</Link>
            <span className="dim"> · {it.section}</span>
          </span>
        ))}
        {rest > 0 ? <span className="dim"> and {rest} more</span> : null}
        {', '}
        {reasonPhrase(backlog.reason)} <span className="num">{duration(backlog.since)}</span> ago.
        {' '}Nothing was concluded about {backlog.count === 1 ? 'it' : 'them'} and no retry was
        spent; a re-assay clears it.
      </span>
      <span className="spacer" />
      {backlog.count > 1 ? (
        <button className="btn btn--sm" type="button" onClick={onShow}>
          show {backlog.count === 1 ? 'it' : 'them'}
        </button>
      ) : null}
      {only ? <ReassayButton subject={only.subject} onFinished={onFinished} label="re-assay" /> : null}
    </div>
  );
}

/** The reason as something that *happened*, since the record is history. */
function reasonPhrase(reason: string): string {
  const r = humaniseReason(reason) ?? reason;
  if (r.includes('bench')) return 'no demo bench was available when it was last audited,';
  if (r.includes('browser')) return 'no browser was answering when it was last audited,';
  if (r.includes('agent')) return 'the audit agent was unavailable,';
  return `blocked on ${reason},`;
}

