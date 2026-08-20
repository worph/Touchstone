/**
 * `GET /assays/current` — the one endpoint the whole UI reads to say what is happening.
 *
 * Four surfaces are wired to it (the strip in the shell, the Overview's running cells, the
 * Activity card and the re-assay button), so a field that quietly stops being sent stops four
 * things at once. These tests hold the shape.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RunStatus } from '../../shared/activity.js';
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
function fakeRunner(running: RunStatus['running']) {
  return {
    enabled: true,
    busy: Boolean(running),
    status: () => ({ running, last: null }),
  } as never;
}

async function build(running: RunStatus['running']) {
  const instance = Fastify();
  await instance.register(routes, { prefix: '/api/v1', ledger, runner: fakeRunner(running) });
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
    expect(body.running).toBeNull();
    expect(body.progress).toBeNull();
    expect(body.enabled).toBe(true);
  });

  it('carries what the run is doing, not only how far along it is', async () => {
    const ticket = ledger.open({ subject: 'SegmentPlayer', sections: SECTIONS, canonical: CANONICAL });
    ledger.recordRequirement(ticket.token, { id: 'cpu-shares', verdict: 'pass' });
    ledger.recordRequirement(ticket.token, { id: 'pinned-image-tag', verdict: 'fail', severity: 'major' });
    ledger.recordPhase(ticket.token, { phase: 'A', result: 'pass' });

    app = await build({
      subject: 'SegmentPlayer',
      started_at: '2026-08-20T10:24:28.022Z',
      sections: ['static', 'functional'],
      bench: 'https://demostaging1.inojob.com',
      browser: 'http://touchstone-browser:9746/mcp',
    });

    const body = await read();
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
    // Newest first, so the UI's "what it is doing now" is the head of the list.
    expect(body.progress?.recent[0]?.id).toBe('pinned-image-tag');
  });

  /** A run with a skipped section must not have the UI drawing a track nobody is running. */
  it('reports the sections actually running, and the ones it skipped', async () => {
    app = await build({
      subject: 'SegmentPlayer',
      started_at: '2026-08-20T10:24:28.022Z',
      sections: ['static'],
      blocked: [{ section: 'functional', reason: 'bench_unavailable' }],
      degraded_reason: 'bench_unavailable',
      bench: null,
      browser: null,
    });
    const body = await read();
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
    const ticket = ledger.open({ subject: 'Ntfy', sections: [SECTIONS[0]!], canonical: many });
    for (const r of many) ledger.recordRequirement(ticket.token, { id: r.id, verdict: 'pass' });

    app = await build({ subject: 'Ntfy', started_at: '2026-08-20T10:24:28.022Z', sections: ['static'] });
    const body = await read();
    expect(body.progress?.verified).toBe(12);
    expect(body.progress?.recent.length).toBeLessThanOrEqual(5);
    expect(body.progress?.recent[0]?.id).toBe('rule-11');
  });
});
