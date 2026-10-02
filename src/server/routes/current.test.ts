/**
 * `GET /assays/current` — the one endpoint the whole UI reads to say what is happening.
 *
 * Four surfaces are wired to it (the strip in the shell, the Overview's running cells, the
 * Activity card and the audit buttons), so a field that quietly stops being sent stops four
 * things at once. These tests hold the shape.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunLive, RunStatus } from '../../shared/activity.js';
import { EventLog } from '../services/events.js';
import { RunLedger, type CanonicalRequirement } from '../services/ledger.js';
import routes from './index.js';

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
let app: FastifyInstance;

/** Just enough of a runner for the route: `status()` and `enabled` are all it reads. */
function fakeRunner(runs: RunLive[]) {
  return {
    enabled: true,
    status: () => ({ runs, last: null }),
  } as never;
}

/** A run in flight, with the id the runner would give it. */
function live(run: Omit<RunLive, 'id'> & { target?: string }): RunLive {
  return { id: `${run.subject}@${run.target ?? 'yundera'}`, ...run };
}

async function build(running: RunLive | RunLive[] | null, targets?: unknown) {
  const runs = running === null ? [] : Array.isArray(running) ? running : [running];
  const instance = Fastify();
  await instance.register(routes, {
    prefix: '/api/v1',
    ledger,
    runner: fakeRunner(runs),
    ...(targets ? { targets: { health: () => [], ...(targets as object) } as never } : {}),
  });
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-current-'));
  events = new EventLog(dir);
  ledger = new RunLedger({ events });
});

afterEach(async () => {
  await events.flush();
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

async function read(): Promise<RunStatus> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/assays/current' });
  expect(res.statusCode).toBe(200);
  return res.json() as RunStatus;
}

describe('GET /assays/current', () => {
  it('reports nothing running as nothing running, not as an error', async () => {
    app = await build(null);
    const body = await read();
    expect(body.runs).toEqual([]);
    expect(body.enabled).toBe(true);
  });

  it('carries what the run is doing, not only how far along it is', async () => {
    const ticket = ledger.open({
      subject: 'SegmentPlayer',
      run: 'SegmentPlayer@yundera',
      sections: SECTIONS,
      canonical: CANONICAL,
    });
    ledger.recordRequirement(ticket.token, { id: 'cpu-shares', verdict: 'pass' });
    ledger.recordRequirement(ticket.token, { id: 'pinned-image-tag', verdict: 'fail', severity: 'major' });
    ledger.recordPhase(ticket.token, { phase: 'A', result: 'pass' });

    app = await build(live({
      subject: 'SegmentPlayer',
      started_at: '2026-08-20T10:24:28.022Z',
      sections: ['static', 'functional'],
      bench: 'https://demostaging1.inojob.com',
      browser: 'http://touchstone-browser:9746/mcp',
    }));

    const run = (await read()).runs[0];
    const body = { running: run, progress: run?.progress };
    expect(body.running?.subject).toBe('SegmentPlayer');
    expect(body.running?.bench).toBe('https://demostaging1.inojob.com');
    expect(body.progress?.verified).toBe(2);
    expect(body.progress?.of_canonical).toBe(CANONICAL.length);
    expect(body.progress?.risk).toBe(10);
    expect(body.progress?.phases).toEqual([
      expect.objectContaining({ phase: 'A', result: 'pass', section: 'functional' }),
    ]);
    // The plan comes from the protocol, so the page can draw the track before the first
    // phase is reported — and draws none at all for a run whose sections have no phases.
    expect(body.progress?.phase_plan.map((p) => p.id)).toEqual(['A', 'C', 'D']);
    /**
     * The same work split by owner. The merged `2 of 3` above is true of the run and of
     * neither section — `static` is two-of-two done while `functional` has not started, and
     * a card with one bar cannot say that. The plan rides on the section that declared it,
     * so the track is drawn under `functional` rather than floating beside the whole run.
     */
    expect(body.progress?.sections).toEqual([
      { id: 'static', verified: 2, failed: 1, of_canonical: 2, phase_plan: [] },
      {
        id: 'functional',
        verified: 0,
        failed: 0,
        of_canonical: 1,
        phase_plan: [
          { id: 'A', label: 'session' },
          { id: 'C', label: 'fresh install' },
          { id: 'D', label: 'discover URL' },
        ],
      },
    ]);
    // Newest first, so the UI's "what it is doing now" is the head of the list.
    expect(body.progress?.recent[0]?.id).toBe('pinned-image-tag');
  });

  /** A run with a skipped section must not have the UI drawing a track nobody is running. */
  it('reports the sections actually running, and the ones it skipped', async () => {
    app = await build(live({
      subject: 'SegmentPlayer',
      started_at: '2026-08-20T10:24:28.022Z',
      sections: ['static'],
      blocked: [{ section: 'functional', reason: 'bench_unavailable' }],
      degraded_reason: 'bench_unavailable',
      bench: null,
      browser: null,
    }));
    const body = { running: (await read()).runs[0] };
    expect(body.running?.sections).toEqual(['static']);
    expect(body.running?.blocked).toEqual([{ section: 'functional', reason: 'bench_unavailable' }]);
    expect(body.running?.degraded_reason).toBe('bench_unavailable');
  });

  it('sends at most a handful of recent requirements — it is a pulse, not a report', async () => {
    const many: CanonicalRequirement[] = Array.from({ length: 12 }, (_, i) => ({
      id: `rule-${i}`,
      text: `rule ${i}`,
      section: 'static',
    }));
    const ticket = ledger.open({ subject: 'Ntfy', run: 'Ntfy@yundera', sections: [SECTIONS[0]!], canonical: many });
    for (const r of many) ledger.recordRequirement(ticket.token, { id: r.id, verdict: 'pass' });

    app = await build(live({ subject: 'Ntfy', started_at: '2026-08-20T10:24:28.022Z', sections: ['static'] }));
    const body = { progress: (await read()).runs[0]?.progress };
    expect(body.progress?.verified).toBe(12);
    expect(body.progress?.recent.length).toBeLessThanOrEqual(5);
    expect(body.progress?.recent[0]?.id).toBe('rule-11');
  });

  /**
   * Two runs at once — one per platform, or two apps on two benches. Each carries its own
   * ledger progress: a merged bar would be true of neither, and the same app running on both
   * platforms must not show one run's requirements under the other.
   */
  it('reports every run in flight, each with its own progress', async () => {
    const yundera = ledger.open({ subject: 'Ntfy', run: 'Ntfy@yundera', sections: [SECTIONS[0]!], canonical: CANONICAL });
    ledger.recordRequirement(yundera.token, { id: 'cpu-shares', verdict: 'pass' });
    ledger.open({ subject: 'Ntfy', run: 'Ntfy@foss', sections: [SECTIONS[1]!], canonical: CANONICAL });

    app = await build(
      [
        live({ subject: 'Ntfy', started_at: '2026-10-02T09:00:00Z', sections: ['static'] }),
        live({ subject: 'Ntfy', started_at: '2026-10-02T09:01:00Z', sections: ['functional@foss'], target: 'foss' }),
      ],
      { windows: () => [], health: () => [{ id: 'foss', label: 'FOSS stack' }] },
    );
    const body = await read();
    expect(body.runs.map((r) => r.id)).toEqual(['Ntfy@yundera', 'Ntfy@foss']);
    expect(body.runs[0]?.progress?.verified).toBe(1);
    expect(body.runs[1]?.progress?.verified).toBe(0);
    expect(body.runs[1]?.target_label).toBe('FOSS stack');
  });
});

/**
 * The demo pool rides this endpoint because every surface that offers to *start* a run already
 * subscribes to it.
 *
 * The re-assay button used to fetch `GET /benches` once on mount and keep a single boolean, so
 * its "no bench" note was a snapshot from page load — and on 2026-08-23 an operator acted on
 * one that had been false for five minutes.
 */
describe('the demo pool, on the endpoint the whole UI already polls', () => {
  it('carries how many benches are claimable and when that changes', async () => {
    const instance = await build(null, {
      windows: () => [
        {
          target: 'yundera',
          label: 'Yundera PCS',
          leasable: 1,
          window: 'demostaging1 is usable for another 92 min, until its wipe at ~14:59 UTC',
        },
      ],
    });
    const res = await instance.inject({ method: 'GET', url: '/api/v1/assays/current' });
    const body = res.json() as RunStatus;
    expect(body.benches).toEqual([
      {
        target: 'yundera',
        label: 'Yundera PCS',
        leasable: 1,
        window: 'demostaging1 is usable for another 92 min, until its wipe at ~14:59 UTC',
      },
    ]);
    await instance.close();
  });

  /**
   * One press asks for an audit on every platform, so a control that said "no usable bench"
   * off the demo pool alone would be silent about the line that had actually stopped.
   */
  it('carries one entry per pool, so a control can say which line is held', async () => {
    const instance = await build(null, {
      windows: () => [
        { target: 'yundera', label: 'Yundera PCS', leasable: 2, window: 'two benches free' },
        { target: 'foss', label: 'FOSS stack', leasable: 0, window: 'no FOSS bench is answering' },
      ],
    });
    const body = (await instance.inject({ method: 'GET', url: '/api/v1/assays/current' })).json() as RunStatus;
    expect(body.benches?.filter((p) => p.leasable === 0).map((p) => p.label)).toEqual(['FOSS stack']);
    await instance.close();
  });

  /** No prober wired is a real configuration, not a dead pool: say nothing rather than "0". */
  it('omits the pool entirely when nothing can be asked', async () => {
    const instance = await build(null);
    const body = (await instance.inject({ method: 'GET', url: '/api/v1/assays/current' })).json() as RunStatus;
    expect(body.benches).toBeUndefined();
    await instance.close();
  });
});
