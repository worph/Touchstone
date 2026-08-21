/**
 * The public board — every app and the hallmark it currently carries.
 *
 * The Overview, with the operator taken out of it. Same rows, same cells, same tallies, from
 * `SubjectTable` — because the claim this page makes to an app author is that they are reading
 * the verdicts the operator reads, not a summary of them.
 *
 * What is deliberately gone:
 *
 * - **Every action.** No re-assay, no arming, nothing that posts. An author cannot ask for a
 *   re-run from here, and that is the intent: the loop decides what gets audited and when.
 * - **The live run overlay.** It comes from `/assays/current`, which is an operator endpoint
 *   this page must not touch, and "◴ running" is a fact about the machine rather than about
 *   the app. A run in flight simply shows the previous hallmark, which is what still stands.
 * - **The alert banner and the blocked backlog.** Both are environment conditions — the
 *   operator's problem, and noise to somebody who came to look up one app. The hatched cells
 *   and the footer say the part that matters: a blocked section is not a failing one.
 *
 * Filtering and sorting stay, in the URL as on the Overview, because a link to
 * `/public?show=failing` is a useful thing for an author to be sent.
 */
import { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { Leg } from '@shared/types';
import { StatusLegend } from '../components/StatusCell';
import SubjectTable, { SubjectSummary } from '../components/SubjectTable';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { getPublicSubjects } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import { num, plural } from '../lib/format';
import { applyShow, FRESH_DAYS, search, sortSubjects, tally } from '../lib/overview';
import type { ShowFilter, SortKey } from '../types';

/** No `running`: this page carries no live overlay, so the filter could only ever match none. */
const SHOW_OPTIONS: { value: ShowFilter; label: string }[] = [
  { value: 'all', label: 'all' },
  { value: 'failing', label: 'failing' },
  { value: 'compliant', label: 'compliant' },
  { value: 'blocked', label: 'blocked' },
  { value: 'not-run', label: 'not yet run' },
  { value: 'stale', label: `stale (≥ ${FRESH_DAYS}d)` },
];

export default function PublicBoard() {
  const { data, error, loading } = useAsync(getPublicSubjects, []);
  const [params, setParams] = useSearchParams();

  useEffect(() => {
    document.title = 'App conformance — Touchstone';
  }, []);

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

  const rows = useMemo(() => {
    const filtered = subjects.filter((s) => search(s, q) && applyShow(s, show, leg));
    return sortSubjects(filtered, sort, dir);
  }, [subjects, q, show, leg, sort, dir]);

  const showOrigin = useMemo(() => new Set(subjects.map((s) => s.origin)).size > 1, [subjects]);

  if (loading) return <div className="page page--wide"><Loading what="the board" /></div>;
  if (error) {
    return (
      <div className="page page--wide">
        <Notice tone="error" title="The board could not be loaded">
          {error.message}
        </Notice>
      </div>
    );
  }
  if (subjects.length === 0) {
    return (
      <div className="page page--wide">
        <EmptyState
          glyph="⬜"
          title="Nothing has been assayed yet"
          sub="No app in the configured stores carries a hallmark. There is nothing to publish until the first assay finishes."
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

      <div className="toolbar">
        <label>
          show
          <select className="control" value={show} onChange={(e) => set({ show: e.target.value })}>
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
            placeholder="app, image, ref…"
            value={q}
            onChange={(e) => set({ q: e.target.value })}
            aria-label="Search apps"
          />
        </span>

        <span className="spacer" />
        <span className="result-count">
          {rows.length === subjects.length
            ? plural(rows.length, 'app')
            : `${num(rows.length)} of ${num(subjects.length)} apps`}
        </span>
      </div>

      <div className="panel">
        {rows.length === 0 ? (
          <EmptyState
            glyph="⌕"
            title="Nothing matches"
            sub="No app satisfies this combination of filter and search."
          />
        ) : (
          <SubjectTable
            rows={rows}
            sort={sort}
            dir={dir}
            onSort={(k, d) => set({ sort: k, dir: d })}
            href={(s) => `/public/s/${encodeURIComponent(s.name)}`}
            showOrigin={showOrigin}
          />
        )}
        {/* The vocabulary, taught once. On the operator pages it is a reminder; here it is the
            first time most readers will have met `blocked`, and the difference between it and
            `failed` is the single thing this page most needs them to leave with. */}
        <StatusLegend kinds={['ok', 'fail', 'blocked', 'none']} />
      </div>
    </div>
  );
}
