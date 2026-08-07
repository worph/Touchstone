/**
 * Unit tests for the importer's parsers, on the exact shapes the corpus actually contains.
 *
 * These are the pieces most likely to rot silently: the reports are prose, so a parser can
 * quietly stop matching one of four equivalent phrasings and nothing downstream complains —
 * a finding simply stops existing. Each case below is copied from a real page.
 */

import { describe, expect, it } from 'vitest';

import { loadStandards } from '../src/server/store/config.js';
import {
  chopItems,
  compileRules,
  extractFindings,
  matchRule,
  parseHeadline,
  parsePhases,
  parseRollup,
  shapeReport,
} from '../tools/extract.js';
import { fileURLToPath, URL } from 'node:url';

const STANDARDS = fileURLToPath(new URL('../data/standards', import.meta.url));
const standards = await loadStandards(STANDARDS);
const staticRules = compileRules(standards.find((s) => s.leg === 'static')!.rules);

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

describe('items and rules', () => {
  it('reads a table row whose verdict and severity are emphasised', () => {
    const items = chopItems(
      '| Checklist item | Verdict | Severity | Note |\n| --- | --- | --- | --- |\n' +
        '| `cpu_shares` set on every service | **fail** | **Minor** | Present but `cpu_shares: 10` = the *System Background (Reserved)* tier. |\n',
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe('cpu_shares set on every service');
    expect(items[0]!.status).toBe('fail');
    expect(matchRule(`${items[0]!.title}\n${items[0]!.note}`, staticRules)?.code).toBe('CPU2');
  });

  it('codes every phrasing of the reserved-tier finding onto CPU2', () => {
    for (const text of [
      '**2. `cpu_shares: 10` is the reserved System-Background tier — Minor**',
      'CPU Share Guidelines — wrong tier — ❌ FAIL · Minor\n`cpu_shares: 10`, which CONTRIBUTING reserves for “System Background (Reserved)”.',
      'F3 — `cpu_shares: 10` is the wrong tier · **Minor**',
      '`cpu_shares: 10` on `redis` and `cron` uses the reserved tier — Minor.',
    ]) {
      expect(matchRule(text, staticRules)?.code, text).toBe('CPU2');
    }
  });

  it('keeps missing, reserved-tier and wrong-tier apart', () => {
    expect(matchRule('`cpu_shares` set appropriately on all services\nThe compose contains zero `cpu_shares` entries.', staticRules)?.code).toBe('CPU1');
    expect(matchRule('`cpu_shares: 50` below the documented web-server tier — Minor', staticRules)?.code).toBe('CPU3');
  });

  it('drops evidence bullets that carry no severity', () => {
    const findings = extractFindings(
      '## Tech\n\n### Failing checklist items\n\n' +
        '**1. Security checklist — an authentication method is enabled — ❌ FAIL · Critical**\n\n' +
        'The compose ships no auth layer.\n\n' +
        '- `GET /` → **HTTP 200**, full UI rendered, no login, no redirect.\n' +
        '- `GET /settings/general` → **HTTP 200** unauthenticated.\n',
      { rules: staticRules },
    );
    expect(findings.map((f) => f.rule)).toEqual(['SEC1']);
    expect(findings[0]!.status).toBe('fail');
    expect(findings[0]!.severity).toBe('critical');
  });

  it('lets the specific code supersede the general one within a report', () => {
    const findings = extractFindings(
      '## Tech\n\n### Failing items\n\n' +
        '| Item | Verdict | Severity | Note |\n| --- | --- | --- | --- |\n' +
        '| `cpu_shares` set appropriately on all services | **fail** | **Minor** | see below |\n\n' +
        '- **F5 — `cpu_shares: 10` is the reserved tier. Severity: Minor.**\n',
      { rules: staticRules },
    );
    expect(findings.filter((f) => f.rule.startsWith('CPU'))).toHaveLength(1);
    expect(findings.find((f) => f.rule.startsWith('CPU'))!.rule).toBe('CPU2');
  });

  it('recognises the family sentence that names other affected subjects', () => {
    const cpu2 = staticRules.find((r) => r.code === 'CPU2')!;
    const prowlarr =
      '*Context, not an excuse:* this is a family-wide convention — Radarr, Sonarr, Lidarr and qBittorrent all ship `cpu_shares: 10`.';
    const radarr =
      'Note this is a repo-wide `*arr` convention (Sonarr, Lidarr, Prowlarr, qBittorrent are all `10`), so the fix likely belongs to the whole family.';

    const named = (text: string): string[] => {
      for (const re of cpu2.family) {
        const m = re.exec(text);
        if (m?.[1]) return m[1].split(/,| and | & /).map((s) => s.trim()).filter(Boolean);
      }
      return [];
    };

    expect(named(prowlarr)).toEqual(['Radarr', 'Sonarr', 'Lidarr', 'qBittorrent']);
    expect(named(radarr)).toEqual(['Sonarr', 'Lidarr', 'Prowlarr', 'qBittorrent']);
  });
});

describe('the rule vocabulary itself', () => {
  it('has unique codes that never collide across the two standards', () => {
    const codes = standards.flatMap((s) => s.rules.map((r) => r.code));
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('gives every rule a title and a severity', () => {
    for (const s of standards) {
      for (const r of s.rules) {
        expect(r.title, r.code).toBeTruthy();
        expect(['none', 'minor', 'major', 'critical'], r.code).toContain(r.severity);
      }
    }
  });

  it('compiles every match/exclude/family pattern', () => {
    for (const s of standards) {
      for (const r of s.rules) {
        for (const p of [...(r.match ?? []), ...(r.exclude ?? []), ...(r.family ?? [])]) {
          expect(() => new RegExp(p, 'i'), `${r.code}: ${p}`).not.toThrow();
        }
      }
    }
  });

  it('only supersedes codes that exist', () => {
    const codes = new Set(standards.flatMap((s) => s.rules.map((r) => r.code)));
    for (const s of standards) {
      for (const r of s.rules) {
        for (const c of r.supersedes ?? []) expect(codes, `${r.code} supersedes`).toContain(c);
      }
    }
  });
});
