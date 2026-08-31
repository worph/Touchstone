/**
 * The per-row delete on the Store page — the one control in this app that destroys something.
 *
 * It stands in the same cell as `AuditButton` and replaces it, which is the whole design: the
 * two are mutually exclusive by definition. An app the store no longer offers cannot be
 * fetched, so `audit` on that row could only ever start a run that errors; and an app the
 * store does offer must not be deletable, so `delete` on that row must not exist. One column,
 * one verb, decided by whether the row is delisted.
 *
 * Three deliberate properties:
 *
 * - **The guard is the server's.** `DELETE /subjects/:name` refuses anything that is not
 *   delisted and anything at all while the store is unreadable. What is here is a confirm
 *   step, which is courtesy — it stops a misclick, not a mistake.
 * - **It asks twice, and the second word is the honest one.** `delete` opens the question,
 *   `delete forever` answers it — a confirmation that says only "yes" is a confirmation people
 *   learn to click. It deliberately quotes no file count: a row knows its *current* assay per
 *   section, not how many files the subject's history runs to, and a number in a destructive
 *   confirmation has to be right or it should not be there.
 * - **It reloads rather than removing the row itself.** The row is composed from the archive
 *   and the registry together; a client that spliced it out of a list would be a second
 *   opinion about what the archive contains, and the next reload would settle which was right.
 */
import { useCallback, useState } from 'react';

import { deleteSubject } from '../data/client';

interface Props {
  /** The subject key — `<origin>~<name>`, never the bare label. */
  subject: string;
  label: string;
  /** Re-fetch the table. The row goes because the archive no longer has it, not because we say. */
  onDone: () => void;
}

export default function DeleteSubjectButton({ subject, label, onDone }: Props) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await deleteSubject(subject);
      setAsking(false);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not delete');
    } finally {
      setBusy(false);
    }
  }, [subject, onDone]);

  if (asking) {
    return (
      <span className="row-delete" role="group" aria-label={`Delete ${label}'s archive`}>
        <button
          className="btn btn--sm btn--danger"
          type="button"
          disabled={busy}
          onClick={() => void run()}
          title={
            `Permanently delete every report Touchstone holds for ${label}. ` +
            'The verdicts, the evidence and the fix brief all go with them. This cannot be undone.'
          }
        >
          {busy ? '…' : 'delete forever'}
        </button>
        <button className="btn btn--sm" type="button" disabled={busy} onClick={() => setAsking(false)}>
          keep
        </button>
        {error ? (
          <span className="row-action__err" role="alert" title={error}>
            !
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <button
      className="btn btn--sm"
      type="button"
      onClick={() => setAsking(true)}
      aria-label={`Delete the archive for ${label}`}
      title={`${label} is no longer in the store. This deletes every report it left behind, and what the scheduler still remembers about it.`}
    >
      delete
    </button>
  );
}
