/**
 * "Look at this one again" — the flag, on the page for one app.
 *
 * It is deliberately next to `ReassayButton` and deliberately not the same verb. That one
 * starts an audit *now*: it takes the single agent, it contends with whatever else wants it,
 * and it is the right control when somebody is watching the result. This one only puts the
 * app back in the backlog, and the loop reaches it in its own order under the same cooldown,
 * park and bench gate as everything else — which is what an operator actually wants after a
 * section blocked, because the app does not need auditing *now*, it needs auditing again.
 *
 * The flag is spent by the next attempt whatever that attempt concludes, so this is a
 * request rather than a state somebody has to remember to switch off. Pressing it twice is
 * how you take it back, and that is the whole of the model.
 *
 * Absent when the server sent no `flagged` at all: that means no scheduler is wired up, and
 * a flag with nothing to read it is a button that does nothing.
 */

import { useCallback, useState } from 'react';

import { flagSubject } from '../data/client';

interface Props {
  /** The subject key — `<origin>~<name>`, never the bare label. */
  subject: string;
  /** `undefined` when there is no scheduler; the button then does not render. */
  flagged: boolean | undefined;
  /** Re-read the subject, so the new flag comes back from the server rather than from here. */
  onChanged: () => void;
}

export default function FlagButton({ subject, flagged, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await flagSubject(subject, !flagged);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the flag.');
    } finally {
      setBusy(false);
    }
  }, [subject, flagged, onChanged]);

  if (flagged === undefined) return null;

  return (
    <span className="flagbtn">
      <button
        className={`btn${flagged ? ' flagbtn--on' : ''}`}
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        title={
          flagged
            ? 'This app is in the backlog because it was flagged. Press again to drop the flag.'
            : 'Put this app back in the backlog. It is audited in the queue order — this does not start a run.'
        }
      >
        {flagged ? 'flagged for re-audit' : 'flag for re-audit'}
      </button>
      {error ? <span className="reassay-note reassay-note--bad">{error}</span> : null}
    </span>
  );
}
