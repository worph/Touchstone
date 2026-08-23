/**
 * What the audit actually checked, item by item.
 *
 * Until 2026-08-19 this was prose inside the report and nothing else — you could read that one
 * app failed `cpu_shares`, but not ask which apps fail it, or how much of the checklist a run
 * had managed to get through. The agent records each item as it settles it now, so the list is
 * data.
 *
 * Ordered by what a reader is looking for rather than by id: **failures first, worst tier
 * first**, then anything that could not be checked, then the passes. A page that opens on
 * fourteen greens has buried its own point.
 */

import { useState } from 'react';

import type { AssayRecord, RecordedRequirement, Severity } from '@shared/types';

import CoverageCell from './CoverageCell';

const VERDICT_RANK: Record<string, number> = { fail: 0, unverified: 1, 'n-a': 2, pass: 3 };
const SEVERITY_RANK: Record<string, number> = { critical: 0, major: 1, minor: 2, none: 3 };

export default function RequirementList({ items }: { items: RecordedRequirement[] }) {
  // Passes are the bulk and the least interesting; folded by default, counted in the toggle.
  const [showPasses, setShowPasses] = useState(false);

  const sorted = [...items].sort(
    (a, b) =>
      (VERDICT_RANK[a.verdict] ?? 9) - (VERDICT_RANK[b.verdict] ?? 9) ||
      (SEVERITY_RANK[a.severity ?? 'none'] ?? 9) - (SEVERITY_RANK[b.severity ?? 'none'] ?? 9) ||
      a.id.localeCompare(b.id),
  );
  const passes = sorted.filter((r) => r.verdict === 'pass');
  const rest = sorted.filter((r) => r.verdict !== 'pass');
  const shown = showPasses ? sorted : rest;

  if (items.length === 0) return null;

  return (
    <div className="reqs">
      {shown.map((r) => (
        <div className="req" key={r.id} data-verdict={r.verdict} data-severity={r.severity}>
          <div className="req-head">
            <span className="req-verdict">{label(r)}</span>
            <code className="req-id">{r.id}</code>
            {/* An id the protocol does not list is kept and shown, because that is how the
                protocol's list gets corrected rather than quietly diverging. */}
            {r.unlisted ? <span className="tag" title="Not in the protocol's list">unlisted</span> : null}
            {r.revisions ? (
              <span className="tag" title="The audit changed its mind about this one">revised</span>
            ) : null}
          </div>
          {r.requirement ? <div className="req-text">{r.requirement}</div> : null}
          {r.note ? <div className="req-note">{r.note}</div> : null}
        </div>
      ))}

      {passes.length > 0 ? (
        <button type="button" className="req-toggle" onClick={() => setShowPasses((v) => !v)}>
          {showPasses ? 'hide' : 'show'} {passes.length} passing {passes.length === 1 ? 'item' : 'items'}
        </button>
      ) : null}
    </div>
  );
}

function label(r: { verdict: string; severity?: Severity }): string {
  if (r.verdict === 'fail') return `fail · ${r.severity ?? 'unscored'}`;
  if (r.verdict === 'unverified') return 'not checked';
  if (r.verdict === 'n-a') return 'n-a';
  return 'pass';
}

/**
 * The list with its heading and its coverage figure — the panel two pages draw identically.
 *
 * Coverage sits beside the items rather than above the verdict because it answers a different
 * question and must never be read as one: a run can be 16/16 and non-compliant, or 3/16 and
 * carry no failures at all. `CoverageCell` says the rest.
 *
 * Renders nothing when the record has no recorded requirements — everything imported before
 * the ledger existed has a verdict and no items, and an empty panel headed "requirements" is
 * a page implying the audit checked nothing.
 */
export function RequirementsPanel({ rec }: { rec: AssayRecord | null }) {
  const items = rec?.meta.requirements ?? [];
  if (!rec || items.length === 0) return null;
  return (
    <section className="panel" style={{ marginTop: 14 }}>
      <div className="pane-head">
        <span className="section-title">requirements</span>
        {rec.meta.coverage ? (
          <span className="dim" style={{ fontSize: 11.5 }}>
            <CoverageCell coverage={rec.meta.coverage} /> verified
            {rec.meta.risk_score_computed !== undefined ? (
              // The agent's own score and the sum of its items came apart. Both are kept;
              // saying so is better than picking one and looking certain.
              //
              // Both halves are read off the record, and both are run-wide. This used to
              // print `coverage.risk` as "its items sum to", which is *this section's*
              // items — while the mismatch that raised the line was measured across the
              // whole run. So the line could fire on a genuine disagreement and then
              // display two numbers that were never the two being compared.
              <span className="req-mismatch">
                {' '}· the audit declared risk {rec.meta.risk_score}, its items sum to{' '}
                {rec.meta.risk_score_computed}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>
      <RequirementList items={items} />
    </section>
  );
}
