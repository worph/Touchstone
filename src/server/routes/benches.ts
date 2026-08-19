/**
 * `GET /benches` and `POST /benches/probe` — the environment block on Activity.
 *
 * The POST exists because the page has a `probe` button, and the page has a probe button
 * because the first thing anyone does when told the bench is down is check whether it
 * still is. It is safe to spam: `BenchProber.probeAll` coalesces concurrent calls.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { BenchesResponse } from '../../shared/activity.js';
import type { BenchProber } from '../services/bench.js';

export interface BenchRoutesOptions {
  prober?: BenchProber;
  /** Shown next to the pool so "we are not reading the board" is visible, not assumed. */
  boardUrl?: string;
}

const routes: FastifyPluginAsync<BenchRoutesOptions> = async (app, options) => {
  const answer = (): BenchesResponse => ({
    benches: options.prober?.list() ?? [],
    pool_up: options.prober?.poolUp ?? false,
    leasable: options.prober?.leasable().length ?? 0,
    board_url: options.boardUrl || null,
  });

  app.get('/benches', async (): Promise<BenchesResponse> => answer());

  app.post('/benches/probe', async (): Promise<BenchesResponse> => {
    if (options.prober) await options.prober.probeAll();
    return answer();
  });
};

export default routes;
