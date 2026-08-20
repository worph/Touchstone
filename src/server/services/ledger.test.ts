import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from './events.js';
import { RunLedger, coverageOf, type CanonicalRequirement } from './ledger.js';

const SECTIONS = [
  { id: 'static', name: 'Static Review Protocol', phases: [] as string[] },
  { id: 'functional', name: 'Functional Review Protocol', phases: ['A', 'C', 'D'] },
];

const CANONICAL: CanonicalRequirement[] = [
  { id: 'cpu-shares', text: 'cpu_shares set on all services', section: 'static' },
  { id: 'pinned-image-tag', text: 'Specific version tag (no :latest)', section: 'static' },
  { id: 'phase-g-persistence', text: 'G — data survives a reinstall', section: 'functional', requires: 'bench' },
];

let dir: string;
let events: EventLog;
let ledger: RunLedger;

function open() {
  return ledger.open({ subject: 'Ntfy', sections: SECTIONS, canonical: CANONICAL });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-ledger-'));
  events = new EventLog(dir);
  ledger = new RunLedger({ events });
});

afterEach(async () => {
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * The token is the whole authorisation story for the one surface that points inward. A
 * static shared secret would be a way to forge audit results; a token that dies with its run
 * is also how a stale agent still writing after we gave up gets noticed instead of believed.
 */
describe('the run token', () => {
  it('is different every run', () => {
    expect(open().token).not.toBe(open().token);
  });

  it('refuses a token it never minted', () => {
    expect(ledger.recordRequirement('made-up', { id: 'cpu-shares', verdict: 'pass' })).toEqual({
      ok: false,
      error: 'unknown or expired run_token',
    });
  });

  it('refuses one whose run has ended', () => {
    const t = open();
    ledger.close(t.token);
    const out = ledger.recordRequirement(t.token, { id: 'cpu-shares', verdict: 'pass' });
    expect(out.ok).toBe(false);
  });

  it('refuses one that has expired', () => {
    let now = new Date('2026-08-19T12:00:00Z');
    const l = new RunLedger({ events, ttlMs: 60_000, now: () => now });
    const t = l.open({ subject: 'Ntfy', sections: SECTIONS, canonical: CANONICAL });
    now = new Date('2026-08-19T12:02:00Z');
    expect(l.recordRequirement(t.token, { id: 'cpu-shares', verdict: 'pass' })).toMatchObject({
      error: 'this run_token has expired',
    });
  });
});

describe('handing over the canonical ids', () => {
  it('gives the agent the list so it maps rather than invents', () => {
    const t = open();
    expect(ledger.requirementsFor(t.token)).toEqual(CANONICAL);
  });

  it('says so rather than returning an empty list for a bad token', () => {
    expect(ledger.requirementsFor('nope')).toHaveProperty('error');
  });
});

describe('recording one requirement', () => {
  it('keeps it, with the agent s own wording as evidence', () => {
    const t = open();
    const out = ledger.recordRequirement(t.token, {
      id: 'cpu-shares',
      requirement: 'cpu_shares set on all services',
      verdict: 'fail',
      severity: 'Minor',
      note: 'service dufs has deploy.resources but no cpu_shares',
    });
    expect(out).toMatchObject({ ok: true });
    expect(out.ok && out.recorded.severity).toBe('minor');
  });

  /**
   * The gate reads severity, not the number of failures. A fail without one cannot be scored,
   * and picking a tier here would be Touchstone judging rather than recording.
   */
  it('refuses a fail with no severity, while the agent can still fix it', () => {
    const t = open();
    expect(ledger.recordRequirement(t.token, { id: 'cpu-shares', verdict: 'fail' })).toEqual({
      ok: false,
      error: 'a fail must carry severity: Critical, Major or Minor',
    });
  });

  it('refuses a verdict outside the four', () => {
    const t = open();
    const out = ledger.recordRequirement(t.token, { id: 'cpu-shares', verdict: 'skipped' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain('pass, fail, n-a, unverified');
  });

  it('refuses one with no id at all', () => {
    const t = open();
    expect(ledger.recordRequirement(t.token, { verdict: 'pass' }).ok).toBe(false);
  });

  /** Recorded, never dropped — an unlisted id is how the protocol's list gets corrected. */
  it('keeps an id the protocol does not list, and marks it', async () => {
    const t = open();
    const out = ledger.recordRequirement(t.token, { id: 'something-new', verdict: 'pass' });
    expect(out.ok && out.recorded.unlisted).toBe(true);
    await events.flush();
    expect(events.query({ code: 'ASSAY_REQUIREMENT_UNLISTED' })).toHaveLength(1);
  });

  /** Revising item 6 after seeing item 11 is normal work; losing it silently is not. */
  it('lets the agent change its mind, and says that it did', async () => {
    const t = open();
    ledger.recordRequirement(t.token, { id: 'cpu-shares', verdict: 'pass' });
    ledger.recordRequirement(t.token, { id: 'cpu-shares', verdict: 'fail', severity: 'Minor' });
    await events.flush();

    const run = ledger.close(t.token)!;
    expect(run.requirements).toHaveLength(1);
    expect(run.requirements[0]).toMatchObject({ verdict: 'fail', revisions: 1 });
    expect(events.query({ code: 'ASSAY_REQUIREMENT_REVISED' })[0]?.detail).toMatchObject({
      from: 'pass',
      to: 'fail',
    });
  });
});

describe('recording a phase', () => {
  it('takes the four results the protocol allows', () => {
    const t = open();
    for (const result of ['pass', 'fail', 'errored', 'n-a']) {
      expect(ledger.recordPhase(t.token, { phase: `P-${result}`, result }).ok, result).toBe(true);
    }
  });

  /**
   * The 2026-07-07 amendment removed `skipped` from the vocabulary deliberately: a phase that
   * could not run is `errored` and the audit retries. There is no way to say "I chose not to".
   */
  it('has no way to say a phase was skipped', () => {
    const t = open();
    const out = ledger.recordPhase(t.token, { phase: 'G', result: 'skipped' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toContain('pass, fail, errored, n-a');
  });

  it('replaces a phase rather than listing it twice', () => {
    const t = open();
    ledger.recordPhase(t.token, { phase: 'G', result: 'errored' });
    ledger.recordPhase(t.token, { phase: 'G', result: 'pass' });
    expect(ledger.close(t.token)!.phases).toEqual([expect.objectContaining({ phase: 'G', result: 'pass' })]);
  });
});

/**
 * The reason the whole arrangement exists: a run that dies at requirement 12 of 16 has
 * established twelve facts, and the old blob-at-the-end contract threw all twelve away.
 */
describe('a run that does not finish', () => {
  it('keeps everything recorded before it stopped', () => {
    const t = open();
    ledger.recordRequirement(t.token, { id: 'cpu-shares', verdict: 'fail', severity: 'Minor' });
    ledger.recordRequirement(t.token, { id: 'pinned-image-tag', verdict: 'pass' });

    const closed = ledger.close(t.token)!;
    expect(closed.requirements).toHaveLength(2);
    expect(ledger.last()?.subject).toBe('Ntfy');
  });

  it('still shows the last run to a page that polled a beat late', () => {
    const t = open();
    ledger.close(t.token);
    expect(ledger.live()).toBeNull();
    expect(ledger.last()?.closed_at).toBeTruthy();
  });
});

/** Coverage is not compliance — one Critical outranks fifteen passes, and a count cannot say so. */
describe('coverage', () => {
  it('counts verified against applicable, and leaves n-a out of both', () => {
    expect(
      coverageOf([
        { id: 'a', verdict: 'pass', at: '' },
        { id: 'b', verdict: 'fail', severity: 'major', at: '' },
        { id: 'c', verdict: 'n-a', at: '' },
        { id: 'd', verdict: 'unverified', at: '' },
      ]),
    ).toMatchObject({ verified: 2, applicable: 3, passed: 1, failed: 1, unverified: 1, not_applicable: 1 });
  });

  it('scores risk by the protocol s own weights', () => {
    expect(
      coverageOf([
        { id: 'a', verdict: 'fail', severity: 'critical', at: '' },
        { id: 'b', verdict: 'fail', severity: 'major', at: '' },
        { id: 'c', verdict: 'fail', severity: 'minor', at: '' },
      ]).risk,
    ).toBe(111);
  });

  it('is empty rather than wrong when nothing was recorded', () => {
    expect(coverageOf([])).toMatchObject({ verified: 0, applicable: 0, risk: 0 });
  });
});

/**
 * Section attribution — what makes an assay per section possible at all.
 *
 * The canonical list is built by walking the protocol files, so Touchstone already knows
 * which section owns every id it handed out. The agent is never asked, and never believed
 * over the list: an id it could route into the wrong section is an id whose severity could
 * miss the gate that reads it.
 */
describe('which section a record belongs to', () => {
  it('takes it from the protocol that listed the id, not from the agent', () => {
    const t = open();
    const out = ledger.recordRequirement(t.token, {
      id: 'phase-g-persistence',
      verdict: 'pass',
      // The agent says static. The protocol says functional, and the protocol decides.
      section: 'static',
    });
    expect(out.ok && out.recorded.section).toBe('functional');
  });

  it('accepts the agent\'s section for an item the protocol does not list', () => {
    const t = open();
    const out = ledger.recordRequirement(t.token, {
      id: 'undeclared-healthcheck',
      verdict: 'fail',
      severity: 'Minor',
      section: 'functional',
    });
    expect(out.ok && out.recorded.unlisted).toBe(true);
    expect(out.ok && out.recorded.section).toBe('functional');
  });

  /**
   * Invariant 6, at the section level. A section the agent invents would be a partition the
   * gate does not know to read, so a Critical filed there would never reach a verdict. It
   * lands on the first section instead, recorded and marked unlisted.
   */
  it('refuses to mint a section the protocol never declared', () => {
    const t = open();
    const out = ledger.recordRequirement(t.token, {
      id: 'cosmetic-thing',
      verdict: 'fail',
      severity: 'Critical',
      section: 'cosmetic',
    });
    expect(out.ok && out.recorded.section).toBe('static');
    expect(out.ok && out.recorded.unlisted).toBe(true);
  });

  it('attributes a phase to the section whose plan names it', () => {
    const t = open();
    const out = ledger.recordPhase(t.token, { phase: 'C', result: 'pass' });
    expect(out.ok && out.recorded.section).toBe('functional');
  });

  /** A phase nobody planned still gets recorded — dropping it would lose real work. */
  it('keeps a phase outside the plan, attributed to the only section that has one', () => {
    const t = open();
    const out = ledger.recordPhase(t.token, { phase: 'Z', result: 'errored' });
    expect(out.ok).toBe(true);
    expect(out.ok && out.recorded.section).toBe('functional');
  });

  it('tells the agent what the run is made of, not only what to check', () => {
    const t = open();
    const plan = ledger.planFor(t.token);
    expect('error' in plan).toBe(false);
    if ('error' in plan) return;
    expect(plan.sections.map((s) => s.id)).toEqual(['static', 'functional']);
    expect(plan.requirements.every((r) => r.section)).toBe(true);
  });
});
