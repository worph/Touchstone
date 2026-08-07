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

import type { Leg, SubjectState } from '@shared/types';
import StatusCell, { StatusLegend } from '../components/StatusCell';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { getSubjects } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import { ageLabel, duration, num, plural } from '../lib/format';
import {
  applyShow, deriveIncident, FRESH_DAYS, search, sortSubjects, tally,
  type LegTally, type Tallies,
} from '../lib/overview';
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
  { value: 'unverified', label: 'has suspected Critical' },
];

export default function Overview() {
  const { data, error, loading } = useAsync(getSubjects, []);
  const [params, setParams] = useSearchParams();

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
  const t = useMemo(() => tally(subjects), [subjects]);
  const incident = useMemo(() => deriveIncident(subjects), [subjects]);

  const rows = useMemo(() => {
    const filtered = subjects.filter((s) => search(s, q) && applyShow(s, show, leg));
    return sortSubjects(filtered, sort, dir);
  }, [subjects, q, show, leg, sort, dir]);

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
          sub="The index is empty. Run yarn import to pull the roll-up and its linked reports out of Docmost into data/reports."
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
      <Summary t={t} show={show} leg={leg} onPick={toggleShow} />

      {incident ? (
        <div style={{ marginTop: 12 }}>
          <Notice
            tone="warn"
            title={
              <>
                {titleForReason(incident.reason)} — functional queue paused{' '}
                <span className="num">{duration(incident.since)}</span>
              </>
            }
            action={
              incident.potentialFindings > 0 ? (
                <Link className="btn" to="/findings?filter=unverified">
                  {plural(incident.potentialFindings, 'suspected Critical')} waiting
                </Link>
              ) : null
            }
          >
            {plural(incident.count, 'assay')} blocked on{' '}
            <code className="mono">{incident.reason}</code>. No retry budget was consumed and no
            verdict was reached about any of these subjects — the functional column below is grey
            and hatched, never red.
          </Notice>
        </div>
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
            <option value="any">either leg</option>
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
          <table className="tbl">
            <thead>
              <tr>
                <Th label="Subject" k="name" sort={sort} dir={dir} set={set} />
                <Th label="Static" k="static" sort={sort} dir={dir} set={set} />
                <Th label="Functional" k="functional" sort={sort} dir={dir} set={set} />
                <Th label="Risk" k="risk" sort={sort} dir={dir} set={set} align="right" />
                <Th label="Last" k="age" sort={sort} dir={dir} set={set} align="right" />
                <th aria-label="open" />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => <Row key={s.name} s={s} />)}
            </tbody>
          </table>
        )}
        <StatusLegend />
      </div>
    </div>
  );
}

function Row({ s }: { s: SubjectState }) {
  const never = !s.static && !s.functional;
  return (
    <tr>
      <td>
        <Link className="row-link" to={`/s/${encodeURIComponent(s.name)}`}>
          {s.name}
        </Link>
      </td>
      <td><StatusCell record={s.static} showNote={false} /></td>
      <td><StatusCell record={s.functional} /></td>
      <td className="col-num">
        <span className="risk-val" data-zero={s.risk === 0 || never}>
          {never ? '—' : num(s.risk)}
        </span>
      </td>
      <td className="col-num dim">{ageLabel(s.age_days)}</td>
      <td className="col-chev">
        <Link to={`/s/${encodeURIComponent(s.name)}`} aria-label={`Open ${s.name}`}>›</Link>
      </td>
    </tr>
  );
}

function Th({
  label, k, sort, dir, set, align,
}: {
  label: string;
  k: SortKey;
  sort: SortKey;
  dir: 'asc' | 'desc';
  set: (p: Record<string, string | null>) => void;
  align?: 'right';
}) {
  const active = sort === k;
  const nextDir = active && dir === 'desc' ? 'asc' : 'desc';
  return (
    <th
      style={align === 'right' ? { textAlign: 'right' } : undefined}
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : undefined}
    >
      <button type="button" onClick={() => set({ sort: k, dir: nextDir })}>
        {label}
        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.25 }}>
          {active && dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

function Summary({
  t, show, leg, onPick,
}: {
  t: Tallies;
  show: ShowFilter;
  leg: 'any' | Leg;
  onPick: (v: ShowFilter, l: 'any' | Leg) => void;
}) {
  const legRow = (name: string, key: Leg, v: LegTally) => (
    <div className="summary-leg">
      <span className="leg-name">{name}</span>
      <Tally label="compliant" n={v.compliant} kind="ok" on={() => onPick('compliant', key)} active={show === 'compliant' && leg === key} />
      <Tally label="failing" n={v.failing} kind="fail" on={() => onPick('failing', key)} active={show === 'failing' && leg === key} />
      {v.blocked > 0 && (
        <Tally label="blocked" n={v.blocked} kind="blocked" on={() => onPick('blocked', key)} active={show === 'blocked' && leg === key} />
      )}
      {v.running > 0 && (
        <Tally label="running" n={v.running} kind="running" on={() => onPick('running', key)} active={show === 'running' && leg === key} />
      )}
      {v.errored > 0 && (
        <Tally label="errored" n={v.errored} kind="errored" on={() => onPick('failing', key)} active={false} />
      )}
      <Tally label="not yet run" n={v.notRun} kind="none" on={() => onPick('not-run', key)} active={show === 'not-run' && leg === key} />
    </div>
  );

  return (
    <div className="panel summary">
      <div className="summary-total">
        <span className="n">{num(t.subjects)}</span>
        <span className="section-title">subjects</span>
      </div>
      <div className="summary-legs">
        {legRow('Static', 'static', t.static)}
        {legRow('Functional', 'functional', t.functional)}
      </div>
      <div className="summary-risk">
        <span className="n">{num(t.risk)}</span>
        <span className="section-title">total risk</span>
        {t.potentialRisk > 0 ? (
          <button
            type="button"
            className="summary-tally sub-potential"
            style={{ justifyContent: 'flex-end' }}
            onClick={() => onPick('unverified', 'any')}
            aria-pressed={show === 'unverified'}
            title="Suspected but unproven. Never added to the observed total."
          >
            ({num(t.potentialRisk)}) potential
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Tally({
  label, n, kind, on, active,
}: {
  label: string;
  n: number;
  kind: string;
  on: () => void;
  active: boolean;
}) {
  return (
    <button
      type="button"
      className="summary-tally"
      data-zero={n === 0}
      aria-pressed={active}
      onClick={on}
      title={`Filter to subjects whose leg is ${label}`}
    >
      <span className="status" data-kind={kind} data-sev={kind === 'fail' ? 'critical' : 'none'}>
        <span className="status-mark" aria-hidden="true">
          {kind === 'ok' ? '✓' : kind === 'fail' ? 'C' : kind === 'running' ? '◴' : ''}
        </span>
      </span>
      <span className="n">{num(n)}</span>
      {label}
    </button>
  );
}

function titleForReason(reason: string): string {
  const r = humaniseReason(reason) ?? reason;
  if (r.includes('bench')) return 'Bench pool unavailable';
  if (r.includes('agent')) return 'Assay agent unavailable';
  if (r.includes('browser')) return 'Browser pool unavailable';
  return `Assays blocked — ${r}`;
}
