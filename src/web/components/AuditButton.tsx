/**
 * The per-row trigger on the Store page — `n8n`'s `Audit an app` form, one app wide.
 *
 * `ReassayButton` is the same verb and is deliberately not reused here. That one is a
 * *page's* control: it fetches the bench pool to warn about blocked sections, it counts
 * elapsed time, and it reports what the last run of its subject concluded. All three are
 * right for a subject page with one of them on it, and all three are wrong seventy-two rows
 * down a table — the pool fetch alone would be seventy-two requests for one boolean, and the
 * notes would be a column of prose beside a column of verdicts.
 *
 * So this is the same action with the row's share of the chrome:
 *
 * - **It polls nothing.** `useRunStatus()` is the single shared poller; every button on the
 *   page reads the same snapshot, so the table cannot disagree with itself about what is
 *   running.
 * - **One agent means one enabled button.** While any audit is in flight every row is
 *   disabled — the row that owns it says `auditing…`, the rest say why they are not
 *   available on hover rather than failing on submit.
 * - **The bench warning is the page's, not the row's.** The Store page says it once, above the
 *   table — as the open alert's own `impact`, which is where the pool's state and the window
 *   until it changes are already composed. A run with no bench still starts and records those
 *   sections blocked, which costs the app nothing. (This comment claimed the page fetched the
 *   pool itself until 2026-08-23; it never did, and the banner it describes is alert-driven.)
 */
import { useCallback, useState } from 'react';

import { startAssay } from '../data/client';
import { refreshRunStatus, useRunStatus } from '../data/runStatus';

interface Props {
  /** The subject key — `<origin>~<name>`, never the bare label. */
  subject: string;
  label: string;
}

export default function AuditButton({ subject, label }: Props) {
  const status = useRunStatus();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const running = status?.running ?? null;
  const ours = running?.subject === subject;

  const start = useCallback(async () => {
    setError(null);
    setStarting(true);
    try {
      await startAssay(subject);
      // Poll at once rather than waiting out the interval: a four-second gap between the
      // click and the row changing reads as the click not having worked.
      await refreshRunStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not start');
    } finally {
      setStarting(false);
    }
  }, [subject]);

  if (status && !status.enabled) {
    return (
      <button
        className="btn btn--sm"
        type="button"
        disabled
        title="The runner is off — set runner.enabled in config.yaml"
      >
        audit
      </button>
    );
  }

  if (ours) {
    return <span className="row-audit__state">auditing…</span>;
  }

  if (running) {
    return (
      <button
        className="btn btn--sm"
        type="button"
        disabled
        title={`One audit runs at a time — ${running.subject} has the agent`}
      >
        audit
      </button>
    );
  }

  return (
    <span className="row-audit">
      <button
        className="btn btn--sm"
        type="button"
        disabled={starting}
        onClick={() => void start()}
        aria-label={`Audit ${label}`}
        title={error ?? undefined}
      >
        {starting ? '…' : 'audit'}
      </button>
      {error ? <span className="row-audit__err" role="alert">!</span> : null}
    </span>
  );
}
