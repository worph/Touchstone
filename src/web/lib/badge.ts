/**
 * The nav badge: open alerts, plus error rows you have not seen.
 *
 * It counts those two things and nothing else. A badge that counts routine completions is
 * a badge people stop reading, and then it is not a badge (UX.md §2.3).
 *
 * "Seen" is a high-water mark in localStorage, stamped when the Activity page renders. Per
 * browser rather than per user because there are no users — AppShield already authenticated
 * the visitor and the app is one shared authenticated view.
 */

const KEY = 'touchstone.log.seen';

export function seenSeq(): number {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    // Private mode, or storage disabled. Then everything is unseen, which errs towards
    // showing the badge — the direction that cannot hide an outage.
    return 0;
  }
}

export function markSeen(seq: number): void {
  try {
    if (seq > seenSeq()) localStorage.setItem(KEY, String(seq));
  } catch {
    /* nothing to do; the badge simply stays lit */
  }
}
