/**
 * "Look at this one again" — the flag, on every surface that offers it.
 *
 * One component in two variants, because there used to be three controls doing this and they
 * had drifted into three vocabularies: `flag for re-audit` / `flagged for re-audit` on the
 * subject page, `flag` / `unflag` on Automation, and — on the Store table — no flag at all but
 * an `audit` button, which is a different verb entirely. An operator reading the three could
 * reasonably conclude they did three different things.
 *
 * They do one thing. The flag adds an app to the backlog and nothing else: no jump, no forced
 * run, and no bypass of the cooldown or the bench gate. `assay now` is the other verb, and it
 * is the one that takes the single agent immediately — which is why the Store table does not
 * carry it. Seventy-three rows offering to interrupt everything is seventy-two disabled
 * buttons and one footgun; seventy-three rows offering to queue something are seventy-three
 * useful controls.
 *
 * The flag is spent by the next *attempt*, whatever that attempt concludes, so this is a
 * switch nobody has to remember to turn off. `flagged` is read back from the server's derived
 * answer rather than from `flagged_at` being set, so a flag the last attempt already answered
 * stops showing the moment it stops counting.
 *
 * `undefined` means the server sent no flag state at all — no scheduler is wired up — and the
 * control renders nothing rather than offering a button that cannot work. That is not the same
 * as `false`.
 */
import { useCallback, useState } from 'react';

import type { ScheduleResponse } from '@shared/schedule';
import { flagSubject } from '../data/client';

interface Props {
  /** The subject key — `<origin>~<name>`, never the bare label. */
  subject: string;
  flagged: boolean | undefined;
  /**
   * Handed the whole schedule the write returned, so a caller that renders the queue can
   * repaint every position in one go rather than fetching again. Callers that only need to
   * know something changed can ignore it.
   */
  onChanged: (schedule: ScheduleResponse) => void;
  /**
   * `row` is the glyph inside a table; `page` is the labelled button beside a heading.
   *
   * Only the presentation differs. Both write the same thing, and both are offered on a parked
   * row — since 2026-08-31 flagging releases a park, so this is no longer a control that
   * quietly does nothing there.
   */
  variant?: 'row' | 'page';
  /** The app's display name, for the row variant's accessible label. */
  label?: string;
}

/** What pressing it would do, said in full. The row variant has only this to go on. */
function describe(flagged: boolean): string {
  return flagged
    ? 'This app is in the backlog because it was flagged. Press again to drop the flag.'
    : 'Put this app back in the backlog. It is audited in the queue order — this does not start a run.';
}

export default function FlagControl({
  subject,
  flagged,
  onChanged,
  variant = 'page',
  label,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      onChanged(await flagSubject(subject, !flagged));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the flag.');
    } finally {
      setBusy(false);
    }
  }, [subject, flagged, onChanged]);

  if (flagged === undefined) return null;
  const on = Boolean(flagged);

  if (variant === 'row') {
    return (
      <span className="row-flag">
        <button
          className={`btn btn--sm row-flag__btn${on ? ' row-flag__btn--on' : ''}`}
          type="button"
          disabled={busy}
          onClick={() => void toggle()}
          aria-pressed={on}
          aria-label={`${on ? 'Drop the re-audit flag on' : 'Flag for re-audit'} ${label ?? subject}`}
          title={error ?? describe(on)}
        >
          ⚑
        </button>
        {error ? <span className="row-action__err" role="alert">!</span> : null}
      </span>
    );
  }

  return (
    <span className="flagbtn">
      <button
        className={`btn${on ? ' flagbtn--on' : ''}`}
        type="button"
        disabled={busy}
        onClick={() => void toggle()}
        aria-pressed={on}
        title={describe(on)}
      >
        {on ? '⚑ flagged' : '⚑ flag for re-audit'}
      </button>
      {error ? <span className="reassay-note reassay-note--bad">{error}</span> : null}
    </span>
  );
}
