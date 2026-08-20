import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AlertStore } from './alerts.js';
import {
  BenchProber,
  boardClaimsReady,
  describeClaim,
  probeBench,
  readPool,
  type BenchConfig,
} from './bench.js';
import { EventLog } from './events.js';

const BENCH: BenchConfig = { name: 'demostaging1', url: 'https://demostaging1.example' };

/** A bench the pool API listed, with plenty of runway. */
function discovered(name: string, remaining_h = 12): BenchConfig {
  return {
    name,
    url: `https://${name}.example`,
    claim: { processing: false, remaining_h, last_cleanup_ok: true },
  };
}

let dir: string;
let events: EventLog;
let alerts: AlertStore;

/** Stand in for one HTTP answer. Nothing here goes near a real bench. */
function answer(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-bench-'));
  events = new EventLog(dir);
  alerts = new AlertStore(dir, { events });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // `alerts.open`/`resolve` do not await their own writes, by design — an alert must be
  // raised the moment it is true. Settle them, or one lands while `rm -r` is walking the
  // directory and the teardown fails ENOTEMPTY about one run in five.
  await alerts.flush();
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('probing one bench', () => {
  it('starts the login flow, not the home page', async () => {
    const fetchMock = vi.fn(async (_url: string) => answer(200));
    vi.stubGlobal('fetch', fetchMock);
    await probeBench(BENCH);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://demostaging1.example/nhl-auth/oidc/login?redirect=/');
  });

  it('reads landing on the app as healthy', async () => {
    vi.stubGlobal('fetch', async () => answer(200));
    expect((await probeBench(BENCH)).status).toBe('healthy');
  });

  /**
   * The bug this replaced. `POST /api/firstfactor` answers 302 to the OIDC login on these
   * hosts, and the old probe scored any 302 as healthy — a green light for a bench nobody
   * had logged into. A redirect is a step in the flow, never the end of it.
   */
  it('does not call a redirect to the login page a pass', async () => {
    vi.stubGlobal('fetch', async () =>
      answer(302, { location: 'https://auth-demostaging1.example/auth?client_id=maison' }),
    );
    expect((await probeBench(BENCH)).status).not.toBe('healthy');
  });

  it('follows the flow to the end and carries cookies across hops', async () => {
    const seen: { url: string; cookie: string | null }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, cookie: (init.headers as Record<string, string>).cookie ?? null });
      if (seen.length === 1) {
        return answer(302, {
          location: 'https://auth-demostaging1.example/auth',
          'set-cookie': 'session=abc; Path=/; HttpOnly',
        });
      }
      if (seen.length === 2) return answer(302, { location: 'https://maison-demostaging1.example/' });
      return answer(200);
    });

    const probe = await probeBench(BENCH);
    expect(probe.status).toBe('healthy');
    expect(seen).toHaveLength(3);
    // Hop 1 set the cookie on demostaging1.example; hop 2 is a different host and must not
    // receive it, which is the whole reason the jar is scoped rather than global.
    expect(seen[1]?.cookie).toBeNull();
  });

  /**
   * What the flow does when the jar is not carried: it redirects forever. Verified against
   * the live demostaging1 on 2026-08-19 — curl without a cookie jar gave up at 50 hops,
   * and with one it finished in 6.
   */
  it('calls a flow that never terminates an auth failure, not a healthy bench', async () => {
    vi.stubGlobal('fetch', async () => answer(302, { location: 'https://demostaging1.example/nhl-auth/oidc/login' }));
    const probe = await probeBench(BENCH);
    expect(probe.status).toBe('auth');
    expect(probe.detail).toContain('never completes');
  });

  it('reads a 401 at the end of the flow as an auth failure', async () => {
    vi.stubGlobal('fetch', async () => answer(401));
    const probe = await probeBench(BENCH);
    expect(probe.status).toBe('auth');
    expect(probe.httpStatus).toBe(401);
  });

  /**
   * demostaging2 on 2026-08-19: the box is up, the board calls it ready with 18.8 hours
   * remaining, and its login gate answers 500 on the first hop. Whatever that is, it is not
   * a statement about any app — principle 5.
   */
  it('reads a 500 from the gate as the bench being unusable', async () => {
    vi.stubGlobal('fetch', async () => answer(500));
    const probe = await probeBench(BENCH);
    expect(probe.status).toBe('unreachable');
    expect(probe.detail).toContain('login gate');
  });

  it('reads a refused connection as unreachable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect((await probeBench(BENCH)).status).toBe('unreachable');
  });

  it('says so rather than guessing when there is no url', async () => {
    vi.stubGlobal('fetch', async () => answer(200));
    const probe = await probeBench({ name: 'x', url: '' });
    expect(probe.status).toBe('unconfigured');
  });

  it('never puts a session cookie in the reported detail', async () => {
    vi.stubGlobal('fetch', async () => answer(403, { 'set-cookie': 'session=super-secret; Path=/' }));
    const probe = await probeBench(BENCH);
    expect(JSON.stringify(probe)).not.toContain('super-secret');
  });
});

describe('discovering the pool', () => {
  /** The shape read off `https://app.nasselle.com/demo/api/demos` on 2026-08-19. */
  const LIVE = JSON.stringify([
    {
      id: 'demostaging1.inojob.com',
      url: 'https://demostaging1.inojob.com',
      cleanupCron: '0 15 * * *',
      nextCleanup: '2026-08-19T15:00:00.000Z',
      hoursUntilCleanup: 2.77,
      isProcessing: false,
      lastCleanupSuccess: true,
    },
    {
      id: 'demostaging2.inojob.com',
      url: 'https://demostaging2.inojob.com',
      hoursUntilCleanup: 18.77,
      isProcessing: false,
      lastCleanupSuccess: true,
    },
  ]);

  it('reads the roster, the countdown and the cleanup state', async () => {
    vi.stubGlobal('fetch', async () => new Response(LIVE, { status: 200 }));
    const pool = await readPool('https://app.example/demo/api/demos');
    expect(pool.map((b) => b.name)).toEqual(['demostaging1', 'demostaging2']);
    expect(pool[0]?.url).toBe('https://demostaging1.inojob.com');
    expect(pool[0]?.claim?.remaining_h).toBeCloseTo(2.77);
    expect(pool[1]?.claim?.processing).toBe(false);
  });

  it('returns nothing readable rather than an empty pool when the API is down', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 503 }));
    expect(await readPool('https://app.example/demo/api/demos')).toEqual([]);
  });

  it('renders the claim the way the board words it', () => {
    expect(describeClaim({ processing: false, remaining_h: 18.77, last_cleanup_ok: true })).toBe(
      '✅ Ready · 18.8h remaining',
    );
    expect(describeClaim({ processing: true, remaining_h: null, last_cleanup_ok: true })).toBe('🔄 Processing');
  });
});

describe('the pool', () => {
  function prober(benches: BenchConfig[], poolUrl?: string): BenchProber {
    return new BenchProber({ benches, stateDir: dir, events, alerts, poolUrl });
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
    expect(alerts.get('bench.auth')?.title).toContain('any demo bench');
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
    vi.stubGlobal('fetch', async () => answer(status));
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
    vi.stubGlobal('fetch', async () => answer(200));
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
  it('records the board still claiming ready while the login fails', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/api/demos')
        ? new Response(
            JSON.stringify([
              { id: 'demostaging1.x', url: 'https://demostaging1.example', hoursUntilCleanup: 18, isProcessing: false, lastCleanupSuccess: true },
            ]),
            { status: 200 },
          )
        : answer(401),
    );
    const p = prober([], 'https://app.example/demo/api/demos');
    await p.probeAll();
    await events.flush();
    const rows = events.query({ code: 'BENCH_BOARD_DISAGREES' });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({ bench: 'demostaging1' });
  });

  it('does not claim a disagreement when the pool API could not be read', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/api/demos') ? answer(500) : answer(401),
    );
    const p = prober([], 'https://app.example/demo/api/demos');
    await p.probeAll();
    await events.flush();
    expect(events.query({ code: 'BENCH_BOARD_DISAGREES' })).toHaveLength(0);
  });
});

/**
 * Row D7's other half. The rule lived only inside n8n's prompt — "require more than 1 hour,
 * so the daily cleanup cannot wipe the run mid-audit" — so it never reached the parity
 * matrix, and a bench that is up but expiring is exactly the one that wastes a whole assay.
 */
describe('which benches may be claimed', () => {
  function prober(benches: BenchConfig[], poolUrl?: string): BenchProber {
    return new BenchProber({ benches, stateDir: dir, events, alerts, poolUrl, minRemainingMin: 60 });
  }

  async function withPool(rows: BenchConfig[]): Promise<BenchProber> {
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/api/demos')
        ? new Response(
            JSON.stringify(
              rows.map((b) => ({
                id: `${b.name}.x`,
                url: b.url,
                hoursUntilCleanup: b.claim?.remaining_h,
                isProcessing: b.claim?.processing,
                lastCleanupSuccess: b.claim?.last_cleanup_ok,
              })),
            ),
            { status: 200 },
          )
        : answer(200),
    );
    const p = prober([], 'https://app.example/demo/api/demos');
    await p.probeAll();
    return p;
  }

  it('claims a healthy bench with hours to spare', async () => {
    const p = await withPool([discovered('demostaging2', 18)]);
    expect(p.leasable().map((b) => b.name)).toEqual(['demostaging2']);
  });

  it('refuses one that the daily cleanup will wipe mid-run', async () => {
    const p = await withPool([discovered('demostaging1', 0.5)]);
    expect(p.poolUp).toBe(true);
    expect(p.leasable()).toHaveLength(0);
  });

  it('refuses one that is mid-cleanup even when it answers', async () => {
    const p = await withPool([{ ...discovered('demostaging1'), claim: { processing: true, remaining_h: 20, last_cleanup_ok: true } }]);
    expect(p.leasable()).toHaveLength(0);
  });

  it('claims a hand-configured bench, which has no countdown to read', async () => {
    vi.stubGlobal('fetch', async () => answer(200));
    const p = prober([BENCH]);
    await p.probeAll();
    expect(p.leasable().map((b) => b.name)).toEqual(['demostaging1']);
  });
});

describe('reading the board', () => {
  it('treats a ready marker as a claim of health', () => {
    expect(boardClaimsReady('✅ Ready · 18.8h remaining')).toBe(true);
    expect(boardClaimsReady('demostaging1 Online')).toBe(true);
  });

  it('does not, when the same line also reports a fault', () => {
    expect(boardClaimsReady('❌ Error · 2.0h remaining')).toBe(false);
  });

  it('claims nothing when the board was not read', () => {
    expect(boardClaimsReady(null)).toBe(false);
    expect(boardClaimsReady(undefined)).toBe(false);
  });
});

describe('what the log says', () => {
  it('does not call a bench silent when its gate answered 500', async () => {
    vi.stubGlobal('fetch', async () => answer(500));
    const p = new BenchProber({ benches: [BENCH], stateDir: dir, events, alerts });
    await p.probeAll();
    await events.flush();
    const row = events.query({ code: 'BENCH_UNREACHABLE' })[0];
    expect(row?.message).toContain('answered but is not usable');
  });

  it('does say so when nothing answered at all', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('ECONNREFUSED');
    });
    const p = new BenchProber({ benches: [BENCH], stateDir: dir, events, alerts });
    await p.probeAll();
    await events.flush();
    expect(events.query({ code: 'BENCH_UNREACHABLE' })[0]?.message).toContain('did not answer');
  });
});
