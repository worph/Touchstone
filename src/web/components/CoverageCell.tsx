/**
 * `14/16` — how much of the checklist actually got checked.
 *
 * **This is not the verdict and must never read as one.** The verdict is gated on severity:
 * one Critical outranks fifteen passes, and no ratio can express that. A row can be 16/16 and
 * non-compliant, or 3/16 and carry no failures at all. The two sit side by side because they
 * answer different questions, and colouring this one green would quietly merge them.
 *
 * So it is rendered in the neutral text colour whatever the numbers say, and the only thing
 * that changes appearance is *incompleteness* — an assay that could not check everything is
 * the one state a reader must not skim past.
 */

import type { Coverage } from '@shared/types';

export default function CoverageCell({ coverage }: { coverage?: Coverage }) {
  // Every assay written before 2026-08-19 has none, and there is no honest way to backfill it
  // — deriving it from the prose is exactly the mistake the archive was cleaned of.
  if (!coverage || coverage.applicable === 0) return <span className="dim">—</span>;

  const incomplete = coverage.unverified > 0;
  return (
    <span
      className="coverage"
      data-incomplete={incomplete || undefined}
      title={
        `${coverage.passed} passed · ${coverage.failed} failed` +
        (coverage.unverified ? ` · ${coverage.unverified} unverified` : '') +
        (coverage.not_applicable ? ` · ${coverage.not_applicable} not applicable` : '') +
        '\nCoverage, not compliance: the verdict is gated on severity.'
      }
    >
      <span className="num">{coverage.verified}</span>
      <span className="coverage-of">/{coverage.applicable}</span>
      {incomplete ? <span className="coverage-gap"> ·{coverage.unverified}?</span> : null}
    </span>
  );
}
