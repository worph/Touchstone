/**
 * `GET /usage?days=30` — token usage per day, for the Status page's chart.
 *
 * Absent a log (route tests, fixture mode) it answers with an empty window rather than a
 * 404, so the page renders its "no usage recorded yet" state instead of an error.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { UsageSummary } from '../../shared/usage.js';
import { summarizeUsage } from '../domain/usage.js';
import type { UsageLog } from '../store/usage.js';

export interface UsageRoutesOptions {
  usage?: UsageLog;
}

const DEFAULT_DAYS = 30;

const routes: FastifyPluginAsync<UsageRoutesOptions> = async (app, options) => {
  app.get<{ Querystring: { days?: string } }>('/usage', async (request): Promise<UsageSummary> => {
    const n = Number(request.query.days);
    const days = Number.isFinite(n) && n > 0 ? n : DEFAULT_DAYS;
    return options.usage ? options.usage.summary(days) : summarizeUsage([], days, new Date());
  });
};

export default routes;
