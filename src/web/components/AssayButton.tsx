/**
 * `assay now` — the manual trigger, and the only control that takes the agent immediately.
 *
 * The other verb is `FlagControl`, which queues. Keeping the two apart in words as well as in
 * behaviour is the point of the 2026-08-31 rename: this was `re-assay` here, `audit` on the
 * Store table and `Run first assay` in an empty state, for one action, beside a flag that said
 * `flag for re-audit` in one place and `flag` in another. Two verbs, two words.
 *
 * Three things it has to get right, and each of them is why it is not a plain `onClick`:
 *
 * - **An audit takes five to ten minutes.** The request is not held open; the button starts
 *   a run and then watches. A spinner with no elapsed time reads as "hung" after ninety
 *   seconds, so it counts up.
 * - **Some sections need a bench.** The audit still starts without one — those sections are
 *   recorded blocked, which costs the app nothing — so the button says so rather than
 *   offering a choice nobody has to make. There is no depth to pick: a run is a run. It also
 *   says *when the bench comes back*, which is the half that was missing: a note that names
 *   only the fault leaves the operator with nothing to do and nothing to wait for.
 * - **One agent.** If a run is already going — a scheduled one, or someone else's — the
 *   button says which app has it rather than failing on submit.
 *
 * It used to own a poll of its own. It reads `data/runStatus.ts` now, along with the strip in
 * the shell and the card on Activity: four components polling the same endpoint on four
 * timers meant four slightly different ideas of what was happening. The bench pool followed it
 * there on 2026-08-23 — it had been a one-shot `getBenches()` on mount, which made this note a
 * snapshot from page load and, that day, one an operator acted on five minutes after it stopped
 * being true.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { startAssay } from '../data/client';
import { refreshRunStatus, useRunStatus } from '../data/runStatus';
import { useElapsed } from '../hooks/useElapsed';
import { describeLast, mmss } from '../lib/run';

interface Props {
  subject: string;
  onFinished: () => void;
  label?: string;
}

export default function AssayButton({ subject, onFinished, label = 'assay now' }: Props) {
  const status = useRunStatus();
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);

  // The pool comes off the shared poller rather than a fetch of our own. It used to be a
  // one-shot `getBenches()` on mount, so this note was a snapshot from page load — and on
  // 2026-08-23 an operator acted on one that had been false for five minutes. Undefined means
  // no prober is wired, which is not the same as a dead pool: say nothing rather than guess.
  const bench = status?.bench;
  const poolUp = bench ? bench.leasable > 0 : null;

  const ours = status?.running?.subject === subject;
  const running = Boolean(status?.running);
  const elapsed = useElapsed(status?.running?.started_at);

  // The moment a run of *ours* stops, pull the new report in.
  useEffect(() => {
    if (running && ours) wasRunning.current = true;
    if (!running && wasRunning.current) {
      wasRunning.current = false;
      onFinished();
    }
  }, [running, ours, onFinished]);

  const start = useCallback(
    async () => {
      setError(null);
      try {
        await startAssay(subject);
        // Poll at once rather than waiting out the interval: a four-second gap between the
        // click and the button changing reads as the click not having worked.
        await refreshRunStatus();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start the audit.');
      }
    },
    [subject],
  );

  if (status && !status.enabled) {
    return (
      <button className="btn" type="button" disabled title="The runner is off — set runner.enabled in config.yaml">
        {label} ▾
      </button>
    );
  }

  if (running) {
    // A clock, not a spinner: after ninety seconds a spinner reads as hung, and the elapsed
    // time is the difference between a wait and a black box.
    //
    // The fraction and the failing count used to be here too, and are not any more: the run
    // card is on the same page now, three lines below, saying both at the weight they
    // deserve. A control that restates the panel under it is a third place to keep in sync.
    return (
      <span className="reassay">
        <button className="btn" type="button" disabled>
          {ours ? `auditing… ${mmss(elapsed)}` : `busy — ${status?.running?.subject}`}
        </button>
      </span>
    );
  }

  const last = status?.last?.subject === subject ? status.last : null;

  return (
    <span className="reassay">
      <button
        className="btn"
        type="button"
        onClick={() => void start()}
        title={
          poolUp === false
            ? 'No demo bench is usable — the sections that need one will be recorded blocked, which does not count against the app'
            : undefined
        }
      >
        {label}
      </button>

      {error ? <span className="reassay-note reassay-note--bad">{error}</span> : null}
      {/* The condition *and* when it lifts. Naming only the fault is what left an operator
          with nowhere to go: the audit is still worth running, and the window says how long
          until the rest of it can be. */}
      {!error && poolUp === false ? (
        <span className="reassay-note">
          no bench — live sections will be recorded blocked
          {bench?.window ? ` · ${bench.window}` : ''}
        </span>
      ) : null}
      {!error && poolUp !== false && last ? (
        <span className="reassay-note">{describeLast(last)}</span>
      ) : null}
    </span>
  );
}
