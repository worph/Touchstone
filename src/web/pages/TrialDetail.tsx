/**
 * One trial — what this store would carry, beside what the app carries now.
 *
 * It has its own address rather than being a panel under the list, because the answer is
 * about a *branch*: it gets pasted into the PR, opened again after a reload, and read by
 * somebody who was sent the link rather than somebody who just started the run.
 *
 * The page is the subject page's furniture — section cards, requirement list, report viewer,
 * the standard that judged it — around the one panel that is this page's alone: **the
 * comparison**. That order is deliberate. A verdict on a branch means little on its own; it
 * means something against the verdict it would replace.
 *
 * ## Why the comparison draws its cells the way the Store page does
 *
 * It used to draw them as `.tag` chips — the metadata pill that means `commit a1b2c3` or
 * `needs a bench` everywhere else in the app. Two things were wrong with that.
 *
 * The first is that the **"Currently" column quotes a hallmark**. Rendering it in a notation
 * the archive never uses is the failure `SubjectTable` exists to prevent, one file further
 * along: two ways of drawing `blocked` are two things that eventually disagree about what
 * `blocked` means. The second is that a chip has one channel — text — where `StatusCell` has
 * four, and the distinction it protects (checked-and-failed versus could-not-check) is exactly
 * the one a trial reader is making.
 *
 * The framing stays distinct instead, which is where it belongs and where it works: the header
 * says a trial moves nothing, and the third column is labelled `Currently`.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import type { TrialComparison, TrialRecord } from '@shared/trials';
import type { Section } from '@shared/types';
import { subjectName } from '@shared/subject';
import LegCard, { StandardTag, verdictSections } from '../components/LegCard';
import MarkdownView, { MissingReport } from '../components/MarkdownView';
import { ReadingPanel } from '../components/Reading';
import { RequirementsPanel } from '../components/RequirementList';
import StatusCell, { StatusLegend } from '../components/StatusCell';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { deleteTrial, getTrial, getTrialReport } from '../data/client';
import { useRunStatus } from '../data/runStatus';
import { useAsync } from '../hooks/useAsync';
import { download } from '../lib/download';
import { num, since, stamp } from '../lib/format';
import { readingOf, readingSections } from '../lib/reading';
import { liveLegs, progressLabel } from '../lib/run';
import { displayFacts } from '../lib/status';

/**
 * The one blocked reason that is a question for the operator rather than a passing condition.
 *
 * `domain/assay.ts` writes a distinct sentence for each of the four ways a section can block.
 * Three of them — no bench free, no browser answering, the store unreadable — say themselves in
 * the cell's own note and clear on their own. This one never clears: it is a setting nobody has
 * filled in, so it earns the sentence under the row.
 *
 * It is keyed on the reason rather than on "a non-static section is blocked", which is what it
 * used to be. That predicate was true of all four, so a dead browser sidecar was told to go set
 * a config key that was already correct.
 */
const STORE_URL_UNCONFIGURED = 'store_url_unconfigured';

/** One section, the trial's result beside what the subject carries today. */
function ComparisonRow({ row }: { row: TrialComparison }) {
  const unconfigured = row.trial?.status === 'blocked' && row.trial.blocked_reason === STORE_URL_UNCONFIGURED;
  return (
    <tr>
      <td className="trial-section">{row.section}</td>
      <td>
        <StatusCell state={displayFacts(row.trial)} />
        {unconfigured ? (
          <div className="trial-why">
            Not a fault, and not a limit of trials. A demo instance fetches the store over the
            public internet, and this Touchstone has no external address configured — set{' '}
            <code>trials.public_base_url</code> and this section runs.
          </div>
        ) : null}
      </td>
      <td>
        {row.current ? <StatusCell state={displayFacts(row.current)} /> : <span className="dim">—</span>}
      </td>
    </tr>
  );
}

/** Where the archive came from. An upload never had a URL to record. */
function sourceOf(t: TrialRecord): string {
  return t.upload_id ? `upload ${t.upload_id}` : t.source_url;
}

export default function TrialDetail() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const status = useRunStatus();
  const detail = useAsync(() => getTrial(slug), [slug]);
  const [selectedSection, setSelectedSection] = useState<Section | null>(null);
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    setSelectedSection(null);
    setView('rendered');
  }, [slug]);

  const state = detail.data?.state;

  /** Which sections have a report to read, and which one is open. */
  const reported: Section[] = useMemo(
    () => Object.entries(state?.sections ?? {}).filter(([, rec]) => rec).map(([id]) => id),
    [state],
  );
  const currentSection = (selectedSection && reported.includes(selectedSection) ? selectedSection : reported[0]) ?? null;
  const currentRec = currentSection ? (state?.sections?.[currentSection] ?? null) : null;
  const currentFile = currentRec?.file ?? null;

  const report = useAsync(
    () => (currentFile ? getTrialReport(slug, currentFile) : Promise.resolve(null)),
    [slug, currentFile],
  );

  if (detail.loading) return <div className="page"><Loading what="the trial" /></div>;
  if (detail.error || !detail.data || !state) {
    return (
      <div className="page">
        <Notice tone="warn" title="The trial could not be read">
          {detail.error?.message ?? 'It is not in the list.'} <Link to="/trials">Back to trials</Link>.
        </Notice>
      </div>
    );
  }

  const { trial: t, comparison } = detail.data;
  const never = reported.length === 0;

  /** The run in flight, when it is this trial's — its key is `<slug>~<subject>`. */
  const running = status?.running?.subject === state.name ? status.running : null;
  const live = running
    ? {
        legs: liveLegs(running),
        started_at: running.started_at,
        ...(progressLabel(status?.progress) ? { note: progressLabel(status?.progress) } : {}),
      }
    : null;

  const remove = () => {
    setRemoving(true);
    void deleteTrial(slug)
      .then(() => navigate('/trials'))
      .finally(() => setRemoving(false));
  };

  return (
    <div className="page page--wide">
      <div className="panel">
        <div className="subject-head">
          <div className="subject-head-top">
            <h1 className="subject-title">
              <Link to="/trials" className="back-link" aria-label="Back to trials">‹</Link>
              {t.subject}
            </h1>
            <div style={{ flex: 1 }} />
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>
                {never ? '—' : num(state.risk)}
              </div>
              <div className="section-title">risk</div>
            </div>
            <button className="btn" type="button" disabled={removing} onClick={remove}>
              {removing ? 'Removing…' : 'Remove trial'}
            </button>
          </div>

          <div className="subject-refs">
            <div className="ref-line">
              {t.apps_path}/{t.subject} <span className="dim">from {sourceOf(t)}</span>
            </div>
            <div className="ref-line">
              <span className="tag">judged against {t.repo}</span>
              {/* What the trial is *about*, and the honest answer when it is about nothing
                  the store has yet — which is a normal PR, not a defect. */}
              {t.compare_to ? (
                <Link className="tag tag--link" to={`/s/${encodeURIComponent(t.compare_to)}`}>
                  compared against {subjectName(t.compare_to)}
                </Link>
              ) : (
                <span className="tag">new app · nothing to compare</span>
              )}
              {currentRec ? <StandardTag meta={currentRec.meta} section={currentRec.meta.section} /> : null}
              {/* `since` already ends in "ago" — the panel this replaced said "1h ago ago". */}
              <span className="tag">
                {t.finished_at ? `finished ${since(t.finished_at)}` : 'running'}
              </span>
            </div>
          </div>
        </div>

        {/* One card per section this trial produced, plus any the run in flight is adding. */}
        <div className="legs">
          {verdictSections(state, live).map((id) => (
            <LegCard
              key={id}
              leg={id}
              rec={state.sections?.[id] ?? null}
              live={live}
              neverNote="this trial produced nothing for this section"
            />
          ))}
        </div>
      </div>

      {t.error ? <Notice tone="warn" title="This trial did not complete">{t.error}</Notice> : null}

      {/*
        The panel this page exists for, and the reason it is not simply the subject page with a
        different data source: the third column quotes a hallmark this run cannot move.

        The legend belongs here rather than under the list: this is the table where the
        vocabulary does real work, because `blocked` and a failing verdict sit one column
        apart and mean opposite things about the app.
      */}
      <section className="panel" style={{ marginTop: 14 }}>
        <div className="pane-head">
          <span className="section-title">this store, against what the app carries now</span>
        </div>
        <div className="tbl-wrap">
          <table className="tbl trial-table">
            <thead>
              <tr>
                <th>Section</th>
                <th>This store</th>
                <th>Currently</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((row) => (
                <ComparisonRow key={row.section} row={row} />
              ))}
            </tbody>
          </table>
        </div>
        <StatusLegend />
      </section>

      {/* Every reading this trial took — one panel each, above the report for the same reason
          the subject page puts them there: they are the cheapest thing on the page to act on. */}
      {readingSections([state]).map((id) => {
        const reading = readingOf(state, id);
        return reading ? <div style={{ marginTop: 14 }} key={id}><ReadingPanel reading={reading} /></div> : null;
      })}

      {/* What was actually checked, for the section open below. */}
      <RequirementsPanel rec={currentRec} />

      {never ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <EmptyState
            glyph={live ? '◴' : '⬜'}
            title={live ? 'This trial is running' : 'This trial produced no report'}
            sub={
              live
                ? 'There is nothing to read yet. The report is written when the run finishes, and this page picks it up on reload.'
                : 'It ended before any section was written down. Nothing here is a statement about the app.'
            }
          />
        </div>
      ) : (
        <section className="panel pane" style={{ marginTop: 14 }}>
          <div className="pane-head">
            <span className="section-title">report</span>
            {currentRec ? (
              <span className="dim" style={{ fontSize: 11.5 }}>
                {currentRec.meta.section} · {stamp(currentRec.meta.started_at)}
              </span>
            ) : null}
            <span style={{ flex: 1 }} />

            {reported.length > 1 ? (
              <div className="seg">
                {reported.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={currentSection === id}
                    onClick={() => setSelectedSection(id)}
                  >
                    {id}
                  </button>
                ))}
              </div>
            ) : null}

            <div className="seg">
              <button type="button" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>
                rendered
              </button>
              <button type="button" aria-pressed={view === 'raw'} onClick={() => setView('raw')}>
                raw
              </button>
            </div>

            <button
              className="btn"
              type="button"
              disabled={!report.data?.raw}
              onClick={() => report.data && download(currentFile ?? 'report.md', report.data.raw)}
            >
              download
            </button>
          </div>

          {report.loading ? (
            <div className="pane-body"><Loading what="report" /></div>
          ) : report.error ? (
            <div className="pane-body">
              <MissingReport path={currentRec?.path ?? `${slug}/${currentFile ?? '?'}`} />
            </div>
          ) : (
            <MarkdownView html={report.data?.html} raw={report.data?.raw} view={view} />
          )}
        </section>
      )}
    </div>
  );
}
