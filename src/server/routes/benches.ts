/**
 * `GET /benches` and `POST /benches/probe` — the environment block on Activity.
 *
 * The POST exists because the page has a `probe` button, and the page has a probe button
 * because the first thing anyone does when told the bench is down is check whether it
 * still is. It is safe to spam: `BenchProber.probeAll` coalesces concurrent calls.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { BenchesResponse } from '../../shared/activity.js';
import type { Targets } from '../services/bench.js';
import type { PortProber } from '../services/ports.js';

export interface BenchRoutesOptions {
  targets?: Targets;
  /** The agent and browser endpoints, reported beside the benches — they are one picture. */
  ports?: PortProber;
  /**
   * Each pool's board, by pool id. Shown next to it so "we are not reading the board" is
   * visible rather than assumed — and per pool, because only the demo pool has one.
   */
  boardUrls?: Record<string, string>;
}

const routes: FastifyPluginAsync<BenchRoutesOptions> = async (app, options) => {
  const answer = (): BenchesResponse => ({
    benches: options.targets?.list() ?? [],
    // Per pool rather than summed. A sum reads "3 of 4 usable" while the one that is down is
    // the whole of a platform, which is the reading that lets an operator conclude auditing
    // is fine when half of it has stopped.
    pools: options.targets?.health() ?? [],
    pool_up: options.targets?.poolUp ?? false,
    ports: options.ports?.list() ?? [],
  });

  app.get('/benches', async (): Promise<BenchesResponse> => answer());

  app.post('/benches/probe', async (): Promise<BenchesResponse> => {
    // One button, everything it depends on. Probing the benches and leaving the agent
    // unprobed is how you end up staring at a green page during an agent outage.
    await Promise.all([options.targets?.probeAll(), options.ports?.probeAll()]);
    return answer();
  });
};

export default routes;
