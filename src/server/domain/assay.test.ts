/**
 * Composing one run into one assay per section.
 *
 * The two things this file is here to pin down:
 *
 * - **The partition is real.** Each requirement is recorded against the section whose
 *   protocol listed it, so each file carries its own items and its own coverage. Before
 *   this, every item was heaped onto the static leg because that is where the splitter put
 *   the prose it could not place.
 * - **The score is not.** The agent declares one verdict, one tier and one risk score for the
 *   audit as a whole (principle 3), so they land on the first section and the rest say where
 *   they went. Attributing them to each would multiply the archive's risk by the number of
 *   sections.
 */

import { describe, expect, it } from 'vitest';

import type { RecordedPhase, RecordedRequirement } from '../../shared/types.js';
import { assaysFromAgentReport, type AssaySection } from './assay.js';

const STATIC: AssaySection = {
  id: 'static',
  name: 'Static Review Protocol',
  standard: { name: 'Static Review Protocol', version: 4 },
  phases: [],
  headings: ['^tech\\s*&\\s*documentation'],
};

const FUNCTIONAL: AssaySection = {
  id: 'functional',
  name: 'Functional Review Protocol',
  standard: { name: 'Functional Review Protocol', version: 3 },
  phases: ['A', 'C', 'E8'],
  headings: ['^functionality'],
};

const REPORT = [
  '## Verdict',
  '**NON-COMPLIANT · Major · risk score 12**',
  '',
  '## Tech & Documentation',
  'The compose file pins `:latest`.',
  '',
  '## Functionality',
  '| Phase | Result | Notes |',
  '| --- | --- | --- |',
  '| A — session | pass | logged in |',
  '| C — install | pass | 41s |',
  '',
  '## Notes',
  'Cleanup done.',
].join('\n');

const req = (id: string, section: string, over: Partial<RecordedRequirement> = {}): RecordedRequirement => ({
  id,
  section,
  verdict: 'pass',
  at: '2026-08-20T10:50:00.000Z',
  ...over,
});

const phase = (p: string, section: string, result: RecordedPhase['result'] = 'pass'): RecordedPhase => ({
  phase: p,
  section,
  result,
  at: '2026-08-20T10:55:00.000Z',
});

function compose(over: Partial<Parameters<typeof assaysFromAgentReport>[0]> = {}) {
  return assaysFromAgentReport({
    subject: 'Tuwunel',
    declared: { verdict: 'non-compliant', severity: 'Major', risk_score: 12, report_markdown: REPORT },
    sections: [STATIC, FUNCTIONAL],
    startedAt: '2026-08-20T10:00:00.000Z',
    finishedAt: '2026-08-20T10:30:00.000Z',
    ...over,
  });
}

describe('one file per section', () => {
  it('writes one assay for each section that ran, in protocol order', () => {
    const out = compose({ phases: [phase('A', 'functional')] });
    expect(out.map((a) => a.meta.section)).toEqual(['static', 'functional']);
  });

  it('stamps each with the standard that judged it', () => {
    const out = compose({ phases: [phase('A', 'functional')] });
    expect(out[0]?.meta.standard_version).toBe(4);
    expect(out[1]?.meta.standard_version).toBe(3);
  });

  /** Principle 3: the declaration is the verdict, and it is declared once for the run. */
  it('puts the declared verdict, tier and score on the first section only', () => {
    const out = compose({ phases: [phase('A', 'functional')] });
    expect(out[0]?.meta).toMatchObject({ verdict: 'non-compliant', top_severity: 'major', risk_score: 12 });
    expect(out[1]?.meta).toMatchObject({ top_severity: 'none', risk_score: 0, combined_score_on: 'static' });
  });
});

describe('requirements are partitioned by section', () => {
  const requirements = [
    req('pinned-image-tag', 'static', { verdict: 'fail', severity: 'major' }),
    req('cpu-shares', 'static'),
    req('phase-g-persistence', 'functional'),
  ];

  it('gives each file its own items', () => {
    const out = compose({ requirements, phases: [phase('A', 'functional')] });
    expect((out[0]?.meta.requirements ?? []).map((r) => r.id)).toEqual(['pinned-image-tag', 'cpu-shares']);
    expect((out[1]?.meta.requirements ?? []).map((r) => r.id)).toEqual(['phase-g-persistence']);
  });

  it('counts coverage per section rather than heaping it on the first', () => {
    const out = compose({ requirements, phases: [phase('A', 'functional')] });
    expect(out[0]?.meta.coverage?.applicable).toBe(2);
    expect(out[1]?.meta.coverage?.applicable).toBe(1);
  });

  /** An older run recorded nothing about sections. Its items still have to land somewhere. */
  it('falls back to the first section for an item with no section on it', () => {
    const out = compose({
      requirements: [{ id: 'legacy', verdict: 'pass', at: '2026-08-20T10:50:00.000Z' }],
      phases: [phase('A', 'functional')],
    });
    expect((out[0]?.meta.requirements ?? []).map((r) => r.id)).toEqual(['legacy']);
    expect(out[1]?.meta.requirements).toBeUndefined();
  });

  /** A later section states its own outcome from what it recorded, not from the headline. */
  it('makes a later section non-compliant on its own failing item', () => {
    const out = compose({
      requirements: [req('phase-g-persistence', 'functional', { verdict: 'fail', severity: 'critical' })],
      phases: [phase('A', 'functional')],
    });
    expect(out[1]?.meta.verdict).toBe('non-compliant');
  });
});

describe('a section whose phases never produced a result', () => {
  /**
   * The distinction the whole project exists to make. Reading a phase table with nothing in
   * it as a completed run is what turns a bench outage into a verdict about the app.
   */
  it('is blocked rather than done, and carries no verdict', () => {
    const out = compose({
      declared: {
        verdict: 'errored',
        severity: 'Major',
        risk_score: 12,
        report_markdown: REPORT.replace(/\| A.*\n\| C.*\n/, 'The demo pool returned 401, so no phase ran.\n'),
      },
    });
    expect(out[1]?.meta.status).toBe('blocked');
    expect(out[1]?.meta.verdict).toBeNull();
    // …and the errored headline is scoped off the section that did complete, which stands on
    // its own tier rather than inheriting an outage.
    expect(out[0]?.meta.status).toBe('done');
    expect(out[0]?.meta.verdict).toBe('non-compliant');
  });

  /** A section that declares no phase plan has nothing to gate on and always counts as run. */
  it('does not apply to a section with no phase plan', () => {
    const out = compose({ sections: [STATIC], phases: [] });
    expect(out).toHaveLength(1);
    expect(out[0]?.meta.status).toBe('done');
  });
});

describe('a section that was never attempted', () => {
  it('is written blocked, with the reason and nowhere else to look for a verdict', () => {
    const out = compose({
      sections: [STATIC],
      blocked: [{ section: FUNCTIONAL, reason: 'bench_unavailable' }],
    });
    expect(out).toHaveLength(2);
    expect(out[1]?.meta).toMatchObject({
      section: 'functional',
      status: 'blocked',
      verdict: null,
      top_severity: 'none',
      risk_score: 0,
      blocked_reason: 'bench_unavailable',
      combined_score_on: 'static',
    });
    expect(out[1]?.body).toContain('statement about the environment');
  });

  it('names a capability nobody has a sentence for, rather than guessing at a bench', () => {
    const out = compose({
      sections: [STATIC],
      blocked: [{ section: FUNCTIONAL, reason: 'network_unavailable' }],
    });
    expect(out[1]?.body).toContain('network_unavailable');
  });
});

/**
 * The two numbers on the primary section, and why they are not the same number.
 *
 * `risk_score` scores the whole run; the `coverage` block beside it covers only that
 * section's own items. Both are correct and they routinely differ, which for months read as
 * an arithmetic error on the face of the report. These pin the fields that say so.
 */
describe('the scope of the score is on the record', () => {
  it('names the sections the primary score covers, so the sibling coverage block cannot read as a contradiction', () => {
    const out = compose({ phases: [phase('A', 'functional')] });
    expect(out[0]?.meta.combined_score_of).toEqual(['static', 'functional']);
    // The other sections point back, which is how a reader gets from either file to the score.
    expect(out[1]?.meta.combined_score_on).toBe('static');
  });

  it('leaves it off a single-section run, where there is nothing to combine', () => {
    const out = compose({ sections: [STATIC] });
    expect(out[0]?.meta.combined_score_of).toBeUndefined();
  });

  it('records the computed sum when it disagrees with the declaration — not the declaration again', () => {
    // Two Major fails across the two sections sum to 20; the agent declared 12.
    const out = compose({
      requirements: [
        req('pinned-image-tag', 'static', { verdict: 'fail', severity: 'major' }),
        req('phase-g-persistence', 'functional', { verdict: 'fail', severity: 'major' }),
      ],
      phases: [phase('A', 'functional')],
    });
    // The declaration stays authoritative and stays where it was (invariant 1)…
    expect(out[0]?.meta.risk_score).toBe(12);
    // …and the other half of the disagreement is now legible. Recording the declared value
    // here — which is what this did until 2026-08-23 — wrote 12 twice and said nothing.
    expect(out[0]?.meta.risk_score_computed).toBe(20);
  });

  it('sums across every section, not just the primary, because that is the scope it is compared against', () => {
    const out = compose({
      requirements: [req('phase-g-persistence', 'functional', { verdict: 'fail', severity: 'critical' })],
      phases: [phase('A', 'functional')],
    });
    // The primary's own coverage is empty; the run's items sum to 100 all the same.
    expect(out[0]?.meta.coverage).toBeUndefined();
    expect(out[0]?.meta.risk_score_computed).toBe(100);
  });

  it('stays silent when the agent got its arithmetic right', () => {
    const out = compose({
      declared: { verdict: 'non-compliant', severity: 'Major', risk_score: 10, report_markdown: REPORT },
      requirements: [req('pinned-image-tag', 'static', { verdict: 'fail', severity: 'major' })],
      phases: [phase('A', 'functional')],
    });
    expect(out[0]?.meta.risk_score_computed).toBeUndefined();
  });
});

/** Which platform build produced a verdict — see `buildFrom` in `services/bench.ts`. */
describe('the bench build rides every assay', () => {
  it('stamps the fingerprint onto every section that ran', () => {
    const out = compose({ benchHost: 'https://demostaging1.inojob.com', benchBuild: 'index-C_5OE2_1' });
    expect(out.map((a) => a.meta.bench_build)).toEqual(['index-C_5OE2_1', 'index-C_5OE2_1']);
  });

  it('leaves a blocked section without one, exactly as it leaves it without a bench_host', () => {
    // A section that never ran has no environment to describe, and stamping the build of a
    // box it did not reach would make the archive answer "which platform produced this
    // verdict?" for a file that carries no verdict. Same reason `bench_host` is absent.
    const out = compose({
      sections: [STATIC],
      blocked: [{ section: FUNCTIONAL, reason: 'bench_unavailable' }],
      benchHost: 'https://demostaging1.inojob.com',
      benchBuild: 'index-C_5OE2_1',
    });
    expect(out[0]?.meta.bench_build).toBe('index-C_5OE2_1');
    expect(out[1]?.meta.bench_build).toBeUndefined();
    expect(out[1]?.meta.bench_host).toBeUndefined();
  });

  it('is simply absent when the probe could not read one', () => {
    const out = compose({ benchHost: 'https://demostaging1.inojob.com' });
    expect(out[0]?.meta.bench_build).toBeUndefined();
  });
});
