/**
 * `GET /events` — the Activity log feed.
 *
 * Served from the log's in-memory window, so polling it costs nothing and works with the
 * disk read-only. The response carries `last_seq` and the subjects seen, because the page
 * needs both to poll for the tail and to populate its filter menu without a second call.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { EventsResponse, EventCategory, EventLevel } from '../../shared/activity.js';
import type { EventLog } from '../services/events.js';
import { EVENT_CODES } from '../services/events.js';

export interface EventsRoutesOptions {
  /** Absent in the route tests and in fixture mode: the feed is then simply empty. */
  events?: EventLog;
}

const LEVELS: EventLevel[] = ['debug', 'info', 'warn', 'error'];

const routes: FastifyPluginAsync<EventsRoutesOptions> = async (app, options) => {
  const codes = Object.fromEntries(
    Object.entries(EVENT_CODES).map(([code, spec]) => [code, spec.label]),
  );

  app.get<{
    Querystring: {
      level?: string;
      category?: string;
      subject?: string;
      code?: string;
      since?: string;
      limit?: string;
    };
  }>('/events', async (request): Promise<EventsResponse> => {
    const log = options.events;
    if (!log) return { events: [], subjects: [], last_seq: 0, codes };

    const q = request.query;
    const level = LEVELS.includes(q.level as EventLevel) ? (q.level as EventLevel) : undefined;
    const since = q.since !== undefined ? Number(q.since) : undefined;
    const limit = q.limit !== undefined ? Math.min(Math.max(Number(q.limit) || 0, 1), 1000) : 200;

    return {
      events: log.query({
        level,
        category: q.category ? (q.category as EventCategory) : undefined,
        subject: q.subject || undefined,
        code: q.code || undefined,
        since: Number.isFinite(since) ? since : undefined,
        limit,
      }),
      subjects: log.subjects(),
      last_seq: log.lastSeq,
      codes,
    };
  });
};

export default routes;
