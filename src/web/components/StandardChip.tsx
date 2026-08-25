/**
 * The two caveats a row can carry, and why they are two.
 *
 * Neither is a status or a finding: a verdict is exactly as true as it was the day it was
 * reached. What each says is that something moved *underneath* it since — and they are not the
 * same something, which is why they are separate chips rather than one "out of date" warning.
 *
 *   `older standard`  the rubric was edited. The question changed; we will ask it again.
 *   `app changed`     the compose was edited. The subject changed; this verdict may be about
 *                     a problem already fixed, or miss one just introduced.
 *
 * To an operator the difference is which of two things to go and look at. To an app author —
 * the audience for `/public` — it is the difference between "wait for us" and "that was you".
 * Collapsing them would lose exactly the distinction the board exists to communicate.
 *
 * `current` draws nothing in either case: a badge on every up-to-date row is noise on the
 * common case, and the absence of one is already the statement. A row may legitimately carry
 * both chips at once.
 *
 * Shared by the Store table, the public board and both subject pages, because the chip is
 * where somebody first sees the caveat and the detail page is where they land when they click
 * it — one that vanished on the way would read as having been withdrawn.
 */

import type { StandardState, SubjectVersionState } from '@shared/types';

const STANDARD_TITLE: Record<'older' | 'unknown', string> = {
  older:
    'The rubric has been edited since this verdict was reached. The app will be audited again without waiting out the usual freshness window.',
  unknown:
    'This assay predates revision tracking and names no rubric, so there is nothing to compare it against.',
};

const VERSION_TITLE =
  'The app’s docker-compose.yml has changed in the store since this verdict was reached, so it may not describe the app as it now ships. It will be audited again without waiting out the usual freshness window.';

export default function StandardChip({ standard }: { standard?: StandardState }) {
  if (standard !== 'older' && standard !== 'unknown') return null;
  return (
    <span className="tag standard-tag" data-standard={standard} title={STANDARD_TITLE[standard]}>
      {standard === 'older' ? 'older standard' : 'standard unknown'}
    </span>
  );
}

/**
 * `unknown` deliberately draws nothing, unlike the standard chip's.
 *
 * There it is worth saying — the archive genuinely cannot name the rubric that judged an old
 * assay, and an operator reading a verdict should know that. Here it would appear on every
 * pre-2026-08-25 row at once and say only "this predates the feature", which is noise that
 * clears itself within one audit rotation.
 */
export function VersionChip({ version }: { version?: SubjectVersionState }) {
  if (version !== 'changed') return null;
  return (
    <span className="tag version-tag" title={VERSION_TITLE}>
      app changed
    </span>
  );
}
