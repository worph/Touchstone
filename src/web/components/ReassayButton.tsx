/**
 * The manual trigger — n8n's `Audit an app` form, as a button.
 *
 * Three things it has to get right, and each of them is why it is not a plain `onClick`:
 *
 * - **An audit takes five to ten minutes.** The request is not held open; the button starts
 *   a run and then watches. A spinner with no elapsed time reads as "hung" after ninety
 *   seconds, so it counts up.
 * - **Some sections need a bench.** The audit still starts without one — those sections are
 *   recorded blocked, which costs the app nothing — so the button says so rather than
 *   offering a choice nobody has to make. There is no depth to pick: a run is a run.
 * - **One agent.** If a run is already going — a scheduled one, or someone else's — the
 *   button says which app has it rather than failing on submit.
 *
 * It used to own a poll of its own. It reads `data/runStatus.ts` now, along with the strip in
 * the shell and the card on Activity: four components polling the same endpoint on four
 * timers meant four slightly different ideas of what was happening.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getBenches, startAssay } from '../data/client';
import { refreshRunStatus, useRunStatus } from '../data/runStatus';
import { useElapsed } from '../hooks/useElapsed';
import { describeLast, mmss, progressLabel } from '../lib/run';

interface Props {
  subject: string;
  onFinished: () => void;
  label?: string;
}

export default function ReassayButton({ subject, onFinished, label = 're-assay' }: Props) {
  const status = useRunStatus();
  const [poolUp, setPoolUp] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wasRunning = useRef(false);

  const ours = status?.running?.subject === subject;
  const running = Boolean(status?.running);
  const elapsed = useElapsed(status?.running?.started_at);

  useEffect(() => {
    void getBenches()
      .then((b) => setPoolUp(b.leasable > 0))
      .catch(() => setPoolUp(null));
  }, []);

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
    // Progress, not a spinner. The agent records each requirement as it settles it, so there
    // is something true to show — and "7/16 · 3:20" is the difference between a wait and a
    // black box.
    const p = status?.progress ?? null;
    const done = progressLabel(p);
    return (
      <span className="reassay">
        <button className="btn" type="button" disabled>
          {ours
            ? `auditing…${done ? ` ${done}` : ''} · ${mmss(elapsed)}`
            : `busy — ${status?.running?.subject}`}
        </button>
        {ours && p && p.failed > 0 ? (
          <span className="reassay-note">{p.failed} failing so far</span>
        ) : null}
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
      {!error && poolUp === false ? (
        <span className="reassay-note">no bench — live sections will be recorded blocked</span>
      ) : null}
      {!error && poolUp !== false && last ? (
        <span className="reassay-note">{describeLast(last)}</span>
      ) : null}
    </span>
  );
}
