import { describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN, subjectKey } from '../../shared/subject.js';
import { FIXTURE_RECORDS, makeRecord } from './fixtures.js';
import { hallmarks, latestDone, legState, sortNewestFirst, subjectHallmark } from './hallmark.js';
import { recordFor } from '../store/reports.js';

const NOW = Date.parse('2026-08-06T12:00:00Z');
const APP = subjectKey(DEFAULT_ORIGIN, 'App');

describe('leg selection', () => {
  it('takes the newest done assay as the hallmark', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'static', at: '2026-07-01T00:00:00Z' }),
      makeRecord({
        subject: 'App',
        leg: 'static',
        at: '2026-08-01T00:00:00Z',
        top_severity: 'major',
        risk_score: 10,
      }),
    ];
    expect(legState(records, 'static').hallmark?.meta.started_at).toBe('2026-08-01T00:00:00Z');
    expect(latestDone(records, APP, 'static')?.meta.verdict).toBe('non-compliant');
  });

  it('a blocked leg reads as blocked and never falls back to the older verdict', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'functional', at: '2026-07-01T00:00:00Z' }),
      makeRecord({
        subject: 'App',
        leg: 'functional',
        at: '2026-08-05T00:00:00Z',
        status: 'blocked',
        blocked_reason: 'bench_unavailable',
      }),
    ];

    const { state, legs } = subjectHallmark(APP, records, { now: NOW });

    // the displayed record is the blocked one …
    expect(state.functional?.meta.status).toBe('blocked');
    expect(state.functional?.meta.verdict).toBeNull();
    expect(state.functional?.meta.blocked_reason).toBe('bench_unavailable');
    // … and July's `compliant` is still reachable as the last verdict, just not as current
    expect(legs.functional?.hallmark?.meta.verdict).toBe('compliant');
    expect(legs.functional?.stale).toBe(true);
  });

  it('a running assay does not become the displayed verdict either', () => {
    const records = [
      makeRecord({
        subject: 'App',
        leg: 'static',
        at: '2026-07-01T00:00:00Z',
        top_severity: 'major',
        risk_score: 10,
      }),
      makeRecord({ subject: 'App', leg: 'static', at: '2026-08-06T00:00:00Z', status: 'running' }),
    ];
    const { state } = subjectHallmark(APP, records, { now: NOW });
    expect(state.static?.meta.status).toBe('running');
    expect(state.static?.meta.verdict).toBeNull();
  });

  it('keeps the verdict when the newest assay is the done one', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'static', at: '2026-07-01T00:00:00Z', status: 'blocked' }),
      makeRecord({
        subject: 'App',
        leg: 'static',
        at: '2026-08-01T00:00:00Z',
        top_severity: 'major',
        risk_score: 10,
      }),
    ];
    const { state, legs } = subjectHallmark(APP, records, { now: NOW });
    expect(state.static?.meta.status).toBe('done');
    expect(legs.static?.stale).toBe(false);
  });
});

describe('subject row', () => {
  it('sums risk over the legs and ages off the newest done assay', () => {
    const { state } = subjectHallmark(subjectKey(DEFAULT_ORIGIN, 'OpenClaw'), FIXTURE_RECORDS, { now: NOW });
    expect(state.risk).toBe(232); // static declared 232; the functional leg is blocked and scores 0
    expect(state.age_days).toBe(1); // static ran 2026-08-05, "now" is 2026-08-06
  });

  it('a subject with no completed assay has no age', () => {
    const { state } = subjectHallmark(subjectKey(DEFAULT_ORIGIN, 'Beacon'), FIXTURE_RECORDS, { now: NOW });
    expect(state.static).toBeNull();
    expect(state.functional?.meta.status).toBe('blocked');
    expect(state.age_days).toBeNull();
    expect(state.risk).toBe(0);
  });

  it('lists every subject, risk descending', () => {
    const rows = hallmarks(FIXTURE_RECORDS, { now: NOW });
    // `name` is the key; `label` is the app. The Overview renders the second and links by
    // the first, so the row test asserts on the one a person would read.
    expect(rows.map((r) => r.label)).toContain('Beacon');
    expect(rows[0]?.label).toBe('OpenClaw');
    const risks = rows.map((r) => r.risk);
    expect(risks).toEqual([...risks].sort((a, b) => b - a));
    // every functional leg that exists is blocked except Radarr's — the Overview's story
    const withFunctional = rows.filter((r) => r.functional);
    const blocked = withFunctional.filter((r) => r.functional?.meta.status === 'blocked');
    expect(blocked).toHaveLength(withFunctional.length - 1);
  });
});

describe('ordering', () => {
  it('sorts newest first across both legs', () => {
    const history = sortNewestFirst(FIXTURE_RECORDS.filter((r) => r.subject === 'OpenClaw'));
    const times = history.map((r) => Date.parse(r.meta.finished_at || r.meta.started_at));
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });
});

/**
 * A section that measures rather than judges is invisible to the hallmark, and both halves
 * matter. `scores: false` is written onto the record by the executor, so this needs nothing
 * but the frontmatter the archive already carries.
 */
describe('readings do not move the hallmark', () => {
  const reading = (at: string) =>
    recordFor(
      {
        subject: 'App',
        origin: DEFAULT_ORIGIN,
        section: 'currency',
        standard: 'Image Currency',
        standard_version: 1,
        status: 'done',
        verdict: null,
        top_severity: 'none',
        risk_score: 0,
        scores: false,
        badge: '2 behind · 400d',
        started_at: at,
        finished_at: at,
      },
      `${DEFAULT_ORIGIN}/App/${at.replace(/:/g, '-')}-currency.md`,
    );

  it('does not add to the subject risk', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'static', at: '2026-08-01T00:00:00Z', top_severity: 'major', risk_score: 13 }),
      // Even a reading that *did* record a score must not be summed: the flag decides, so a
      // future scripted check cannot quietly re-rank the Overview by changing its own numbers.
      { ...reading('2026-08-06T00:00:00Z'), meta: { ...reading('2026-08-06T00:00:00Z').meta, risk_score: 999 } },
    ];
    expect(subjectHallmark(APP, records, { now: NOW }).state.risk).toBe(13);
  });

  /**
   * The trap this rule exists for. A currency reading is taken in seconds on every audit; if
   * it could set `age_days` then every app would read as freshly *audited* the moment it was
   * measured, and the age column is exactly what an operator reads to know how stale a
   * verdict is.
   */
  it('does not make the subject look freshly audited', () => {
    const records = [
      makeRecord({ subject: 'App', leg: 'static', at: '2026-07-27T12:00:00Z' }),
      reading('2026-08-06T12:00:00Z'),
    ];
    expect(subjectHallmark(APP, records, { now: NOW }).state.age_days).toBe(10);
  });

  it('still appears as a section, so the page can draw it', () => {
    const records = [reading('2026-08-06T12:00:00Z')];
    const state = subjectHallmark(APP, records, { now: NOW }).state;
    expect(state.sections.currency?.meta.badge).toBe('2 behind · 400d');
    expect(state.age_days).toBeNull();
  });
});

describe('hallmarks({ include })', () => {
  const TRACKED = subjectKey(DEFAULT_ORIGIN, 'Tracked');

  it('composes a row for a subject the archive has never heard of', () => {
    const rows = hallmarks(FIXTURE_RECORDS, { include: [TRACKED], now: NOW });
    const row = rows.find((r) => r.name === TRACKED);
    expect(row).toBeDefined();
    expect(row?.label).toBe('Tracked');
    expect(row?.origin).toBe(DEFAULT_ORIGIN);
    expect(row?.static).toBeNull();
    expect(row?.functional).toBeNull();
    expect(row?.age_days).toBeNull();
    expect(row?.risk).toBe(0);
  });

  /**
   * The overlap is the whole list, normally: every audited app is also a tracked one. If the
   * union deduplicated by identity rather than by key, the Store page would draw every app
   * twice and React would warn about the duplicate keys rather than anyone noticing the
   * counts were wrong.
   */
  it('does not duplicate a subject that is in both the archive and the registry', () => {
    const archived = hallmarks(FIXTURE_RECORDS, { now: NOW });
    const both = hallmarks(FIXTURE_RECORDS, {
      include: archived.map((r) => r.name),
      now: NOW,
    });
    expect(both.length).toBe(archived.length);
    expect(both).toEqual(archived);
  });

  it('leaves the archive-only list untouched when nothing is included', () => {
    expect(hallmarks(FIXTURE_RECORDS, { now: NOW })).toEqual(
      hallmarks(FIXTURE_RECORDS, { include: [], now: NOW }),
    );
  });

  /** A never-run row has no risk, so it must not displace anything that has one. */
  it('sorts a never-run subject below every scored one', () => {
    const rows = hallmarks(FIXTURE_RECORDS, { include: [TRACKED], now: NOW });
    const at = rows.findIndex((r) => r.name === TRACKED);
    expect(rows.slice(0, at).every((r) => r.risk >= 0)).toBe(true);
    expect(rows.filter((r) => r.risk > 0).every((r) => rows.indexOf(r) < at)).toBe(true);
  });
});


/**
 * The mark that qualifies the **subject** rather than the verdict: the store no longer offers
 * this app.
 *
 * Deliberately not derivable here. The archive cannot tell "withdrawn" from "never audited"
 * from "audited and still on sale" — that is the registry's answer, and this file takes it as
 * an input for the same reason it takes `standards` and `versions`: so a row composed in a
 * test is a row composed from records and nothing else.
 */
describe('an app the store no longer offers', () => {
  const GONE = subjectKey(DEFAULT_ORIGIN, 'OpenClaw');

  it('marks the row, and only the row it was told about', () => {
    const rows = hallmarks(FIXTURE_RECORDS, { delisted: [GONE], now: NOW });
    expect(rows.find((r) => r.name === GONE)?.delisted).toBe(true);
    expect(rows.filter((r) => r.delisted)).toHaveLength(1);
  });

  /**
   * Absent, not `false`. A reader cannot otherwise tell a row composed by a caller that asked
   * the question from one composed by a caller that never did — and the second is the normal
   * case in every test and every fixture path.
   */
  it('says nothing at all when the question was not asked', () => {
    for (const row of hallmarks(FIXTURE_RECORDS, { now: NOW })) {
      expect(row.delisted).toBeUndefined();
    }
  });

  /** It is not a verdict, so it moves no verdict: same risk, same age, same order. */
  it('changes nothing else about the row', () => {
    const plain = hallmarks(FIXTURE_RECORDS, { now: NOW });
    const marked = hallmarks(FIXTURE_RECORDS, { delisted: [GONE], now: NOW });
    expect(marked.map((r) => r.name)).toEqual(plain.map((r) => r.name));
    expect(marked.map((r) => r.risk)).toEqual(plain.map((r) => r.risk));
    expect(marked.map((r) => r.age_days)).toEqual(plain.map((r) => r.age_days));
  });
});


/**
 * The badge that qualifies a verdict — "this was reached under a rubric that has since been
 * edited". It reads the **done** record, never the current one: a blocked assay has no
 * verdict to qualify, and the caveat has to keep standing for as long as the verdict on
 * display is the older one. The scheduler's rule is the other way round on purpose (it reads
 * the last attempt), and `domain/standards.ts` explains why they cannot be one predicate.
 */
describe('the standard a verdict was reached under', () => {
  const CURRENT = { static: { sha256: 'aaa' }, functional: { sha256: 'bbb' } };

  function judgedBy(sha: string | undefined, over: Parameters<typeof makeRecord>[0] = { subject: 'App', leg: 'static', at: '2026-08-01T00:00:00Z' }) {
    const rec = makeRecord(over);
    return { ...rec, meta: { ...rec.meta, ...(sha ? { standard_sha256: sha } : {}) } };
  }

  it('says nothing at all when the question is not being asked', () => {
    expect(subjectHallmark(APP, [judgedBy('aaa')], { now: NOW }).state.standard).toBeUndefined();
  });

  it('is current when the hash matches the rubric in force', () => {
    const { state } = subjectHallmark(APP, [judgedBy('aaa')], { now: NOW, standards: CURRENT });
    expect(state.standard).toBe('current');
  });

  it('is older when the rubric has been edited since', () => {
    const { state } = subjectHallmark(APP, [judgedBy('zzz')], { now: NOW, standards: CURRENT });
    expect(state.standard).toBe('older');
  });

  /**
   * "Judged by something else" and "we cannot tell what judged this" are different claims.
   * Every assay written before 2026-08-23 makes the second one.
   */
  it('is unknown when the assay names no revision', () => {
    const { state } = subjectHallmark(APP, [judgedBy(undefined)], { now: NOW, standards: CURRENT });
    expect(state.standard).toBe('unknown');
  });

  it('rolls up worst-first across sections', () => {
    const records = [
      judgedBy('aaa'),
      judgedBy('stale', { subject: 'App', leg: 'functional', at: '2026-08-02T00:00:00Z' }),
    ];
    expect(subjectHallmark(APP, records, { now: NOW, standards: CURRENT }).state.standard).toBe('older');
  });

  it('has nothing to say about a subject with no verdict yet', () => {
    expect(subjectHallmark(APP, [], { now: NOW, standards: CURRENT }).state.standard).toBeUndefined();
  });

  /**
   * A blocked assay is newer than the verdict on display, and the verdict on display is what
   * the badge is about. `legState.hallmark` is the record either way.
   */
  it('qualifies the last verdict even when a newer attempt blocked', () => {
    const records = [
      judgedBy('zzz'),
      makeRecord({
        subject: 'App',
        leg: 'static',
        at: '2026-08-04T00:00:00Z',
        status: 'blocked',
        blocked_reason: 'bench_unavailable',
      }),
    ];
    expect(subjectHallmark(APP, records, { now: NOW, standards: CURRENT }).state.standard).toBe('older');
  });

  /** Invariant 12: a reading is invisible to the hallmark, and this is part of the hallmark. */
  it('ignores a section that measures rather than judges', () => {
    const rec = makeRecord({ subject: 'App', leg: 'currency', at: '2026-08-03T00:00:00Z' });
    const reading = { ...rec, meta: { ...rec.meta, scores: false, standard_sha256: 'stale' } };
    const { state } = subjectHallmark(APP, [judgedBy('aaa'), reading], {
      now: NOW,
      standards: { ...CURRENT, currency: { sha256: 'ccc' } },
    });
    expect(state.standard).toBe('current');
  });

  /** A rubric that no longer exists must not strand a row as permanently out of date. */
  it('ignores a section the protocol directory no longer declares', () => {
    const rec = makeRecord({ subject: 'App', leg: 'retired', at: '2026-08-03T00:00:00Z' });
    const gone = { ...rec, meta: { ...rec.meta, standard_sha256: 'stale' } };
    const { state } = subjectHallmark(APP, [judgedBy('aaa'), gone], { now: NOW, standards: CURRENT });
    expect(state.standard).toBe('current');
  });

  /**
   * A scripted section has two versions and one of them is the procedure. Moving a threshold
   * in the `.sh` changes what the reading means as surely as an edit to the prose beside it.
   */
  it('counts the executor as part of the standard', () => {
    const rec = makeRecord({ subject: 'App', leg: 'static', at: '2026-08-01T00:00:00Z' });
    const scripted = {
      ...rec,
      meta: { ...rec.meta, standard_sha256: 'aaa', executor: 'check.sh', executor_sha256: 'old' },
    };
    const { state } = subjectHallmark(APP, [scripted], {
      now: NOW,
      standards: { static: { sha256: 'aaa', executor_sha256: 'new' } },
    });
    expect(state.standard).toBe('older');
  });
});


/**
 * The second badge. Deliberately a separate field from `standard`: one says the question
 * changed, the other says the subject did, and an app author needs to know which.
 */
describe('the version of the app a verdict was reached about', () => {
  function judgedAgainst(sha: string | undefined, at = '2026-08-01T00:00:00Z') {
    const rec = makeRecord({ subject: 'App', leg: 'static', at });
    return { ...rec, meta: { ...rec.meta, ...(sha ? { subject_sha: sha } : {}) } };
  }

  it('says nothing at all when the question is not being asked', () => {
    const { state } = subjectHallmark(APP, [judgedAgainst('aaa')], { now: NOW });
    expect(state.subject_version).toBeUndefined();
  });

  it('is current when the store offers what was judged', () => {
    const { state } = subjectHallmark(APP, [judgedAgainst('aaa')], {
      now: NOW,
      versions: { [APP]: 'aaa' },
    });
    expect(state.subject_version).toBe('current');
  });

  it('is changed when the compose has moved since', () => {
    const { state } = subjectHallmark(APP, [judgedAgainst('aaa')], {
      now: NOW,
      versions: { [APP]: 'bbb' },
    });
    expect(state.subject_version).toBe('changed');
  });

  /** Both directions of missing are unknown — never changed. This is the whole safeguard. */
  it('is unknown when the assay recorded no version', () => {
    const { state } = subjectHallmark(APP, [judgedAgainst(undefined)], {
      now: NOW,
      versions: { [APP]: 'bbb' },
    });
    expect(state.subject_version).toBe('unknown');
  });

  it('is unknown when the store offers no compose', () => {
    const { state } = subjectHallmark(APP, [judgedAgainst('aaa')], { now: NOW, versions: {} });
    expect(state.subject_version).toBe('unknown');
  });

  it('has nothing to say about a subject with no verdict yet', () => {
    const { state } = subjectHallmark(APP, [], { now: NOW, versions: { [APP]: 'aaa' } });
    expect(state.subject_version).toBeUndefined();
  });

  /** The newest verdict is the one on display, whatever an older one was judged against. */
  it('reads the newest verdict, not an older one', () => {
    const records = [judgedAgainst('old', '2026-07-01T00:00:00Z'), judgedAgainst('aaa', '2026-08-02T00:00:00Z')];
    const { state } = subjectHallmark(APP, records, { now: NOW, versions: { [APP]: 'aaa' } });
    expect(state.subject_version).toBe('current');
  });

  /** The two badges are independent and a row may carry both. */
  /**
   * YAML hands back a **number** for a sha that is all digits — `0000…0` parses as `0` — and
   * a strict `typeof === 'string'` read then answers `unknown` about an app that did change.
   * Found by an end-to-end check whose fixture sha was forty zeroes.
   */
  it('reads a sha YAML decoded as a number rather than calling it unknown', () => {
    const rec = makeRecord({ subject: 'App', leg: 'static', at: '2026-08-01T00:00:00Z' });
    const numeric = { ...rec, meta: { ...rec.meta, subject_sha: 0 as unknown as string } };
    const { state } = subjectHallmark(APP, [numeric], { now: NOW, versions: { [APP]: 'aaa' } });
    expect(state.subject_version).toBe('changed');
  });

  it('is composed alongside the standard badge without disturbing it', () => {
    const rec = makeRecord({ subject: 'App', leg: 'static', at: '2026-08-01T00:00:00Z' });
    const both = { ...rec, meta: { ...rec.meta, standard_sha256: 'stale', subject_sha: 'aaa' } };
    const { state } = subjectHallmark(APP, [both], {
      now: NOW,
      standards: { static: { sha256: 'current-rubric' } },
      versions: { [APP]: 'bbb' },
    });
    expect(state.standard).toBe('older');
    expect(state.subject_version).toBe('changed');
  });
});
