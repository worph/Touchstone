/**
 * `Audit` — the one verb, on every surface that offers it.
 *
 * There were two controls here until 2026-09-01 and they were the last of five spellings for
 * what an operator experiences as one intention. `AssayButton` said `assay now` / `re-assay` /
 * `first assay` and took the single agent immediately, failing outright whenever anything else
 * held it; `FlagControl` said `flag for re-audit` / `flag` and queued. Two verbs was already
 * the second attempt at a vocabulary — and it was still wrong, because *the difference was
 * never the operator's to make*. Whether an audit starts now or waits is a fact about the line,
 * not a choice at the point of pressing, and the control that always worked was the one that
 * looked like it did nothing.
 *
 * So: one button, one word, three states.
 *
 * - **`Audit`** — press it. The request goes in the queue and the tick decides; on an idle box
 *   that means it starts within the second, which is why the label does not promise either.
 * - **`queued · N`** — it is in the line, at that place, and pressing again withdraws it.
 *   Pressing `Audit` twice must never be two requests, and the row has to say so, or the
 *   operator presses it a third time.
 * - **`auditing… mm:ss`** — a clock, not a spinner. After ninety seconds a spinner reads as
 *   hung, and the elapsed time is the difference between a wait and a black box.
 *
 * The *result* is what has to be unmistakable, since the label no longer forecasts it: the row
 * flips the instant the write returns, from the shared poller rather than from a fetch of its
 * own. Four components polling `/assays/current` on four timers meant four slightly different
 * ideas of what was happening.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { ScheduleResponse } from '@shared/schedule';
import { flagSubject, getSchedule, startAssay } from '../data/client';
import { refreshRunStatus, useRunStatus } from '../data/runStatus';
import { useElapsed } from '../hooks/useElapsed';
import { describeLast, mmss } from '../lib/run';

interface Props {
  /** The subject key — `<origin>~<name>`, never the bare label. */
  subject: string;
  /**
   * Whether a request for this app is currently counting, and where it sits.
   *
   * `undefined` means the server sent no queue state at all — no scheduler is wired — and the
   * control renders nothing rather than offering a button that cannot work. That is not the
   * same as "not queued".
   */
  queued: boolean | undefined;
  /** Its 1-based place in the line, when it is in one. */
  position?: number;
  /**
   * Handed whatever the write returned, so a caller rendering the queue can repaint every
   * position in one go rather than fetching again.
   */
  onChanged: (schedule?: ScheduleResponse) => void;
  /** `row` is the control inside a table; `page` is the labelled button beside a heading. */
  variant?: 'row' | 'page';
  /** The app's display name, for the row variant's accessible label. */
  label?: string;
}

export default function AuditControl({
  subject,
  queued,
  position,
  onChanged,
  variant = 'page',
  label,
}: Props) {
  const status = useRunStatus();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const bench = status?.bench;
  const poolUp = bench ? bench.leasable > 0 : null;
  const ours = status?.running?.subject === subject;
  const elapsed = useElapsed(status?.running?.started_at);

  // The moment a run of *ours* stops, pull the new report in.
  useEffect(() => {
    if (status?.running && ours) wasRunning.current = true;
    if (!status?.running && wasRunning.current) {
      wasRunning.current = false;
      onChanged();
    }
  }, [status?.running, ours, onChanged]);

  const press = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (queued) {
        // Withdrawing is the same write the server has always had for dropping a request.
        onChanged(await flagSubject(subject, false));
      } else {
        await startAssay(subject);
        // **Both branches hand back a schedule**, and the asymmetry that used to be here was a
        // bug you could see: `POST /assays` answers with a placement rather than the whole
        // schedule, so the enqueue branch called `onChanged()` empty — and the Store page,
        // whose schedule is fetched once on mount, went on drawing `Audit` on a row the server
        // had already queued. The press appeared to do nothing, which is the exact failure this
        // control was built to end.
        onChanged(await getSchedule());
      }
      // Do not wait for the next poll tick: the whole design rests on the row changing the
      // instant the press lands, because the label no longer says which way it will go.
      await refreshRunStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not queue that audit.');
    } finally {
      setBusy(false);
    }
  }, [subject, queued, onChanged]);

  if (queued === undefined) return null;

  const off = Boolean(status && !status.enabled);
  const word = ours ? `auditing… ${mmss(elapsed)}` : queued ? 'queued' : 'Audit';
  const title = off
    ? 'The runner is off — set runner.enabled in config.yaml'
    : ours
      ? 'This app is being audited now.'
      : queued
        ? 'This app is in the queue. Press again to withdraw the request.'
        : 'Audit this app. It starts as soon as the agent is free — immediately if nothing is waiting.';

  if (variant === 'row') {
    return (
      <span className="row-audit">
        <button
          className={`btn btn--sm row-audit__btn${queued ? ' row-audit__btn--on' : ''}`}
          type="button"
          disabled={busy || off || ours}
          onClick={() => void press()}
          aria-pressed={queued}
          aria-label={`${queued ? 'Withdraw the audit request for' : 'Audit'} ${label ?? subject}`}
          title={error ?? title}
        >
          {ours ? '◴' : queued ? `⏳${position ? ` ${position}` : ''}` : 'Audit'}
        </button>
        {error ? <span className="row-action__err" role="alert">!</span> : null}
      </span>
    );
  }

  const last = status?.last?.subject === subject ? status.last : null;

  return (
    <span className="reassay">
      <button
        className={`btn${queued ? ' auditbtn--on' : ''}`}
        type="button"
        disabled={busy || off || ours}
        onClick={() => void press()}
        aria-pressed={queued}
        title={error ?? title}
      >
        {word}
        {queued && position ? ` · ${position}` : ''}
      </button>

      {error ? <span className="reassay-note reassay-note--bad">{error}</span> : null}
      {/* The condition *and* when it lifts. Naming only the fault leaves an operator with
          nowhere to go and nothing to wait for. Since the queue, a dead pool no longer
          degrades a run — it holds the line — so the note says that instead. */}
      {!error && poolUp === false ? (
        <span className="reassay-note">
          no usable bench — the queue waits rather than auditing half the rubric
          {bench?.window ? ` · ${bench.window}` : ''}
        </span>
      ) : null}
      {!error && poolUp !== false && !queued && last ? (
        <span className="reassay-note">{describeLast(last)}</span>
      ) : null}
    </span>
  );
}
