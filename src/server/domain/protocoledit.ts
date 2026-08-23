/**
 * Saving a protocol — the one path, for every caller.
 *
 * A save is not `fs.writeFile`. It is three things that have to happen together: replace the
 * prose, sweep the history so the new bytes are recorded *with the reason they were changed
 * for*, and log an event an operator will see on Activity. `PUT /protocols/:id` did all three
 * inline, and that was fine while the editor was the only way in. It stopped being fine the
 * moment the administrator chat could edit a rubric too: a second caller that forgot the sweep
 * would leave the edit recorded as `observed`, with nothing to say for itself — which is the
 * exact hole `store/revisions.ts` was built to close.
 *
 * So the sequence lives here and both callers ask for it. `via` is the only thing they differ
 * on, and it is a label in the log rather than a permission: what a chat may save is what the
 * editor may save, because it is the same function.
 *
 * What this deliberately does *not* offer is a restore. Putting an old revision back is an
 * ordinary save of that text, forward, with a reason — see `routes/protocols.ts`.
 */

import type { EventLog } from '../services/events.js';
import type { Protocol, ProtocolStore } from '../store/protocols.js';
import type { Revision, RevisionStore } from '../store/revisions.js';

/** Long enough that a reason is a sentence, short enough that it is not a second rubric. */
export const MAX_MESSAGE = 200;

/** Who asked. A label on the row, not a capability — see the header. */
export type EditVia = 'api' | 'chat' | 'mcp';

export interface ProtocolEditDeps {
  protocols?: ProtocolStore;
  revisions?: RevisionStore;
  events?: EventLog;
}

export type ProtocolSaveResult =
  | { ok: true; protocol: Protocol; revision: Revision | null; changed: boolean }
  | { ok: false; status: number; error: string };

export interface ProtocolSaveInput {
  id: string;
  body: string | undefined;
  message: string | undefined;
  via: EditVia;
}

/**
 * Replace a protocol's prose, record the revision, log it.
 *
 * The two refusals are the route's, verbatim, because they are about the rubric rather than
 * about HTTP: an empty body would grade every app against nothing and pass them all, and a
 * save with no reason produces a history row that can say what changed but never why.
 */
export async function saveProtocol(
  deps: ProtocolEditDeps,
  input: ProtocolSaveInput,
): Promise<ProtocolSaveResult> {
  if (!deps.protocols) return { ok: false, status: 503, error: 'no protocol store' };

  if (typeof input.body !== 'string' || input.body.trim().length === 0) {
    return { ok: false, status: 400, error: 'the protocol body cannot be empty' };
  }
  const message = (input.message ?? '').trim().slice(0, MAX_MESSAGE);
  if (message === '') {
    return { ok: false, status: 400, error: 'say why the protocol is being changed' };
  }

  const before = await deps.protocols.get(input.id);
  const saved = await deps.protocols.save(input.id, input.body);
  if (!saved) return { ok: false, status: 404, error: 'no such protocol' };

  // A save that changed nothing must not acquire a history row whose diff is empty. `save()`
  // already declines to write in that case; this is how the caller learns it did.
  const changed = before?.sha256 !== saved.sha256;
  if (!changed) return { ok: true, protocol: saved, revision: null, changed: false };

  // A full sweep rather than a record of this one file: a save is the cheapest moment to
  // notice that somebody also hand-edited the script beside it. Those rows come out
  // `observed`; only the file just written carries the reason.
  const recorded = await deps.revisions?.sweep({ save: { file: saved.file, message } });
  const revision = recorded?.find((r) => r.file === saved.file) ?? null;

  if (revision) {
    deps.events?.log({
      level: 'info',
      code: 'PROTOCOL_EDITED',
      message: 'The audit protocol was edited, and the next audit will use it',
      detail: {
        id: saved.meta.id,
        sha256: revision.sha256,
        seq: revision.seq,
        bytes: saved.bytes,
        via: input.via,
        message,
      },
    });
  }

  return { ok: true, protocol: saved, revision, changed: true };
}
