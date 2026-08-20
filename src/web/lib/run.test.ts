import { describe, expect, it } from 'vitest';

import type { LastRun, RunLive, RunProgress } from '@shared/activity';
import {
  describeLast,
  documentTitle,
  elapsedSeconds,
  liveLegs,
  mmss,
  nowDoing,
  phaseTrack,
  progressLabel,
  progressRatio,
} from './run';

const live = (over: Partial<RunLive> = {}): RunLive => ({
  subject: 'SegmentPlayer',
  sections: ['static', 'functional'],
  started_at: '2026-08-20T10:00:00.000Z',
  ...over,
});

const PLAN = [
  { id: 'A', label: 'session' },
  { id: 'C', label: 'fresh install' },
  { id: 'D', label: 'discover URL' },
  { id: 'E8', label: 'works immediately' },
  { id: 'E9', label: 'auth gate' },
  { id: 'E10', label: 'clean boot' },
  { id: 'F', label: 'zero-config usability' },
  { id: 'G', label: 'data persistence' },
];

const progress = (over: Partial<RunProgress> = {}): RunProgress => ({
  phase_plan: [],
  verified: 0,
  applicable: 0,
  passed: 0,
  failed: 0,
  unverified: 0,
  not_applicable: 0,
  risk: 0,
  of_canonical: 0,
  phases: [],
  recent: [],
  ...over,
});

const NOW = Date.parse('2026-08-20T10:04:12.000Z');

describe('mmss', () => {
  it('pads the seconds', () => {
    expect(mmss(252)).toBe('4:12');
    expect(mmss(60)).toBe('1:00');
    expect(mmss(9)).toBe('0:09');
  });

  it('never renders a negative clock', () => {
    expect(mmss(-30)).toBe('0:00');
  });
});

describe('elapsedSeconds', () => {
  it('counts from the start stamp', () => {
    expect(elapsedSeconds('2026-08-20T10:00:00.000Z', NOW)).toBe(252);
  });

  it('is zero for a stamp it cannot parse', () => {
    expect(elapsedSeconds('not a date', NOW)).toBe(0);
    expect(elapsedSeconds(undefined, NOW)).toBe(0);
  });
});

describe('liveLegs', () => {
  it('is the sections the run is actually attempting', () => {
    expect(liveLegs(live())).toEqual(['static', 'functional']);
  });

  /**
   * Invariant 2: an unavailable resource costs one section, and the UI must say so at once —
   * a cell marked running for a section nobody is running is a lie it maintains for four more
   * minutes and then contradicts.
   */
  it('leaves out a section that was skipped for want of a bench', () => {
    expect(
      liveLegs(
        live({
          sections: ['static'],
          blocked: [{ section: 'functional', reason: 'bench_unavailable' }],
        }),
      ),
    ).toEqual(['static']);
  });

  it('is empty for a run that has not chosen its sections yet', () => {
    expect(liveLegs(live({ sections: undefined as never }))).toEqual([]);
  });

  it('nothing running is no sections', () => {
    expect(liveLegs(null)).toEqual([]);
  });
});

describe('progress', () => {
  it('labels verified against the canonical count', () => {
    expect(progressLabel(progress({ verified: 7, of_canonical: 24 }))).toBe('7/24');
    expect(progressRatio(progress({ verified: 6, of_canonical: 24 }))).toBeCloseTo(0.25);
  });

  it('says nothing before the protocol has been counted', () => {
    expect(progressLabel(progress())).toBe('');
    expect(progressRatio(progress())).toBeNull();
    expect(progressLabel(null)).toBe('');
  });

  it('cannot exceed one when the agent records more than the protocol listed', () => {
    expect(progressRatio(progress({ verified: 30, of_canonical: 24 }))).toBe(1);
  });
});

describe('phaseTrack', () => {
  it('is the plan the protocol declared, in order, reached or not', () => {
    const track = phaseTrack(live(), progress({
      phase_plan: PLAN,
      phases: [
        { phase: 'A', result: 'pass', at: '2026-08-20T10:01:00.000Z' },
        { phase: 'C', result: 'pass', at: '2026-08-20T10:03:00.000Z' },
      ],
    }));
    expect(track.map((p) => p.id)).toEqual(['A', 'C', 'D', 'E8', 'E9', 'E10', 'F', 'G']);
    expect(track[0]?.result).toBe('pass');
    expect(track[2]?.result).toBeUndefined();
    expect(track[4]?.label).toBe('auth gate');
  });

  it('is empty for a run whose sections declare no phases', () => {
    expect(phaseTrack(live({ sections: ['static'] }), progress())).toEqual([]);
  });
});

describe('nowDoing', () => {
  it('reports the newer of the two streams', () => {
    const p = progress({
      phases: [{ phase: 'E9', result: 'pass', at: '2026-08-20T10:04:00.000Z' }],
      recent: [{ id: 'image-tag-pinned', verdict: 'fail', at: '2026-08-20T10:02:00.000Z' }],
    });
    expect(nowDoing(p)).toBe('E9 auth gate — pass');
  });

  it('falls back to the requirement when it is the newer', () => {
    const p = progress({
      phases: [{ phase: 'A', result: 'pass', at: '2026-08-20T10:01:00.000Z' }],
      recent: [{ id: 'volumes-under-appdata', verdict: 'pass', at: '2026-08-20T10:03:30.000Z' }],
    });
    expect(nowDoing(p)).toBe('volumes-under-appdata — pass');
  });

  it('says nothing when nothing has been settled', () => {
    expect(nowDoing(progress())).toBeNull();
    expect(nowDoing(null)).toBeNull();
  });
});

describe('describeLast', () => {
  const base = {
    subject: 'Ntfy',
    sections: ['static'],
    started_at: '2026-08-20T09:43:36.691Z',
    finished_at: '2026-08-20T09:51:47.492Z',
  };

  it('reports a verdict with its risk', () => {
    const last: LastRun = { ...base, outcome: { kind: 'verdict', verdict: 'non-compliant', risk: 4, files: [] } };
    expect(describeLast(last)).toBe('last run: non-compliant · risk 4');
  });

  /** Invariant 3: neither of these is a statement about the subject. */
  it('a busy agent and a block never read as a failure', () => {
    expect(describeLast({ ...base, outcome: { kind: 'agent_busy' } })).toContain('nothing was charged');
    expect(describeLast({ ...base, outcome: { kind: 'blocked', reason: 'bench_unavailable' } }))
      .toBe('last run: could not start (bench unavailable)');
  });
});

describe('documentTitle', () => {
  it('carries the subject and the clock into a background tab', () => {
    expect(documentTitle(live(), progress({ verified: 7, of_canonical: 24 }), NOW))
      .toBe('◴ SegmentPlayer · 7/24 · 4:12 — Touchstone');
  });

  it('drops the fraction before the protocol has been counted', () => {
    expect(documentTitle(live(), progress(), NOW)).toBe('◴ SegmentPlayer · 4:12 — Touchstone');
  });

  it('is the plain name when nothing is running', () => {
    expect(documentTitle(null, null, NOW)).toBe('Touchstone');
  });
});
