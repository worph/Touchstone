/**
 * The audit in flight, in full, for the page you open to ask what is happening.
 *
 * Activity's three blocks answer "what is wrong", "what is it running on" and "what
 * happened" — and until now nothing answered "what is happening *now*". The log could not:
 * a run writes `ASSAY_STARTED`, then settles requirements for six to ten minutes without an
 * event, then writes `ASSAY_COMPLETED`. Read literally, the page said nothing was going on.
 *
 * It is arranged as one hierarchy rather than five stacked blocks, because five blocks left
 * the reader with three time bases to reconcile and a merged fraction that was true of no
 * section. Top to bottom: the run, the one failure worth acting on, a row per section with
 * its own denominator and its own phase track, the feed of what has settled, and — last,
 * where a diagnostic belongs — where it is running.
 *
 * It renders in two places off the same poll: here on Activity, and on the subject's own
 * page, which is where the strip in the shell points.
 */

import { subjectName } from '@shared/subject';
import { Link } from 'react-router-dom';

import { useRunStatus } from '../data/runStatus';
import { useElapsed } from '../hooks/useElapsed';
import {
  describeLast,
  headlineFailure,
  mmss,
  progressLabel,
  progressRatio,
  sectionRows,
  type PhaseStep,
  type SectionRow,
} from '../lib/run';
import { since, stamp } from '../lib/format';

export interface RunCardProps {
  /**
   * Draw only when the run is this subject's; draw nothing otherwise.
   *
   * The subject page passes its own name. Without it the card is the operations view and
   * shows whatever is running.
   */
  subject?: string;
  /** The subject's own page already has its name in a heading, twice over. */
  showSubject?: boolean;
  /** Activity says what the *last* run did when nothing is running. A subject page does not. */
  showIdle?: boolean;
  heading?: string;
}

export default function RunCard({
  subject,
  showSubject = true,
  showIdle = true,
  heading = 'Running now',
}: RunCardProps = {}) {
  const status = useRunStatus();
  const all = status?.running ?? null;
  const live = all && (!subject || all.subject === subject) ? all : null;
  const seconds = useElapsed(live?.started_at);

  // Nothing running: say what the last one did rather than nothing at all. An empty block
  // and a broken block look the same, and this page's job is to be readable when things are
  // broken. On a subject page there is a whole report below saying it, so it draws nothing.
  if (!live) {
    if (!showIdle) return null;
    const last = status?.last ?? null;
    return (
      <section className="act-section">
        <h2 className="act-h">{heading}</h2>
        <div className="act-quiet">
          No audit is running.
          {status && !status.enabled ? (
            <> The runner is switched off — set <code>runner.enabled</code> in <code>data/config.yaml</code>.</>
          ) : null}
          {last ? (
            <>
              {' '}
              <Link to={`/s/${encodeURIComponent(last.subject)}`}>{subjectName(last.subject)}</Link> finished{' '}
              {since(last.finished_at)} — {describeLast(last).replace(/^last run: /, '')}.
            </>
          ) : null}
        </div>
      </section>
    );
  }

  const progress = status?.progress ?? null;
  const counted = progressLabel(progress);
  const rows = sectionRows(progress);
  const failure = headlineFailure(progress);
  const sections = live.sections ?? [];
  const blocked = live.blocked ?? [];

  return (
    <section className="act-section">
      <h2 className="act-h">
        {heading}
        <span className="act-count" aria-hidden="true">◴</span>
      </h2>

      <div className="run-card">
        <div className="run-card__head">
          {showSubject ? (
            <Link className="run-card__subject" to={`/s/${encodeURIComponent(live.subject)}`}>
              {subjectName(live.subject)}
            </Link>
          ) : null}
          <span className="run-card__depth">
            {sections.length > 0 ? sections.join(' + ') : 'choosing sections…'}
          </span>
          <span className="spacer" />
          <span className="run-card__counted">
            {counted ? (
              <>
                <span className="num">{counted.replace('/', ' of ')}</span> settled
              </>
            ) : (
              'waiting for the agent to report its first requirement…'
            )}
          </span>
          <span className="run-card__clock num" title={`started ${stamp(live.started_at)}`}>
            {mmss(seconds)}
          </span>
        </div>

        {/* A skipped section is not a failure: the rest of the audit is running, and the
            section that could not be attempted is *recorded* blocked — a statement about the
            environment, not about the app. */}
        {blocked.length > 0 ? (
          <div className="run-card__degraded">
            Not running {blocked.map((b) => b.section).join(', ')} —{' '}
            {blocked[0]!.reason.replace(/_/g, ' ')}. {blocked.length > 1 ? 'Those sections' : 'That section'}{' '}
            will be recorded blocked, and no retry budget is spent on {blocked.length > 1 ? 'them' : 'it'}.
          </div>
        ) : null}

        {/* The one thing on the card anyone has to act on, at the weight that deserves. As a
            clause inside the count it was the smallest word here, and the row itself was one
            of five in a list. */}
        {failure ? (
          <div className="run-card__headline">
            <span className="run-card__headline-mark" aria-hidden="true">✗</span>
            <span className="run-card__req mono">{failure.id}</span>
            {failure.severity && failure.severity !== 'none' ? (
              <span className="run-card__sev">{failure.severity}</span>
            ) : null}
            <span className="spacer" />
            <span className="run-card__at dim">{since(failure.at)}</span>
          </div>
        ) : null}

        {/* One row per section, each counted against its own list. A single fraction over
            both is true of neither: `static` is nearly done while `functional` has not
            started, and one bar cannot say that. */}
        {rows.length > 0 ? (
          <div className="run-sections">
            {rows.map((row) => (
              <SectionRowView key={row.id} row={row} />
            ))}
          </div>
        ) : (
          // Before the run has probed its sections there is nothing to split, so the run's
          // own bar stands in rather than the card showing no progress at all.
          <div className="run-card__bar">
            {progressRatio(progress) !== null ? (
              <span className="run-bar" aria-hidden="true">
                <span
                  className="run-bar__fill"
                  style={{ inlineSize: `${Math.round(progressRatio(progress)! * 100)}%` }}
                />
              </span>
            ) : null}
          </div>
        )}

        {progress && progress.recent.length > 0 ? (
          <ul className="run-card__recent">
            {progress.recent.map((r) => (
              <li key={`${r.id}-${r.at}`} data-verdict={r.verdict}>
                <span className="run-card__at dim num">{since(r.at)}</span>
                <span className="run-card__req mono">{r.id}</span>
                <span className="run-card__verdict">{r.verdict}</span>
                {r.severity && r.severity !== 'none' ? (
                  <span className="run-card__sev">{r.severity}</span>
                ) : null}
                {/* Only when there is more than one section to belong to. */}
                {sections.length > 1 && r.section ? (
                  <span className="run-card__owner dim">{r.section}</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {/* Where it is running. Last, and in one line: it is only interesting when something
            looks wrong, and between the progress and the feed it split the two things that
            are actually moving. Hostnames, because the rest of a URL is noise — the whole of
            it is on the title. */}
        <div className="run-card__where">
          started <span className="num">{stamp(live.started_at)}</span>
          {live.bench ? (
            <> · bench <span className="mono" title={live.bench}>{shortUrl(live.bench)}</span></>
          ) : null}
          {live.browser ? (
            <> · browser <span className="mono" title={live.browser}>{shortUrl(live.browser)}</span></>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** One section: its name, its own fraction, and — under it — the plan it owns. */
function SectionRowView({ row }: { row: SectionRow }) {
  // The step it is on: the first the section has not recorded. Null once the plan is done.
  const current = row.track.find((p) => !p.result) ?? null;
  return (
    <div className="run-section">
      <div className="run-section__line">
        <span className="run-section__name">{row.id}</span>
        {row.ratio !== null ? (
          <span className="run-bar" aria-hidden="true">
            <span className="run-bar__fill" style={{ inlineSize: `${Math.round(row.ratio * 100)}%` }} />
          </span>
        ) : (
          <span className="run-bar run-bar--empty" aria-hidden="true" />
        )}
        <span className="run-section__count">
          {row.of_canonical > 0 ? (
            <>
              <span className="num">{row.verified}</span> of <span className="num">{row.of_canonical}</span>
            </>
          ) : (
            'no requirements listed'
          )}
          {row.failed > 0 ? <> · <span className="run-card__failing">{row.failed} failing</span></> : null}
        </span>
      </div>

      {/* The plan, indented under the section that owns it. The unreached steps are the
          point — a track that shows only what happened cannot show what is left — but they
          carry their id alone, and only the step in hand is spelled out. Eight labelled
          pills wrapped over three lines and read as a wall. */}
      {row.track.length > 0 ? (
        <ol className="phase-track" aria-label={`${row.id} phases`}>
          {row.track.map((p) => (
            <PhasePill key={p.id} step={p} current={p.id === current?.id} section={row.id} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function PhasePill({ step, current, section }: { step: PhaseStep; current: boolean; section: string }) {
  const spelled = current || Boolean(step.result);
  return (
    <li
      className="phase"
      data-result={step.result ?? 'pending'}
      data-current={current || undefined}
      title={
        step.result
          ? `${section} · phase ${step.id} — ${step.label}: ${step.result}`
          : `${section} · phase ${step.id} — ${step.label}: not reached yet`
      }
    >
      <span className="phase__id num">{step.id}</span>
      {spelled ? <span className="phase__label">{step.label}</span> : null}
    </li>
  );
}

/** `https://demostaging1.inojob.com/` → `demostaging1.inojob.com`. The full one is the title. */
function shortUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
