/**
 * Unit tests for the importer's parsers, on the exact shapes the corpus actually contains.
 *
 * These are the pieces most likely to rot silently: the reports are prose, so a parser can
 * quietly stop matching one of four equivalent phrasings and nothing downstream complains.
 * Each case below is copied from a real page.
 */

import { describe, expect, it } from 'vitest';

import { parseHeadline, parsePhases, parseRollup, shapeReport } from '../tools/extract.js';

describe('the roll-up table', () => {
  const md = `
| # | App | Result | Risk | Last run | Report |
| --- | --- | --- | --- | --- | --- |
| 3 | Beacon | ⛔ non-compliant · Minor | 2 | 2026-07-31 | [report](https://docmost-yunderalabs.nsl.sh/s/general/p/9koVmWR622) |
| 11 | ConvertX | ⚠️ errored · stuck after 3 tries | — | 2026-08-02 | — |
| 69 | qBittorrent | ⚠️ errored · try 1 | — | 2026-08-04 | — |
`;

  it('reads verdict, severity, risk, date and slug', () => {
    const rows = parseRollup(md);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      n: 3,
      subject: 'Beacon',
      kind: 'non-compliant',
      severity: 'minor',
      risk: 2,
      lastRun: '2026-07-31',
      slug: '9koVmWR622',
    });
  });

  it('keeps a subject that has no report page, with no risk', () => {
    const rows = parseRollup(md);
    expect(rows[2]).toMatchObject({ subject: 'qBittorrent', kind: 'errored', risk: null, slug: null });
  });
});

describe('the report headline', () => {
  it('reads the inline "Verdict: … risk_score N" form', () => {
    const h = parseHeadline(
      '# Yundera/AppStore — Prowlarr\n\n**Verdict: ERRORED · top severity Major · risk_score 13**\n\n' +
        '*Audit date:* 2026-08-06 · *Store version:* `lscr.io/linuxserver/prowlarr:2.4.0` · ' +
        '*Compose blob sha:* `eac8444b8965343a28a63566f3cf1e49c0867ab9` · *Ref:* `main` · *Scope:* `n-a`\n',
    );
    expect(h).toMatchObject({
      verdict: 'errored',
      topSeverity: 'major',
      riskScore: 13,
      auditDate: '2026-08-06',
      images: ['lscr.io/linuxserver/prowlarr:2.4.0'],
      composeSha: 'eac8444b8965343a28a63566f3cf1e49c0867ab9',
      ref: 'main',
      scope: 'n-a',
    });
  });

  it('reads the metadata-line-then-"## Verdict"-heading form', () => {
    const h = parseHeadline(
      '# Yundera/AppStore — Radarr\n\n**Audit date:** 2026-08-06 · **Store version:** ' +
        '`lscr.io/linuxserver/radarr:6.2.1` · **Compose blob sha:** `26edb82f30b2` · **Scope:** `n-a`\n\n' +
        '## Verdict\n\n### NON-COMPLIANT · Critical · risk score 115\n',
    );
    expect(h).toMatchObject({
      verdict: 'non-compliant',
      topSeverity: 'critical',
      riskScore: 115,
      auditDate: '2026-08-06',
    });
  });
});

describe('the two legs', () => {
  it('splits on the leg headings whatever the parenthetical says', () => {
    for (const heading of [
      '## Tech & Documentation (Static)',
      '## Tech & Documentation (static leaf — completed)',
      '## Tech & Documentation (Static Review Protocol · LPwfKYUVig)',
      '## Tech & Documentation — static results',
    ]) {
      const shape = shapeReport(`${heading}\n\nbody\n\n## Functionality\n\nphases\n`);
      expect(shape.staticSection?.text).toContain('body');
      expect(shape.functionalSection?.text).toContain('phases');
    }
  });

  it('folds a hoisted "## Findings" section back into the static leg', () => {
    // FileBrowser's layout: the findings live *after* Functionality but are static items.
    const shape = shapeReport(
      '## Tech & Documentation — static results\n\nchecklist\n\n' +
        '## Functionality\n\nphases\n\n' +
        '## Findings\n\n### F3 — `cpu_shares: 10` is the wrong tier · **Minor**\n\ntext\n',
    );
    expect(shape.staticSection?.text).toContain('F3');
    expect(shape.functionalSection?.text).not.toContain('F3');
  });
});

describe('phase tables', () => {
  it('reads pass/fail/errored/n-a in every emphasis style the corpus uses', () => {
    const phases = parsePhases(`
| Phase | Result | Note |
| --- | --- | --- |
| **A — Session** | **pass** | Dashboard reached. |
| C — Fresh install (+ duration) | **errored** | \`no-demo-available\` |
| E9 — Auth gate | ❌ **fail · Critical** | No auth gate. |
| G-prime — Migration | n-a | No PRIOR_VERSION supplied |
| H — Cleanup | pass | Nothing was installed. |
`);
    expect(phases.map((p) => [p.code, p.result])).toEqual([
      ['A', 'pass'],
      ['C', 'errored'],
      ['E9', 'fail'],
      ['G′', 'n-a'],
      ['H', 'pass'],
    ]);
  });
});
