/**
 * One section's verdict, as a card — and the tag naming the revision that judged it.
 *
 * Lifted out of `pages/SubjectDetail.tsx` when the trial detail grew the same cards. The
 * argument is `SubjectTable`'s, one level down: a trial exists to be compared against what a
 * subject carries, so a trial's `blocked` card has to be *the* blocked card, not a second one
 * that drifts. Everything a caller differs on is passed in; nothing about how a state is drawn
 * lives outside here and `lib/status.ts`.
 */
import { Link } from 'react-router-dom';

import { standardLabel } from '@shared/standard';
import type { AssayMeta, AssayRecord, Section, SubjectState } from '@shared/types';

import StatusCell from './StatusCell';
import { isReading } from '../lib/reading';
import { dateOnly, since } from '../lib/format';
import { displayState, runningState } from '../lib/status';

/** The run in flight, when it is this subject's. See `lib/overview.ts` for why it is an overlay. */
export interface LiveLeg {
  legs: Section[];
  started_at: string;
  note?: string;
}

/**
 * The sections to draw as verdict cards: what the subject has, plus what this run is adding.
 *
 * A section that *measures* is excluded — it has no verdict, and a card reading
 * `not yet run` beside a table that plainly did run would be the page contradicting itself.
 * It gets a panel of its own below instead.
 */
export function verdictSections(subject: SubjectState, live: LiveLeg | null): Section[] {
  const known = Object.keys(subject.sections ?? {}).filter((id) => !isReading(subject.sections?.[id]));
  const extra = (live?.legs ?? []).filter((id) => !known.includes(id) && !isReading(subject.sections?.[id]));
  return [...known, ...extra];
}

export default function LegCard({
  leg,
  rec,
  live,
  neverNote = 'this section has never been assayed',
}: {
  leg: Section;
  rec: AssayRecord | null;
  live: LiveLeg | null;
  /**
   * What an empty card says. The default is the archive's sentence, and it is wrong on a
   * trial: "never been assayed" reads as a fact about the *app*, where what happened is that
   * this one run did not get to this section. Invariant 4's distinction, one sentence down.
   */
  neverNote?: string;
}) {
  /**
   * No count on the card. `16/25` is a fact about the *run*, and printing it once per section
   * says each section is 16/25 of the way through its own list — two cards, the same number,
   * neither of them true. The run's progress belongs to the run card, which is on screen
   * beside this one; the section card says only that this section is being worked on.
   */
  const running = live?.legs.includes(leg) ? runningState(live.started_at) : null;
  const s = running ?? displayState(rec);
  return (
    <div className="leg-card">
      <span className="leg-name">{leg}</span>
      {/* While running the note is suppressed: the line below already says "being assayed
          now", and the run's clock and count belong to the run card, once, not to each
          section. A finished record keeps its note — that one is about the section. */}
      <StatusCell state={s} size="lg" showNote={!running} />
      {running ? (
        <div className="leg-meta">
          <span>being assayed now</span>
        </div>
      ) : rec ? (
        <div className="leg-meta">
          <span>{standardLabel(rec.meta)}</span>
          <span>
            {s.kind === 'blocked' ? 'since' : 'ran'} {dateOnly(rec.meta.started_at)} ·{' '}
            {since(rec.meta.started_at)}
          </span>
          {/* The sentence the wiki table could not say. */}
          {rec.meta.status === 'blocked' ? <span>no try used</span> : null}
        </div>
      ) : (
        <div className="leg-meta">
          <span>{neverNote}</span>
        </div>
      )}
    </div>
  );
}

/**
 * The standard that judged this assay, as a link to the exact bytes of it.
 *
 * The old label was `Static Review Protocol v7`, and `v7` pointed at nothing: the text it
 * named was overwritten the next time somebody edited the rubric. A hash points at a snapshot
 * the protocol history keeps, so the claim "you were graded under this" is checkable rather
 * than asserted. A legacy record still renders its integer — unlinked, because there is
 * nothing on the other end of it.
 */
export function StandardTag({ meta, section }: { meta: AssayMeta; section: Section }) {
  const label = standardLabel(meta);
  if (!meta.standard_sha256) return <span className="tag">{label}</span>;
  return (
    <Link
      className="tag tag--link"
      to={`/protocol?p=${encodeURIComponent(section)}&rev=${encodeURIComponent(meta.standard_sha256)}`}
      title="Read the revision of the standard that judged this assay"
    >
      {label}
    </Link>
  );
}
