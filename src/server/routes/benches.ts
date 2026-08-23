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
import type { PortProber } from '../services/ports.js';

export interface BenchRoutesOptions {
  prober?: BenchProber;
  /** The agent and browser endpoints, reported beside the benches — they are one picture. */
  ports?: PortProber;
  /** Shown next to the pool so "we are not reading the board" is visible, not assumed. */
  boardUrl?: string;
}

const routes: FastifyPluginAsync<BenchRoutesOptions> = async (app, options) => {
  const answer = (): BenchesResponse => ({
    benches: options.prober?.list() ?? [],
    pool_up: options.prober?.poolUp ?? false,
    leasable: options.prober?.leasable().length ?? 0,
    window: options.prober?.window() ?? 'no demo bench is configured',
    board_url: options.boardUrl || null,
    ports: options.ports?.list() ?? [],
  });

  app.get('/benches', async (): Promise<BenchesResponse> => answer());

  app.post('/benches/probe', async (): Promise<BenchesResponse> => {
    // One button, everything it depends on. Probing the benches and leaving the agent
    // unprobed is how you end up staring at a green page during an agent outage.
    await Promise.all([options.prober?.probeAll(), options.ports?.probeAll()]);
    return answer();
  });
};

export default routes;
