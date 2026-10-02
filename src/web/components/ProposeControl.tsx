/**
 * Propose a fix — the subject page's door into the workshop.
 *
 * It queues a proposal; it does not open a pull request. What happens next — authoring on a
 * bench, validation on every platform, a ready proposal waiting for a person or the quota —
 * is on the Workshop page, which is where this links once there is something to look at.
 * Rendered only when the workshop could take it: a button that always answers "not
 * configured" is a button that teaches people to stop pressing it.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { proposeWork } from '../data/client';

export default function ProposeControl({
  subject,
  fixable,
  ready,
  active,
  onChanged,
}: {
  subject: string;
  fixable: boolean;
  ready: boolean | undefined;
  active?: { state: string; pr?: { number: number; url: string } };
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (active) {
    return active.pr ? (
      <a className="btn" href={active.pr.url} target="_blank" rel="noreferrer" title="The workshop's pull request for this app">
        PR #{active.pr.number}
      </a>
    ) : (
      <Link className="btn auditbtn--on" to="/workshop" title="The workshop has a proposal for this app">
        proposal: {active.state}
      </Link>
    );
  }
  if (!fixable || !ready) return null;
  return (
    <span className="reassay">
      <button
        className="btn"
        type="button"
        disabled={busy}
        title="Have the workshop author a fix, validate it and get it ready as a pull request"
        onClick={() => {
          setBusy(true);
          setError(null);
          void proposeWork({ subject, kind: 'fix' })
            .then(() => onChanged())
            .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Proposing…' : 'Propose fix'}
      </button>
      {error ? <span className="reassay-note">{error}</span> : null}
    </span>
  );
}
