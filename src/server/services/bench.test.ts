import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AlertStore } from './alerts.js';
import { BenchProber, boardClaimsReady, probeBench, type BenchConfig } from './bench.js';
import { EventLog } from './events.js';

const BENCH: BenchConfig = {
  name: 'demostaging1',
  url: 'https://demostaging1.example',
  username: 'qa',
  password: 'secret',
};

let dir: string;
let events: EventLog;
let alerts: AlertStore;

/** Stand in for one HTTP answer. Nothing here goes near a real bench. */
function answer(status: number, body = ''): Response {
  return new Response(body, { status });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-bench-'));
  events = new EventLog(dir);
  alerts = new AlertStore(dir, { events });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('probing one bench', () => {
  it('calls the login endpoint, not the home page', async () => {
    const fetchMock = vi.fn(async (_url: string) => answer(200, '{"status":"OK"}'));
    vi.stubGlobal('fetch', fetchMock);
    await probeBench(BENCH);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://demostaging1.example/api/firstfactor');
  });

  it('reads a 200 as healthy', async () => {
    vi.stubGlobal('fetch', async () => answer(200, '{"status":"OK"}'));
    expect((await probeBench(BENCH)).status).toBe('healthy');
  });

  it('reads a 401 as an auth failure, which is the 2026-08-05 condition', async () => {
    vi.stubGlobal('fetch', async () => answer(401));
    const probe = await probeBench(BENCH);
    expect(probe.status).toBe('auth');
    expect(probe.detail).toBe('HTTP 401');
  });

  /**
   * The specific mistake the management board makes: the IdP answers 200 and puts the
   * rejection in the body. A prober that reads only the status line reports the outage as
   * healthy, which is how a fortnight of runs got attributed to the apps.
   */
  it('reads a 200 that rejects in the body as an auth failure', async () => {
    vi.stubGlobal('fetch', async () => answer(200, '{"status":"KO","message":"auth/invalid-credential"}'));
    expect((await probeBench(BENCH)).status).toBe('auth');
  });

  it('reads a 502 as unreachable rather than as bad credentials', async () => {
    vi.stubGlobal('fetch', async () => answer(502));
    expect((await probeBench(BENCH)).status).toBe('unreachable');
  });

  it('reads a refused connection as unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await probeBench(BENCH)).status).toBe('unreachable');
  });

  it('says so rather than guessing when there are no credentials', async () => {
    vi.stubGlobal('fetch', async () => answer(200));
    const probe = await probeBench({ name: 'x', url: 'https://x.example' });
    expect(probe.status).toBe('unconfigured');
  });

  it('never puts a credential in the reported detail', async () => {
    vi.stubGlobal('fetch', async () => answer(401, 'password=secret rejected'));
    const probe = await probeBench(BENCH);
    expect(JSON.stringify(probe)).not.toContain('secret');
  });
});

describe('the pool', () => {
  function prober(benches: BenchConfig[], boardUrl?: string): BenchProber {
    return new BenchProber({ benches, stateDir: dir, events, alerts, boardUrl });
  }

  it('opens one alert for two benches failing the same way', async () => {
    vi.stubGlobal('fetch', async () => answer(401));
    const p = prober([BENCH, { ...BENCH, name: 'demostaging2' }]);
    await p.probeAll();
    await p.probeAll();
    expect(alerts.openAlerts().map((a) => a.key)).toEqual(['bench.auth']);
    expect(alerts.get('bench.auth')?.detail).toContain('demostaging2');
  });

  it('names the pool, not one host, when both are failing', async () => {
    vi.stubGlobal('fetch', async () => answer(401));
    const p = prober([BENCH, { ...BENCH, name: 'demostaging2' }]);
    await p.probeAll();
    expect(alerts.get('bench.auth')?.title).toContain('pool');
  });

  it('says the functional queue is paused while no bench is usable', async () => {
    vi.stubGlobal('fetch', async () => answer(401));
    const p = prober([BENCH]);
    await p.probeAll();
    expect(alerts.get('bench.auth')?.impact).toContain('functional queue paused');
    expect(p.poolUp).toBe(false);
  });

  it('resolves the alert as soon as a bench answers again', async () => {
    let status = 401;
    vi.stubGlobal('fetch', async () => answer(status, status === 200 ? '{"status":"OK"}' : ''));
    const p = prober([BENCH]);
    await p.probeAll();
    expect(alerts.isOpen('bench.auth')).toBe(true);
    status = 200;
    await p.probeAll();
    expect(alerts.isOpen('bench.auth')).toBe(false);
    expect(p.poolUp).toBe(true);
  });

  it('logs a bench failing once, not once per probe', async () => {
    vi.stubGlobal('fetch', async () => answer(401));
    const p = prober([BENCH]);
    for (let i = 0; i < 12; i++) await p.probeAll();
    await events.flush();
    expect(events.query({ code: 'BENCH_AUTH_FAILED' })).toHaveLength(1);
  });

  it('keeps the last healthy time across a restart, so `last ok` survives a deploy', async () => {
    vi.stubGlobal('fetch', async () => answer(200, '{"status":"OK"}'));
    const first = prober([BENCH]);
    await first.probeAll();
    const healthyAt = first.list()[0]?.healthy_at;
    expect(healthyAt).toBeTruthy();

    vi.stubGlobal('fetch', async () => answer(401));
    const second = prober([BENCH]);
    await second.load();
    await second.probeAll();
    expect(second.list()[0]?.status).toBe('auth');
    expect(second.list()[0]?.healthy_at).toBe(healthyAt);
  });

  /** The disagreement is the finding. Agreeing with the board silently is the bug. */
  it('records the board still claiming ready while the probe cannot log in', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/board')
        ? answer(200, '<tr><td>demostaging1</td><td>✅ Ready</td></tr>')
        : answer(401),
    );
    const p = prober([BENCH], 'https://board.example/board');
    await p.probeAll();
    await events.flush();
    const rows = events.query({ code: 'BENCH_BOARD_DISAGREES' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ bench: 'demostaging1' });
  });

  it('does not claim a disagreement when the board could not be read', async () => {
    vi.stubGlobal('fetch', async (url: string) => (url.includes('/board') ? answer(500) : answer(401)));
    const p = prober([BENCH], 'https://board.example/board');
    await p.probeAll();
    await events.flush();
    expect(events.query({ code: 'BENCH_BOARD_DISAGREES' })).toHaveLength(0);
    expect(p.list()[0]?.board_says).toBeNull();
  });
});

describe('reading the board', () => {
  it('treats a ready marker as a claim of health', () => {
    expect(boardClaimsReady('demostaging1 ✅ Ready')).toBe(true);
    expect(boardClaimsReady('demostaging1 Online')).toBe(true);
  });

  it('does not, when the same line also reports a fault', () => {
    expect(boardClaimsReady('demostaging1 Ready ❌ error')).toBe(false);
  });

  it('claims nothing when the board was not read', () => {
    expect(boardClaimsReady(null)).toBe(false);
    expect(boardClaimsReady(undefined)).toBe(false);
  });
});
