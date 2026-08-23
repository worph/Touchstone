import { describe, expect, it } from 'vitest';

import type { AssayMeta, RecordedRequirement } from '../../shared/types.js';
import { buildFixReport, fixReportFilename, hasFixWork, splitRemedy } from './fixreport.js';

function meta(over: Partial<AssayMeta> = {}): AssayMeta {
  return {
    subject: 'SegmentPlayer',
    section: 'static',
    standard: 'Static Review Protocol',
    standard_version: 3,
    status: 'done',
    verdict: 'non-compliant',
    top_severity: 'major',
    risk_score: 12,
    subject_ref: 'Yundera/AppStore@main:Apps/SegmentPlayer',
    started_at: '2026-08-20T10:42:05.509Z',
    finished_at: '2026-08-20T11:06:17.665Z',
    ...over,
  };
}

const req = (over: Partial<RecordedRequirement> & { id: string }): RecordedRequirement => ({
  verdict: 'fail',
  at: '2026-08-20T10:50:00.000Z',
  ...over,
});

describe('splitRemedy', () => {
  it('separates the audit\'s own remedy from its evidence', () => {
    const { evidence, remedy } = splitRemedy(
      'Runs as user: 0:0 while mounting /DATA/Media. Remedy: switch to $PUID:$PGID, or add a rationale.md.',
    );
    expect(evidence).toBe('Runs as user: 0:0 while mounting /DATA/Media.');
    expect(remedy).toBe('switch to $PUID:$PGID, or add a rationale.md.');
  });

  it('keeps the whole note as evidence when no remedy was proposed', () => {
    const note = 'The x-casaos block carries no per-volume descriptions.';
    expect(splitRemedy(note)).toEqual({ evidence: note, remedy: null });
  });

  /** A marker with nothing on one side of it is not a split worth making. */
  it('does not split on a bare marker', () => {
    expect(splitRemedy('Remedy: ').remedy).toBeNull();
    expect(splitRemedy('Fix:').remedy).toBeNull();
  });

  it('handles an absent note', () => {
    expect(splitRemedy(undefined)).toEqual({ evidence: '', remedy: null });
  });
});

describe('hasFixWork', () => {
  it('is false for an app with nothing failing', () => {
    expect(hasFixWork({
      subject: 'Radarr',
      sections: [{ path: 'p', meta: meta({ verdict: 'compliant', requirements: [req({ id: 'cpu-shares', verdict: 'pass' })] }) }],
    })).toBe(false);
  });

  it('is true for a failing requirement, and for a failed phase', () => {
    expect(hasFixWork({
      subject: 'X',
      sections: [{ path: 'p', meta: meta({ requirements: [req({ id: 'permissions', severity: 'major' })] }) }],
    })).toBe(true);
    expect(hasFixWork({
      subject: 'X',
      sections: [
        {
          path: 'p',
          meta: meta({ section: 'functional', phases: [{ phase: 'G', result: 'fail', at: '2026-08-20T11:00:00.000Z' }] }),
        },
      ],
    })).toBe(true);
  });
});

describe('buildFixReport', () => {
  const full = () =>
    buildFixReport({
      subject: 'SegmentPlayer',
      sections: [{
        path: 'SegmentPlayer/2026-08-20T10-42-05.509Z-static.md',
        meta: meta({
          requirements: [
            req({
              id: 'permissions',
              requirement: 'Permission Strategy / deviation table D2',
              severity: 'major',
              note: 'Runs as user: 0:0 while mounting /DATA/Media. Remedy: switch to $PUID:$PGID.',
            }),
            req({ id: 'assets', severity: 'minor', note: 'No thumbnail.png in the app directory.' }),
            req({ id: 'cpu-shares', verdict: 'pass', note: '70 on the backend.' }),
            req({ id: 'install-cmd-security', verdict: 'n-a' }),
          ],
        }),
      }, {
        path: 'SegmentPlayer/2026-08-20T10-42-05.509Z-functional.md',
        meta: meta({
          section: 'functional',
          standard: 'Functional Review Protocol',
          standard_version: 2,
          verdict: 'compliant',
          top_severity: 'none',
          risk_score: 0,
          phases: [
            { phase: 'A', result: 'pass', at: '2026-08-20T10:45:00.000Z' },
            { phase: 'G', result: 'pass', at: '2026-08-20T11:05:00.000Z' },
          ],
        }),
      }],
    })!;

  it('names the repository, the path and the standard that judged it', () => {
    const md = full();
    expect(md).toContain('`Yundera/AppStore` at ref `main`');
    expect(md).toContain('`Apps/SegmentPlayer`');
    expect(md).toContain('Static Review Protocol v3');
    expect(md).toContain('Functional Review Protocol v2');
  });

  it('lists the findings worst-first, with the evidence quoted', () => {
    const md = full();
    expect(md.indexOf('`permissions`')).toBeLessThan(md.indexOf('`assets`'));
    expect(md).toContain('### 1. `permissions` — MAJOR');
    expect(md).toContain('> Runs as user: 0:0 while mounting /DATA/Media.');
  });

  it('quotes the remedy the audit proposed, and admits when there is none', () => {
    const md = full();
    expect(md).toContain('> switch to $PUID:$PGID.');
    expect(md).toContain('the audit did not propose one');
  });

  it('ends with the requirement ids as acceptance criteria', () => {
    const md = full();
    const acceptance = md.slice(md.indexOf('## Acceptance'));
    expect(acceptance).toContain('- `permissions`');
    expect(acceptance).toContain('- `assets`');
    expect(acceptance).not.toContain('- `cpu-shares`');
  });

  it('lists what already passes so a fix does not regress it', () => {
    expect(full()).toContain('## Already passing — do not regress (1)');
  });

  /** Invariant 6, on the way out: the document reports the gate, it does not restate a verdict. */
  it('says a Critical is unconditional, and only when there is one', () => {
    expect(full()).not.toContain('Critical.**');
    const withCritical = buildFixReport({
      subject: 'OpenClaw',
      sections: [{
        path: 'p',
        meta: meta({
          top_severity: 'critical',
          requirements: [req({ id: 'data-loss', severity: 'critical', note: 'State is not mapped under /DATA/AppData.' })],
        }),
      }],
    })!;
    expect(withCritical).toContain('1 of these is Critical');
    expect(withCritical).toContain('unconditional');
  });

  /** Invariant 4: blocked is never a statement about the subject. */
  it('says plainly that a blocked section checked nothing', () => {
    const md = buildFixReport({
      subject: 'Prowlarr',
      sections: [
        { path: 'p', meta: meta({ requirements: [req({ id: 'permissions', severity: 'major' })] }) },
        {
          path: 'q',
          meta: meta({ section: 'functional', status: 'blocked', verdict: null, blocked_reason: 'bench_unavailable', top_severity: 'none', risk_score: 0 }),
        },
      ],
    })!;
    expect(md).toContain('could not run (`bench_unavailable`)');
    expect(md).toContain('not about this app');
  });

  it('names the failed phases as behaviour, not paperwork', () => {
    const md = buildFixReport({
      subject: 'X',
      sections: [{
        path: 'p',
        meta: meta({
          section: 'functional',
          phases: [
            { phase: 'A', result: 'pass', at: '2026-08-20T10:45:00.000Z' },
            { phase: 'G', result: 'fail', note: 'The library was empty after a reinstall.', at: '2026-08-20T11:05:00.000Z' },
          ],
        }),
      }],
    })!;
    expect(md).toContain('**Phase G — data persistence** — fail: The library was empty after a reinstall.');
  });

  it('is null when nothing has ever been assayed', () => {
    expect(buildFixReport({ subject: 'Immich', sections: [] })).toBeNull();
  });

  it('names the report files it was composed from', () => {
    expect(full()).toContain('`SegmentPlayer/2026-08-20T10-42-05.509Z-static.md`');
  });

  it('names the download after the subject', () => {
    expect(fixReportFilename('SegmentPlayer')).toBe('SegmentPlayer-fix.md');
  });
});

/**
 * Acceptance is a list of what to fix, not a promise of what it buys.
 *
 * Of the eight apps taken to compliant on 2026-08-22, AIOStreams needed two rounds and
 * ChronosMCP three — each time because clearing one finding let the audit reach a check it
 * had not been able to run before. A brief that says "fix these and you are done" trains a
 * reader to commit after one round and to read the second round as the audit changing its
 * mind.
 */
describe('what acceptance promises', () => {
  const brief = (requirements: RecordedRequirement[]) =>
    buildFixReport({ subject: 'SegmentPlayer', sections: [{ path: 'p', meta: meta({ requirements }) }] }) ?? '';

  it('lists the ids without claiming they are sufficient', () => {
    const out = brief([req({ id: 'cpu-shares', severity: 'major', note: 'not set on either service' })]);
    expect(out).toContain('`cpu-shares`');
    expect(out).toContain('not a guarantee of compliance');
    // The two reasons the next round can grow, named rather than hinted at.
    expect(out).toMatch(/behind a failure/i);
    expect(out).toMatch(/does not list/i);
  });

  it('no longer promises that the same ids passing means done', () => {
    const out = brief([req({ id: 'cpu-shares', severity: 'major' })]);
    expect(out).not.toContain('The change is complete when');
  });

  it('says nothing of the sort when there is nothing to fix', () => {
    const out = brief([req({ id: 'cpu-shares', verdict: 'pass' })]);
    expect(out).not.toContain('not a guarantee of compliance');
  });
});
