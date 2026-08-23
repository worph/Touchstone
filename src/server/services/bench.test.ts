import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AlertStore } from './alerts.js';
import {
  BenchProber,
  boardClaimsReady,
  describeClaim,
  describeWindow,
  buildFrom,
  probeBench,
  readPool,
  type BenchConfig,
} from './bench.js';
import type { BenchHealth } from '../../shared/activity.js';
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

  it('says what an unusable pool actually stops, and that it costs no try', async () => {
    vi.stubGlobal('fetch', async () => answer(401));
    const p = prober([BENCH]);
    await p.probeAll();
    expect(alerts.get('bench.auth')?.impact).toContain('recorded blocked');
    expect(alerts.get('bench.auth')?.impact).toContain('no try consumed');
    // And when it lifts. An alert that names only the fault leaves the operator with nothing
    // to do and nothing to wait for — which is how one came to sit open all day.
    expect(alerts.get('bench.auth')?.impact).toContain('demostaging1');
    expect(p.poolUp).toBe(false);
  });

  /**
   * A half-broken pool is the ordinary case, and it used to carry no impact line at all — the
   * card named a fault and said nothing about whether work could proceed.
   */
  it('still says what is happening when one bench is down and another is fine', async () => {
    let call = 0;
    vi.stubGlobal('fetch', async (url: string) =>
      url.includes('/api/demos')
        ? new Response(
            JSON.stringify([
              { id: 'demostaging1.x', url: 'https://demostaging1.example', hoursUntilCleanup: 12, isProcessing: false, lastCleanupSuccess: true },
              { id: 'demostaging2.x', url: 'https://demostaging2.example', hoursUntilCleanup: 12, isProcessing: false, lastCleanupSuccess: true },
            ]),
            { status: 200 },
          )
        : answer(call++ === 0 ? 200 : 401),
    );
    const p = new BenchProber({ benches: [], stateDir: dir, events, alerts, poolUrl: 'https://app.example/demo/api/demos' });
    await p.probeAll();

    const impact = alerts.get('bench.auth')?.impact;
    expect(impact).toContain('audits still run');
    expect(impact).toContain('is usable for another');
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

/**
 * The platform fingerprint.
 *
 * Maison has no version to ask for — `-ldflags="-s -w"`, no `/version`, every API route
 * behind the OIDC gate — so what the archive records is the content hash of the bundle it
 * serves. It answers "did the platform differ between these two runs?", which is the question
 * that went unanswerable on 2026-08-22, and it answers nothing else.
 */
describe('the platform fingerprint', () => {
  const SHELL = [
    '<!doctype html><html><head><title>Maison</title>',
    '<script type="module" crossorigin src="/assets/index-C_5OE2_1.js"></script>',
    '<link rel="stylesheet" href="/assets/index-DUdNsmIy.css">',
    '</head><body><div id="app"></div></body></html>',
  ].join('');

  it('reads the hash out of the served shell, as an identity rather than a URL', () => {
    expect(buildFrom(SHELL)).toBe('index-C_5OE2_1');
  });

  it('takes the script, not the stylesheet beside it', () => {
    expect(buildFrom(SHELL)).not.toContain('DUdNsmIy');
  });

  it('gives up quietly on a page it does not recognise', () => {
    // A bench answering 200 with something else is still a healthy bench. Nothing gates on
    // the fingerprint, so failing to take one must cost nothing.
    expect(buildFrom('<html><body>hello</body></html>')).toBeUndefined();
    expect(buildFrom('')).toBeUndefined();
  });

  it('rides a successful probe, and is absent when the gate never let us through', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(SHELL, { status: 200 })));
    await expect(probeBench(BENCH)).resolves.toMatchObject({
      status: 'healthy',
      build: 'index-C_5OE2_1',
    });

    vi.stubGlobal('fetch', vi.fn(async () => answer(403)));
    const denied = await probeBench(BENCH);
    expect(denied.status).toBe('auth');
    expect(denied.build).toBeUndefined();
  });

  it('does not let an unreadable body turn a healthy bench into a down one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        status: 200,
        headers: new Headers(),
        text: async () => {
          throw new Error('socket hung up mid-body');
        },
      })),
    );
    const probe = await probeBench(BENCH);
    expect(probe.status).toBe('healthy');
    expect(probe.build).toBeUndefined();
  });
});

/**
 * When the pool comes back — the sentence that was missing on 2026-08-23.
 *
 * An operator started an audit into a dead pool, was told `functional` would be recorded
 * blocked, and had nowhere to go: every surface named the condition and none named the
 * recovery. The bench became claimable again ninety seconds later and nothing said so. All the
 * facts were already on these rows; only the sentence was missing.
 *
 * `now` is fixed so the clock arithmetic is deterministic.
 */
describe('when a functional section could next run', () => {
  const NOW = new Date('2026-08-23T13:27:00Z');

  function row(over: Partial<BenchHealth> = {}): BenchHealth {
    return {
      name: 'demostaging1',
      url: 'https://demostaging1.example',
      status: 'healthy',
      remaining_min: 600,
      processing: false,
      ...over,
    };
  }

  it('says nothing is configured rather than inventing an outage', () => {
    expect(describeWindow([], 60, NOW)).toBe('no demo bench is configured');
  });

  it('counts down the bench a run would actually take, and names its wipe', () => {
    // 92 minutes on from 13:27 is 14:59 — the real shape of demostaging1 that afternoon.
    expect(describeWindow([row({ remaining_min: 92 })], 60, NOW)).toBe(
      'demostaging1 is usable for another 92 min, until its wipe at ~14:59 UTC',
    );
  });

  /** The runner takes `leasable()[0]`, so any other row would describe a box nothing uses. */
  it('describes the bench the runner would claim, not the first one listed', () => {
    const rows = [row({ name: 'demostaging1', remaining_min: 20 }), row({ name: 'demostaging2' })];
    expect(describeWindow(rows, 60, NOW)).toContain('demostaging2 is usable');
  });

  /**
   * The case that actually bit. The login probe answered 200 while the pool API still said
   * `isProcessing`, so the bench read healthy and was not claimable — and `get_status` said
   * "0 of 2 usable — demostaging1 healthy", which reads as a contradiction.
   */
  it('explains a bench that answers but is mid-cleanup, and that it resolves itself', () => {
    expect(describeWindow([row({ processing: true })], 60, NOW)).toBe(
      'demostaging1 is mid-cleanup — usually back within minutes',
    );
  });

  it('explains a bench held back by the guard, and when it returns', () => {
    expect(describeWindow([row({ remaining_min: 34 })], 60, NOW)).toBe(
      'demostaging1 is 34 min from its wipe at ~14:01 UTC and inside the 60 min guard —' +
        ' usable again shortly after it',
    );
  });

  it('names every box and when each was last seen when none is answering', () => {
    const rows = [
      row({ status: 'unreachable', healthy_at: '2026-08-23T11:49:00Z' }),
      row({ name: 'demostaging2', status: 'unreachable', healthy_at: '2026-08-23T07:11:00Z' }),
    ];
    expect(describeWindow(rows, 60, NOW)).toBe(
      'no demo bench is answering — demostaging1 not since 11:49 UTC, demostaging2 not since 07:11 UTC',
    );
  });

  it('does not claim a countdown the board never gave', () => {
    expect(describeWindow([row({ remaining_min: null })], 60, NOW)).toContain('no countdown');
  });

  /** A hand-configured bench has no board to ask, and that is not a reason to refuse it. */
  it('treats an absent countdown as usable, matching the claim rule', () => {
    const { remaining_min: _drop, ...bare } = row();
    expect(describeWindow([bare as BenchHealth], 60, NOW)).toBe(
      'demostaging1 is usable (the board gives no countdown)',
    );
  });
});
