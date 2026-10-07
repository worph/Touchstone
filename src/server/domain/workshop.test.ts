/**
 * The workshop's decisions. Each block pins one rule from docs/auto-app-pr.md that would be
 * easy to get subtly wrong: a rolling quota, a branch name that cannot leave `touchstone/`, a
 * blocked section that is never a pass, and a parked task that waits for its input to change.
 */

import { describe, expect, it } from 'vitest';

import type { AssayRecord, SubjectState } from '../../shared/types.js';
import type { SectionResult, TaskMemory } from '../../shared/workshop.js';
import { asSubjectKey } from '../../shared/subject.js';
import { buildPrBody, PR_BODY_LIMIT, prTitle, regressionLine } from './prbody.js';
import { baselineOf, candidates, crossesMajor, currencyOf, judgeValidation, quota, refFor, regressionsOf, sha256 } from './workshop.js';

const NOW = new Date('2026-10-02T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe('quota', () => {
  it('is a rolling 24 hours', () => {
    expect(quota(1, [], NOW)).toMatchObject({ allowed: true, opened_last_24h: 0 });
    const spent = quota(1, [hoursAgo(5)], NOW);
    expect(spent.allowed).toBe(false);
    expect(spent.next_slot_at).toBe(new Date(NOW.getTime() + 19 * 3_600_000).toISOString());
    expect(quota(1, [hoursAgo(25)], NOW).allowed).toBe(true);
    expect(quota(2, [hoursAgo(5)], NOW).allowed).toBe(true);
  });

  it('0 is the dry run and never allows one', () => {
    expect(quota(0, [], NOW).allowed).toBe(false);
  });
});

describe('refFor', () => {
  it('names a touchstone branch with a collision-proof suffix', () => {
    expect(refFor({ kind: 'fix', app: 'FileBrowser', id: 'abcdef123456' }, NOW)).toBe(
      'refs/heads/touchstone/fix/FileBrowser-20261002-abcdef',
    );
  });

  it('refuses an app name that could walk out of touchstone/', () => {
    expect(() => refFor({ kind: 'fix', app: '../main', id: 'abcdef123456' }, NOW)).toThrow();
    expect(() => refFor({ kind: 'fix', app: 'a/b', id: 'abcdef123456' }, NOW)).toThrow();
  });
});

describe('judgeValidation', () => {
  const r = (section: string, over: Partial<SectionResult> = {}): SectionResult => ({
    section,
    status: 'done',
    verdict: 'compliant',
    risk_score: 0,
    trial: 't',
    ...over,
  });
  const expected = ['static', 'functional', 'functional@foss'];

  it('passes only when every scoring section is done and compliant', () => {
    expect(judgeValidation(expected, expected.map((s) => r(s)))).toEqual({ kind: 'pass' });
  });

  it('a non-compliant section fails the round', () => {
    expect(judgeValidation(expected, [r('static'), r('functional', { verdict: 'non-compliant' }), r('functional@foss')])).toEqual({
      kind: 'fail',
      failing: ['functional'],
    });
  });

  it('a section blocked by infrastructure is never a pass, and is not the author\'s fault', () => {
    const j = judgeValidation(expected, [r('static'), r('functional', { status: 'blocked', verdict: null, blocked_reason: 'bench_unavailable' }), r('functional@foss')]);
    expect(j.kind).toBe('infra');
  });

  it('an unusable agent answer established nothing, so it is a failed round', () => {
    const j = judgeValidation(expected, [r('static'), r('functional', { status: 'blocked', verdict: null, blocked_reason: 'parse_failed' }), r('functional@foss')]);
    expect(j).toEqual({ kind: 'fail', failing: ['functional'] });
  });

  it('a configuration answer stops at once', () => {
    const j = judgeValidation(expected, [r('static'), r('functional', { status: 'blocked', verdict: null, blocked_reason: 'store_url_unconfigured' }), r('functional@foss')]);
    expect(j.kind).toBe('impossible');
  });

  it('a missing section — an evicted trial — is infra', () => {
    expect(judgeValidation(expected, [r('static'), r('functional')]).kind).toBe('infra');
  });
});

describe('currency', () => {
  it('reads only what it needs, defensively', () => {
    const meta = {
      badge_state: 'warn',
      rows: [
        { service: 'app', state: 'behind', days: 40, latest: '2.0.1', pinned: '1.9.0' },
        { service: 'shield', state: 'stale', days: 900, latest: '9', platform: true },
      ],
    } as unknown as AssayRecord['meta'];
    const c = currencyOf(meta);
    expect(c).toMatchObject({ behind: true, worstDays: 40, latest: '2.0.1' });
    expect(currencyOf({ badge_state: 'ok', rows: 'garbage' } as unknown as AssayRecord['meta']).behind).toBe(false);
    expect(crossesMajor('1.9.0', '2.0.1')).toBe(true);
    expect(crossesMajor('v1.9.0', '1.10')).toBe(false);
  });
});

describe('candidates', () => {
  const rec = (section: string, verdict: string, extra: Record<string, unknown> = {}): AssayRecord =>
    ({
      meta: { status: 'done', verdict, risk_score: 0, ...extra },
      path: `${section}.md`,
      subject: asSubjectKey('yundera~X'),
      section,
    }) as unknown as AssayRecord;

  const subject = (name: string, sections: Record<string, AssayRecord | null>, over: Partial<SubjectState> = {}): SubjectState =>
    ({
      name: asSubjectKey(`yundera~${name}`),
      origin: 'yundera',
      label: name,
      sections,
      static: sections.static ?? null,
      functional: sections.functional ?? null,
      risk: 0,
      age_days: 3,
      standard: 'current',
      ...over,
    }) as SubjectState;

  const scoring = new Set(['static', 'functional']);
  const base = {
    origin: 'yundera',
    scoring,
    currencySection: 'currency',
    versions: { 'yundera~Broken': 'v1', 'yundera~Old': 'v2' },
    standardShas: ['s1', 's2'],
    openPrApps: new Set<string>(),
    memory: {} as Record<string, TaskMemory>,
    active: new Set<string>(),
  };

  const broken = subject(
    'Broken',
    {
      static: rec('static', 'non-compliant', { requirements: [{ id: 'auth', verdict: 'fail', severity: 'critical' }] }),
      functional: rec('functional', 'compliant'),
    },
    { risk: 100 },
  );
  const old = subject('Old', {
    static: rec('static', 'compliant'),
    functional: rec('functional', 'compliant'),
    currency: rec('currency', 'compliant', { badge_state: 'bad', rows: [{ state: 'stale', days: 400, latest: '3.0' }] }),
  });

  it('offers fix before currency, both eligible', () => {
    const rows = candidates({ ...base, subjects: [old, broken] });
    expect(rows.map((r) => `${r.kind}:${r.app}:${r.eligible}`)).toEqual(['fix:Broken:true', 'currency:Old:true']);
    expect(rows[1]!.label).toBe('update Old to 3.0');
  });

  it('parks a task tried against the same input, and unparks it when the input changes', () => {
    const first = candidates({ ...base, subjects: [broken] })[0]!;
    const memory = { [first.task_key]: { input_sha: first.input_sha, attempts: 1, last_attempt_at: NOW.toISOString(), outcome: 'cannot' as const } };
    expect(candidates({ ...base, subjects: [broken], memory })[0]!.eligible).toBe(false);
    const moved = candidates({ ...base, subjects: [broken], memory, versions: { 'yundera~Broken': 'v9' } })[0]!;
    expect(moved.eligible).toBe(true);
  });

  it('never offers an app somebody already has a pull request open for, or when that is unknown', () => {
    expect(candidates({ ...base, subjects: [broken], openPrApps: new Set(['Broken']) })[0]!.eligible).toBe(false);
    expect(candidates({ ...base, subjects: [broken], openPrApps: null })[0]!.eligible).toBe(false);
  });

  it('waits for an audit when the verdict is under an older standard', () => {
    const stale = { ...broken, standard: 'older' as const };
    expect(candidates({ ...base, subjects: [stale] })[0]!.reasons.join()).toContain('audit first');
  });

  it('offers a wish only when no store has the app, in file order', () => {
    const wishes = [
      { file: 'b.md', name: 'Bravo', image: 'x', body: '', sha256: sha256('b'), order: 20 },
      { file: 'a.md', name: 'Alpha', image: 'x', body: '', sha256: sha256('a'), order: 10 },
      { file: 'c.md', name: 'Broken', image: 'x', body: '', sha256: sha256('c') },
    ];
    const rows = candidates({ ...base, subjects: [], wishes, offered: new Set(['Broken']) });
    expect(rows.filter((r) => r.eligible).map((r) => r.app)).toEqual(['Alpha', 'Bravo']);
    expect(rows.find((r) => r.app === 'Broken')!.reasons.join()).toContain('already offers');
  });
});

describe('the pull request', () => {
  const proposal = { id: 'abcdef123456', kind: 'fix' as const, app: 'X', summary: 'Pinned the image.', round: 1 };
  const validation: SectionResult[] = [
    { section: 'static', status: 'done', verdict: 'compliant', risk_score: 0, trial: 'X@1', standard_sha256: 'f'.repeat(64) },
  ];

  it('titles each kind', () => {
    expect(prTitle({ kind: 'currency', app: 'X', to_version: '2.0', major: true })).toBe('[touchstone] X: update to 2.0 (major)');
    expect(prTitle({ kind: 'wish', app: 'X' })).toBe('[touchstone] X: add app');
  });

  it('quotes the summary, the section table and before/after findings', () => {
    const body = buildPrBody({
      proposal,
      validation,
      before: [{ section: 'static', id: 'pinned-image-tag', severity: 'major' }],
      after: [],
      reports: [{ section: 'static', text: '# report' }],
    });
    expect(body).toContain('Pinned the image.');
    expect(body).toContain('| static | any | compliant | 0 |');
    expect(body).toContain('| pinned-image-tag | static | major | passes |');
    expect(body).toContain('ffffffffffff');
  });

  it('fits GitHub\'s limit, cutting the reports and saying so', () => {
    const body = buildPrBody({ proposal, validation, reports: [{ section: 'static', text: 'x'.repeat(100_000) }, { section: 'functional', text: 'y' }] });
    expect(body.length).toBeLessThanOrEqual(PR_BODY_LIMIT);
    expect(body).toContain('cut to fit');
    expect(body).toContain('Pinned the image.');
  });
});

describe('D7′ — a change may not make anything worse', () => {
  const S = 'a'.repeat(64);
  const rec = (section: string, requirements: unknown[], over: Record<string, unknown> = {}) =>
    ({ meta: { section, status: 'done', verdict: 'compliant', risk_score: 10, standard_sha256: S, requirements, ...over } }) as never;
  const req = (id: string, verdict: string, severity?: string) => ({ id, verdict, ...(severity ? { severity } : {}) });
  const scoring = new Set(['static', 'functional']);

  it('reduces the archive to what it compares, and leaves out what never ran or does not score', () => {
    const b = baselineOf(
      { static: rec('static', [req('a', 'fail', 'minor'), req('b', 'pass')]), functional: null, currency: rec('currency', []) },
      scoring,
    );
    expect(Object.keys(b)).toEqual(['static']);
    expect(b.static).toEqual({ standard_sha256: S, risk_score: 10, requirements: { a: { verdict: 'fail', severity: 'minor' }, b: { verdict: 'pass' } } });
  });

  const base = baselineOf({ static: rec('static', [req('a', 'fail', 'minor'), req('b', 'pass'), req('c', 'n-a')]) }, scoring);

  it('a requirement that passed and now fails is a regression', () => {
    const r = regressionsOf(base, { static: rec('static', [req('a', 'fail', 'minor'), req('b', 'fail', 'minor')]) });
    expect(r.regressions).toEqual([{ section: 'static', id: 'b', severity: 'minor', was: 'pass' }]);
    expect(r.stale).toEqual([]);
  });

  it('so is one that was not applicable, and one that fails more severely', () => {
    const r = regressionsOf(base, { static: rec('static', [req('a', 'fail', 'major'), req('c', 'fail', 'minor')]) });
    expect(r.regressions.map((x) => [x.id, x.was])).toEqual([
      ['a', 'minor'],
      ['c', 'n-a'],
    ]);
  });

  it('a fix that removes findings, or leaves one as it was, is not', () => {
    expect(regressionsOf(base, { static: rec('static', []) }).regressions).toEqual([]);
    expect(regressionsOf(base, { static: rec('static', [req('a', 'fail', 'minor')]) }).regressions).toEqual([]);
  });

  it('a requirement the baseline never judged counts only under the same standard', () => {
    expect(regressionsOf(base, { static: rec('static', [req('new', 'fail', 'minor')]) }).regressions).toMatchObject([{ id: 'new', was: 'absent' }]);
    const other = regressionsOf(base, { static: rec('static', [req('new', 'fail', 'minor')], { standard_sha256: 'b'.repeat(64) }) });
    expect(other.regressions).toEqual([]);
    expect(other.stale).toEqual(['static']);
  });

  it('with no baseline there is nothing to regress from', () => {
    expect(regressionsOf(undefined, { static: rec('static', [req('b', 'fail', 'minor')]) })).toEqual({ regressions: [], stale: [] });
  });
});

describe('regressionLine', () => {
  const b = { static: { risk_score: 5, requirements: {} } };
  it('says what was compared, and when it was partial', () => {
    expect(regressionLine({})).toContain('only compliance was checked');
    expect(regressionLine({ baseline: b, baseline_stale: [] })).toContain('No requirement got worse');
    expect(regressionLine({ baseline: b, baseline_stale: ['static'] })).toContain('`static` was last audited under an older standard');
  });
});
