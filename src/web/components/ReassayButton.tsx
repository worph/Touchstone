/**
 * The manual trigger — n8n's `Audit an app` form, as a button.
 *
 * Three things it has to get right, and each of them is why it is not a plain `onClick`:
 *
 * - **An audit takes five to ten minutes.** The request is not held open; the button starts
 *   a run and then polls. A spinner with no elapsed time reads as "hung" after ninety
 *   seconds, so it counts up.
 * - **The functional leg needs a bench.** Offering it when the pool is down queues something
 *   that cannot run and files the failure against the app. It is disabled with the reason.
 * - **One agent.** If a run is already going — a scheduled one, or someone else's — the
 *   button says which app has it rather than failing on submit.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { AssayStatus } from '../data/client';
import { getAssayStatus, getBenches, startAssay } from '../data/client';

const POLL_MS = 5_000;

interface Props {
  subject: string;
  onFinished: () => void;
  label?: string;
}

export default function ReassayButton({ subject, onFinished, label = 're-assay' }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AssayStatus | null>(null);
  const [poolUp, setPoolUp] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const wasRunning = useRef(false);

  const ours = status?.running?.subject === subject;
  const running = Boolean(status?.running);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getAssayStatus());
    } catch {
      /* the poll is best-effort; the page stays usable without it */
    }
  }, []);

  useEffect(() => {
    void refresh();
    void getBenches()
      .then((b) => setPoolUp(b.leasable > 0))
      .catch(() => setPoolUp(null));
  }, [refresh]);

  // Poll only while something is running. An idle page should not talk to the API every
  // five seconds for the sake of a button nobody pressed.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const started = Date.parse(status?.running?.started_at ?? '') || Date.now();
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running, status?.running?.started_at]);

  // The moment a run of *ours* stops, pull the new report in.
  useEffect(() => {
    if (running && ours) wasRunning.current = true;
    if (!running && wasRunning.current) {
      wasRunning.current = false;
      onFinished();
    }
  }, [running, ours, onFinished]);

  const start = useCallback(
    async (depth: 'static' | 'full') => {
      setOpen(false);
      setError(null);
      try {
        await startAssay(subject, depth);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not start the audit.');
      }
    },
    [subject, refresh],
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
    const p = status?.progress;
    const done = p && p.of_canonical > 0 ? ` ${p.verified}/${p.of_canonical}` : '';
    return (
      <span className="reassay">
        <button className="btn" type="button" disabled>
          {ours ? `auditing…${done} · ${mmss(elapsed)}` : `busy — ${status?.running?.subject}`}
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
      <button className="btn" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {label} ▾
      </button>

      {open ? (
        <span className="reassay-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => void start('static')}>
            static only
            <span className="dim"> · no bench needed</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={poolUp === false}
            title={poolUp === false ? 'No demo bench is usable, so the functional leg cannot run' : undefined}
            onClick={() => void start('full')}
          >
            static + functional
            {poolUp === false ? <span className="dim"> · no bench</span> : null}
          </button>
        </span>
      ) : null}

      {error ? <span className="reassay-note reassay-note--bad">{error}</span> : null}
      {!error && last ? <span className="reassay-note">{describe(last)}</span> : null}
    </span>
  );
}

/** The last run, in one clause. `blocked` and `busy` are not failures and must not read as one. */
function describe(last: NonNullable<AssayStatus['last']>): string {
  const o = last.outcome;
  if (o.kind === 'verdict') return `last run: ${o.verdict} · risk ${o.risk}`;
  if (o.kind === 'agent_busy') return 'last run: the agent was busy — nothing was charged';
  if (o.kind === 'blocked') return `last run: could not start (${o.reason.replace(/_/g, ' ')})`;
  return `last run: failed (${o.reason})`;
}

function mmss(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
