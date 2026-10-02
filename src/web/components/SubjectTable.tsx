/**
 * The subject table and its summary — the two pieces the Overview and the public board share.
 *
 * They were one page's private components until the board existed. Two copies would have been
 * the easier change and the wrong one: the whole claim the board makes is that an app author
 * is reading *the same verdicts the operator reads*, and two tables that compose their own
 * cells are two tables that eventually disagree about what `blocked` looks like.
 *
 * What differs between the two callers is passed in and is deliberately small: where a row
 * leads, and whether there is a run in flight to overlay. Everything about how a state is
 * drawn stays here, once.
 */
import { Fragment, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { Section, SubjectState } from '@shared/types';
import StandardChip, { DelistedChip, VersionChip } from './StandardChip';
import StatusCell from './StatusCell';
import { ReadingBadge } from './Reading';
import { sectionLabel } from '../lib/format';
import { provisionalSections, readingOf, readingSections, verdictSectionsOf } from '../lib/reading';
import { legState, liveFor, type LegTally, type LiveRuns, type Tallies } from '../lib/overview';
import { ageLabel, num } from '../lib/format';
import type { LegFilter, ShowFilter, SortKey } from '../types';

export interface SubjectTableProps {
  rows: SubjectState[];
  sort: SortKey;
  dir: 'asc' | 'desc';
  onSort: (key: SortKey, dir: 'asc' | 'desc') => void;
  /** Where a row leads. The two callers publish different addresses for the same subject. */
  href: (s: SubjectState) => string;
  /** The audits in flight, overlaid at render time. The board has none and passes nothing. */
  live?: LiveRuns;
  /** A column that always reads the same word is furniture; only shown with two stores. */
  showOrigin: boolean;
  /**
   * What this caller lets you *do* to a row, if anything.
   *
   * A render prop rather than a boolean, and passed in rather than decided here, because the
   * public board shares this table and invariant 10 says nothing under `/public` may write.
   * A `canAudit` flag would put the control in the shared component and leave one prop
   * standing between an app author and a button that starts a run; omitting the prop leaves
   * the column out of the DOM entirely, so there is nothing to reach.
   */
  action?: (s: SubjectState) => ReactNode;
}

export default function SubjectTable({
  rows, sort, dir, onSort, href, live, showOrigin, action,
}: SubjectTableProps) {
  // Derived from what is in the archive rather than passed in: a section that measures gets
  // a column the moment one of its assays exists, and nothing here has to be told its name.
  const notices = readingSections(rows);
  // Derived exactly as the reading columns are, so a rubric audited on a second platform gets
  // its own column the moment it has been audited there — and none before. These were two
  // hard-coded headers until 2026-09-18; `hallmark.ts`'s `LEGS` says in as many words that it
  // "goes when the table learns to draw N".
  const verdicts = verdictSectionsOf(rows);
  // Said once on the header rather than on every cell: a platform measured before it judges is
  // a fact about the column, and seventy-nine repetitions of it would be wallpaper.
  const provisional = provisionalSections(rows);
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <Th label="Subject" k="name" sort={sort} dir={dir} onSort={onSort} />
            {verdicts.map((id) => (
              <Th
                key={id}
                label={sectionLabel(id)}
                note={provisional.has(id) ? 'measuring' : undefined}
                k={`section:${id}`}
                sort={sort}
                dir={dir}
                onSort={onSort}
              />
            ))}
            {notices.map((id) => (
              <Th key={id} label={sectionLabel(id)} k={`notice:${id}`} sort={sort} dir={dir} onSort={onSort} />
            ))}
            {/* No Risk and no Verified column since 2026-10: what a row has to say is compliant
                or not, per platform, and the verdict columns say it — the room goes to them.
                Risk is still the default sort (worst first); both figures are still in each
                report and on the subject page. */}
            <Th label="Last" k="age" sort={sort} dir={dir} onSort={onSort} align="right" />
            {action ? <th aria-label="audit" /> : null}
            <th aria-label="open" />
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <Row
              key={s.name}
              s={s}
              live={live}
              showOrigin={showOrigin}
              href={href}
              verdicts={verdicts}
              notices={notices}
              action={action}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({
  s, live, showOrigin, href, verdicts, notices, action,
}: {
  s: SubjectState;
  live: LiveRuns;
  showOrigin: boolean;
  href: (s: SubjectState) => string;
  verdicts: string[];
  notices: string[];
  action?: (s: SubjectState) => ReactNode;
}) {
  // Any of this row's legs being produced right now — on either platform.
  const liveIdx = verdicts.findIndex((id) => liveFor(s, id, live));
  const running = liveIdx >= 0;
  const to = href(s);
  return (
    <tr data-running={running || undefined} data-delisted={s.delisted || undefined}>
      <td>
        {/* Linked by key, rendered by label: `s.name` is `<origin>~<app>`, which is an
            address, not something to show a person. */}
        <Link className="row-link" to={to}>
          {s.label}
        </Link>
        {/* Only when there is more than one store. Two stores may legitimately ship the same
            app name — at which point the label alone stops identifying the row. */}
        {showOrigin ? <span className="tag store-tag">{s.origin}</span> : null}
        {/* First of the three: the other two qualify a verdict about an app you can still
            install, this one says you cannot. */}
        <DelistedChip delisted={s.delisted} />
        <StandardChip standard={s.standard} />
        <VersionChip version={s.subject_version} />
      </td>
      {/* The state comes from `legState`, not from the record, so a leg being audited right
          now says so in the same cell that will hold its verdict in four minutes. */}
      {verdicts.map((id, i) => (
        <td key={id}>
          {/* The elapsed-time note rides the first column only: it is one fact about the row. */}
          <StatusCell state={legState(s, id, live)} showNote={i === liveIdx} />
        </td>
      ))}
      {notices.map((id) => (
        <td key={id}><ReadingBadge reading={readingOf(s, id)} /></td>
      ))}
      <td className="col-num dim">{ageLabel(s.age_days)}</td>
      {action ? <td className="col-action">{action(s)}</td> : null}
      <td className="col-chev">
        <Link to={to} aria-label={`Open ${s.label}`}>›</Link>
      </td>
    </tr>
  );
}

function Th({
  label, note, k, sort, dir, onSort, align,
}: {
  label: string;
  /**
   * A word qualifying the whole column — `measuring` for a platform that does not yet judge.
   *
   * A word, not a colour: the three-channel rule this file's stylesheet states at the top means
   * a status is fill **and** glyph **and** word, never colour alone.
   */
  note?: string;
  k: SortKey;
  sort: SortKey;
  dir: 'asc' | 'desc';
  onSort: (key: SortKey, dir: 'asc' | 'desc') => void;
  align?: 'right';
}) {
  const active = sort === k;
  const nextDir = active && dir === 'desc' ? 'asc' : 'desc';
  return (
    <th
      style={align === 'right' ? { textAlign: 'right' } : undefined}
      aria-sort={active ? (dir === 'desc' ? 'descending' : 'ascending') : undefined}
    >
      <button type="button" onClick={() => onSort(k, nextDir)}>
        {label}
        {note ? <span className="tag col-note">{note}</span> : null}
        <span aria-hidden="true" style={{ opacity: active ? 1 : 0.25 }}>
          {active && dir === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

export interface SubjectSummaryProps {
  t: Tallies;
  show: ShowFilter;
  leg: LegFilter;
  onPick: (v: ShowFilter, l: LegFilter) => void;
}

/**
 * The counts, each one a filter. One row per column the table draws — derived from the same
 * list, so a rubric audited on a second platform is counted here the moment it is drawn there.
 */
export function SubjectSummary({ t, show, leg, onPick }: SubjectSummaryProps) {
  const legRow = (name: string, key: Section, v: LegTally) => (
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
        {t.sections.map((s) => (
          <Fragment key={s.id}>{legRow(sectionLabel(s.id), s.id, s.tally)}</Fragment>
        ))}
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
