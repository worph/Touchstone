/**
 * The caveat on a verdict that a newer rubric has not been applied to yet.
 *
 * Not a status and not a finding: the verdict is exactly as true as it was the day it was
 * reached — what changed is the question. So this is a quiet chip beside a name rather than a
 * column or a banner, and `current` draws nothing at all, because a badge on every up-to-date
 * row would be noise on the common case and the absence of one is already the statement.
 *
 * Shared by the Store table, the public board and both subject pages on purpose. The chip is
 * where somebody first sees the caveat and the detail page is where they land when they click
 * it; a caveat that vanished on the way would read as having been withdrawn.
 */

import type { StandardState } from '@shared/types';

const TITLE: Record<'older' | 'unknown', string> = {
  older:
    'The rubric has been edited since this verdict was reached. The app will be audited again without waiting out the usual freshness window.',
  unknown:
    'This assay predates revision tracking and names no rubric, so there is nothing to compare it against.',
};

export default function StandardChip({ standard }: { standard?: StandardState }) {
  if (standard !== 'older' && standard !== 'unknown') return null;
  return (
    <span className="tag standard-tag" data-standard={standard} title={TITLE[standard]}>
      {standard === 'older' ? 'older standard' : 'standard unknown'}
    </span>
  );
}
