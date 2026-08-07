/**
 * Findings — the cross-subject view, and the reason the findings table exists.
 *
 * `cpu_shares on reserved tier 10 → 5 subjects` is the acceptance test: a fact
 * that today lives as one sentence inside one report, surfaced here by query.
 *
 * Note on grouping: the contract types a group by `rule`, but `rule` is neither
 * unique nor always present — several findings carry `—`, and the same rule can
 * be `fail` for some subjects and `unverified` for others (E9 is exactly that).
 * So rows are keyed on `(rule, title, status)` and nothing here assumes one row
 * per rule code.
 */
import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import type { RuleGroup, Severity } from '@shared/types';
import { SEVERITY_RANK } from '@shared/types';
import { EmptyState, Loading, Notice, SeverityChip } from '../components/Ui';
import { getRuleGroups, getUnverified } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import { num, plural } from '../lib/format';
import { SEVERITY_LABEL } from '../lib/status';
import type { UnverifiedFinding } from '../types';

type Mode = 'grouped' | 'flat';
type Filter = 'all' | 'unverified' | 'one-liners';

const groupKey = (g: RuleGroup) => `${g.rule}|${g.title}|${g.status}`;

export default function Findings() {
  const [params, setParams] = useSearchParams();
  const mode = (params.get('mode') as Mode) ?? 'grouped';
  const filter = (params.get('filter') as Filter) ?? 'all';
  const q = params.get('q') ?? '';

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v == null || v === '' || v === 'all' || v === 'grouped') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <div className="toolbar" style={{ paddingTop: 4 }}>
        <h1 style={{ fontSize: 17, marginRight: 6 }}>Findings</h1>

        <div className="seg">
          <button type="button" aria-pressed={mode === 'grouped'} onClick={() => set({ mode: 'grouped' })}>
            grouped by rule
          </button>
          <button type="button" aria-pressed={mode === 'flat'} onClick={() => set({ mode: 'flat' })}>
            flat
          </button>
        </div>

        <div className="saved-filters">
          <button className="btn" type="button" aria-pressed={filter === 'all'} onClick={() => set({ filter: 'all' })}>
            everything
          </button>
          <button
            className="btn"
            type="button"
            aria-pressed={filter === 'unverified'}
            onClick={() => set({ filter: 'unverified' })}
            title="The suspected-Critical queue — what to drain the moment the bench pool comes back."
          >
            suspected Criticals
          </button>
          <button
            className="btn"
            type="button"
            aria-pressed={filter === 'one-liners'}
            onClick={() => set({ filter: 'one-liners' })}
            title="Minor findings — quick wins."
          >
            one-liners
          </button>
          <button
            className="btn"
            type="button"
            disabled
            title="Regressions need per-subject history joined across assays; that arrives with the Activity page in MVP-1."
          >
            regressions
          </button>
        </div>

        <span className="spacer" />
        <span className="search">
          <span className="glyph" aria-hidden="true">⌕</span>
          <input
            className="control"
            type="search"
            placeholder="rule, title, subject…"
            value={q}
            onChange={(e) => set({ q: e.target.value })}
            aria-label="Search findings"
          />
        </span>
      </div>

      {filter === 'unverified' ? (
        <UnverifiedQueue q={q} />
      ) : (
        <RuleTable mode={mode} filter={filter} q={q} />
      )}
    </div>
  );
}

// ------------------------------------------------------------- grouped/flat
function RuleTable({ mode, filter, q }: { mode: Mode; filter: Filter; q: string }) {
  const { data, error, loading } = useAsync(getRuleGroups, []);
  const [open, setOpen] = useState<Set<string>>(new Set());

  const groups = useMemo(() => {
    let g = data ?? [];
    if (filter === 'one-liners') {
      g = g.filter((x) => x.severity === 'minor' && x.status === 'fail');
    }
    if (q) {
      const needle = q.toLowerCase();
      g = g.filter(
        (x) =>
          x.rule.toLowerCase().includes(needle) ||
          x.title.toLowerCase().includes(needle) ||
          x.subjects.some((s) => s.toLowerCase().includes(needle)),
      );
    }
    return [...g].sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        b.risk - a.risk ||
        b.subjects.length - a.subjects.length ||
        a.title.localeCompare(b.title),
    );
  }, [data, filter, q]);

  const flat = useMemo(() => {
    if (mode !== 'flat') return [];
    const rows = groups.flatMap((g) => g.subjects.map((s) => ({ g, subject: s })));
    // severity first, then the group's risk — the backlog order the standard asks for
    return rows.sort(
      (a, b) =>
        SEVERITY_RANK[b.g.severity] - SEVERITY_RANK[a.g.severity] ||
        b.g.risk - a.g.risk ||
        a.subject.localeCompare(b.subject),
    );
  }, [groups, mode]);

  if (loading) return <Loading what="findings" />;
  if (error) return <Notice tone="error" title="Could not load findings">{error.message}</Notice>;
  if (groups.length === 0) {
    return (
      <div className="panel">
        <EmptyState
          glyph="✓"
          title={q ? 'Nothing matches' : 'No findings recorded'}
          sub={
            q
              ? 'No rule group matches that search.'
              : 'Every latest assay came back clean, or no assay has run yet.'
          }
        />
      </div>
    );
  }

  // Search implies you want to see which subjects matched.
  const expanded = (k: string) => open.has(k) || q.length > 0;
  const toggle = (k: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(k) ? next.delete(k) : next.add(k);
      return next;
    });

  if (mode === 'flat') {
    return (
      <>
        <div className="result-count" style={{ padding: '0 0 8px' }}>
          {plural(flat.length, 'finding')} across {plural(groups.length, 'rule')}
        </div>
        <div className="panel">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 56 }}>Rule</th>
                <th style={{ width: 180 }}>Subject</th>
                <th>Title</th>
                <th style={{ width: 110 }}>Severity</th>
                <th style={{ width: 90, textAlign: 'right' }}>Risk</th>
              </tr>
            </thead>
            <tbody>
              {flat.map(({ g, subject }) => (
                <tr key={`${groupKey(g)}|${subject}`}>
                  <td className="mono dim">{g.rule}</td>
                  <td>
                    <Link className="row-link" to={`/s/${encodeURIComponent(subject)}`}>{subject}</Link>
                  </td>
                  <td>{g.title}</td>
                  <td><SeverityChip severity={g.severity} status={g.status} /></td>
                  <td className="col-num">
                    <RiskCell severity={g.severity} status={g.status} perSubject />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="result-count" style={{ padding: '0 0 8px' }}>
        {plural(groups.length, 'rule group')}
        {' · '}
        {plural(groups.reduce((n, g) => n + g.subjects.length, 0), 'finding')}
      </div>
      <div className="panel">
        <div className="group-row" style={{ cursor: 'default', background: 'transparent' }} aria-hidden="true">
          <span className="section-title">Rule</span>
          <span className="section-title">Title</span>
          <span className="section-title g-sev" style={{ textAlign: 'left' }}>Severity</span>
          <span className="section-title g-count">Subjects</span>
          <span className="section-title g-risk">Risk</span>
          <span />
        </div>
        {groups.map((g) => {
          const k = groupKey(g);
          const isOpen = expanded(k);
          return (
            <div key={k}>
              <button
                type="button"
                className="group-row"
                aria-expanded={isOpen}
                onClick={() => toggle(k)}
              >
                <span className="g-rule">{g.rule}</span>
                <span className="g-title">{g.title}</span>
                <span className="g-sev"><SeverityChip severity={g.severity} status={g.status} /></span>
                <span className="g-count">{num(g.subjects.length)}</span>
                <span className="g-risk"><RiskCell severity={g.severity} status={g.status} risk={g.risk} /></span>
                <span className="g-chev" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
              </button>
              {isOpen ? (
                <div className="group-body">
                  <div className="subject-pills">
                    {[...g.subjects].sort().map((s) => (
                      <Link key={s} className="subject-pill" to={`/s/${encodeURIComponent(s)}`}>
                        {s}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
}

/**
 * Risk for an `unverified` group is parenthesised: it is potential, not counted.
 * Everything else in the app treats these two numbers as different quantities
 * and this is where that distinction is most likely to be misread.
 */
function RiskCell({
  severity, status, risk, perSubject,
}: {
  severity: Severity;
  status: string;
  risk?: number;
  perSubject?: boolean;
}) {
  const weight = { none: 0, minor: 1, major: 10, critical: 100 }[severity];
  const value = perSubject ? (status === 'pass' || status === 'n-a' ? 0 : weight) : (risk ?? 0);
  if (status === 'unverified') {
    return (
      <span className="risk-val" data-potential="true" title="Potential risk — suspected, not observed. Not counted in the total.">
        ({num(value)})
      </span>
    );
  }
  return (
    <span className="risk-val" data-zero={value === 0}>
      {num(value)}
    </span>
  );
}

// ------------------------------------------------------ suspected Criticals
function UnverifiedQueue({ q }: { q: string }) {
  const { data, error, loading } = useAsync(getUnverified, []);

  const rows = useMemo(() => {
    let r: UnverifiedFinding[] = data ?? [];
    if (q) {
      const needle = q.toLowerCase();
      r = r.filter(
        (f) =>
          (f.subject ?? '').toLowerCase().includes(needle) ||
          f.rule.toLowerCase().includes(needle) ||
          (f.title ?? '').toLowerCase().includes(needle),
      );
    }
    return [...r].sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        (a.subject ?? '').localeCompare(b.subject ?? ''),
    );
  }, [data, q]);

  if (loading) return <Loading what="the suspected-Critical queue" />;
  if (error) return <Notice tone="error" title="Could not load the queue">{error.message}</Notice>;

  const potential = rows.reduce(
    (n, f) => n + ({ none: 0, minor: 1, major: 10, critical: 100 }[f.severity] ?? 0),
    0,
  );

  if (rows.length === 0) {
    return (
      <div className="panel">
        <EmptyState
          glyph="✓"
          title="Nothing suspected"
          sub="No finding is waiting on a check that could not run. Either everything was observable, or nothing has been attempted."
        />
      </div>
    );
  }

  return (
    <>
      <Notice
        tone="info"
        glyph="?"
        title={
          <>
            {plural(rows.length, 'suspected finding')} · potential risk{' '}
            <span className="num" style={{ color: 'var(--unverified)' }}>({num(potential)})</span>
          </>
        }
      >
        Suspected but unproven — the check that would settle each of these is exactly the one that
        could not run. Parenthesised because it is potential, not counted: none of it appears in the
        total risk on the overview. This is the queue to drain the moment the bench pool is repaired.
      </Notice>

      <div className="panel" style={{ marginTop: 12 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 56 }}>Rule</th>
              <th style={{ width: 180 }}>Subject</th>
              <th>Suspicion</th>
              <th style={{ width: 130 }}>Severity</th>
              <th style={{ width: 90, textAlign: 'right' }}>Risk</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f, i) => (
              <tr key={`${f.subject ?? i}|${f.rule}|${i}`}>
                <td className="mono dim">{f.rule}</td>
                <td>
                  {f.subject ? (
                    <Link className="row-link" to={`/s/${encodeURIComponent(f.subject)}`}>{f.subject}</Link>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
                <td>
                  <div>{f.title ?? '(untitled)'}</div>
                  {f.note ? <div className="dim" style={{ fontSize: 11.5 }}>{f.note}</div> : null}
                </td>
                <td>
                  <SeverityChip
                    severity={f.severity}
                    status="unverified"
                    label={`${SEVERITY_LABEL[f.severity]} suspected`}
                  />
                </td>
                <td className="col-num">
                  <RiskCell severity={f.severity} status="unverified" perSubject />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
