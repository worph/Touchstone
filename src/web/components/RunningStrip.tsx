/**
 * "Something is running, and here is what it is."
 *
 * The gap this closes: an audit takes five to ten minutes, and until now the only place that
 * said so was the re-assay button on the subject's own page. Start one from the administrator
 * chat and every other screen — the Overview you land on, the Activity page you open to check
 * — was indistinguishable from an idle app.
 *
 * So it lives in the shell, on every page, and it is **absent when nothing is running**: a
 * permanent bar that usually says "idle" is furniture people stop seeing, and then the one
 * time it matters they do not see it either.
 */

import { subjectName } from '@shared/subject';
import { Link } from 'react-router-dom';

import { useRunStatus } from '../data/runStatus';
import { useElapsed } from '../hooks/useElapsed';
import { documentTitle, mmss, nowDoing, progressLabel, progressRatio } from '../lib/run';
import { useEffect } from 'react';

export default function RunningStrip({ variant = 'full' }: { variant?: 'full' | 'compact' }) {
  const status = useRunStatus();
  const live = status?.running ?? null;
  const seconds = useElapsed(live?.started_at);
  /**
   * How many requests are behind this one.
   *
   * The strip is on every page, so this is the ambient answer to "what is after this" — the
   * one question the run in flight cannot answer about itself, and the one that used to need
   * a trip to Automation to find out.
   */
  const waiting = Math.max(0, (status?.queued ?? 0) - 1);

  if (!live) return null;

  const progress = status?.progress ?? null;
  const counted = progressLabel(progress);
  const ratio = progressRatio(progress);
  const doing = nowDoing(progress);
  const clock = mmss(seconds);
  const sections = live.sections ?? [];

  const label =
    `Auditing ${subjectName(live.subject)}${sections.length > 0 ? `, ${sections.join(' and ')}` : ''}, running ${clock}` +
    (counted ? `, ${counted} requirements settled` : '');

  if (variant === 'compact') {
    return (
      <Link className="run-strip run-strip--compact" to={`/s/${encodeURIComponent(live.subject)}`} aria-label={label}>
        <span className="run-strip__mark" aria-hidden="true">◴</span>
        <span className="run-strip__name">{subjectName(live.subject)}</span>
        <span className="run-strip__clock num">{clock}</span>
        {waiting > 0 ? <span className="run-strip__queued num">+{waiting}</span> : null}
      </Link>
    );
  }

  return (
    <Link className="run-strip" to={`/s/${encodeURIComponent(live.subject)}`} aria-label={label}>
      <span className="run-strip__head">
        <span className="run-strip__mark" aria-hidden="true">◴</span>
        <span className="run-strip__name">{subjectName(live.subject)}</span>
        <span className="run-strip__clock num">{clock}</span>
      </span>

      <span className="run-strip__meta">
        {sections.length > 0 ? sections.join(' + ') : '…'}
        {counted ? <> · <span className="num">{counted}</span> settled</> : null}
      </span>

      {/* The bar is the secondary channel: the fraction beside it carries the same fact in
          words, so a run reads the same in greyscale as in colour. */}
      {ratio !== null ? (
        <span className="run-bar" aria-hidden="true">
          <span className="run-bar__fill" style={{ inlineSize: `${Math.round(ratio * 100)}%` }} />
        </span>
      ) : null}

      {/* What it settled last. The difference between a slow run and a stuck one. */}
      <span className="run-strip__doing">{doing ?? 'waiting for the agent…'}</span>

      {/* Degrading is not a failure and must not read as one — the static half is still
          being run, and the functional half will be recorded blocked. */}
      {live.degraded_reason ? (
        <span className="run-strip__degraded">
          functional half has no bench ({live.degraded_reason.replace(/_/g, ' ')})
        </span>
      ) : null}
    </Link>
  );
}

/**
 * The tab title while an audit runs. Renders nothing.
 *
 * This is the indicator for the case the feature exists for — you asked for a review and went
 * to do something else — because a background tab shows no strip, no page and no badge. It is
 * a component rather than a hook in the shell so that the once-a-second clock re-renders this
 * and nothing else.
 */
export function RunTitle() {
  const status = useRunStatus();
  const live = status?.running ?? null;
  const seconds = useElapsed(live?.started_at);

  useEffect(() => {
    document.title = documentTitle(live, status?.progress ?? null);
    // The clock is in the title, so the tick is a dependency even though it is not read here.
  }, [live, status?.progress, seconds]);

  useEffect(() => () => {
    document.title = 'Touchstone';
  }, []);

  return null;
}
