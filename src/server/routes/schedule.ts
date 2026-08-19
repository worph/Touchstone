/**
 * `GET /schedule` and `POST /schedule/tick` — what the driver thinks, and a way to ask it
 * to think again.
 *
 * This exists for shadow mode before it exists for the UI. The whole validation technique
 * for phase 1 is comparing our pick against n8n's `- **State:**` line, and that comparison
 * needs a single endpoint that answers "what would you do right now, and why" without
 * waiting an hour for the timer.
 *
 * `POST /schedule/tick` is safe to call while the scheduler is disarmed — it decides and
 * logs and claims nothing. Once armed it *will* claim, which is why the response says which
 * mode answered rather than leaving the caller to assume.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { Scheduler } from '../scheduler/index.js';
import type { SubjectRegistry } from '../store/registry.js';

export interface ScheduleRoutesOptions {
  scheduler?: Scheduler;
  registry?: SubjectRegistry;
}

const routes: FastifyPluginAsync<ScheduleRoutesOptions> = async (app, options) => {
  const answer = () => {
    const snap = options.scheduler?.snapshot();
    return {
      // Absent rather than false when there is no scheduler at all, so "disarmed" and
      // "not wired up" cannot be confused on the page that reports it.
      armed: snap?.armed ?? null,
      last_tick: snap?.last_tick ?? null,
      last_finished_at: snap?.last_finished_at ?? null,
      subjects: snap?.subjects ?? {},
      registry: {
        count: options.registry?.list().length ?? 0,
        live: options.registry?.isLive ?? false,
        fetched_at: options.registry?.lastFetchedAt ?? null,
      },
    };
  };

  app.get('/schedule', async () => answer());

  app.post<{ Body?: { forced?: string[] } }>('/schedule/tick', async (req) => {
    if (!options.scheduler) return { ...answer(), ran: false };
    const forced = Array.isArray(req.body?.forced) ? req.body.forced.filter((s) => typeof s === 'string') : undefined;
    const decision = await options.scheduler.tick({ forced });
    return { ...answer(), ran: true, decision };
  });
};

export default routes;
