/**
 * The MVP-0 read API. Registered by `src/server/index.ts` under `/api/v1`.
 *
 * Four endpoints, exactly the ones in MVP.md §5, no pagination — there are 69 subjects.
 * Everything is derived on the fly from the assay index; nothing here holds state.
 *
 * The store arrives by injection:
 *
 *   await app.register(registerRoutes, { prefix: '/api/v1', store: index });
 *
 * With no `store` option the routes serve `src/server/domain/fixtures.ts`, so this stream
 * runs standalone while stream A builds the real index.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { FindingStatus, ReportResponse, SubjectState } from '../../shared/types.js';
import { fixtureStore } from '../domain/fixtures.js';
import { findingsByStatus, groupByRule } from '../domain/findings.js';
import { hallmarks, sortNewestFirst, subjectHallmark } from '../domain/hallmark.js';
import { renderMarkdown } from '../domain/markdown.js';
import { recordsForSubject, type AssayStore } from '../domain/store.js';

export interface RoutesOptions {
  /** Stream A's index. Omitted in dev and in this stream's tests. */
  store?: AssayStore;
}

const FINDING_STATUSES: readonly FindingStatus[] = [
  'pass',
  'fail',
  'n-a',
  'advisory',
  'unverified',
];

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

/** Reject anything that could climb out of the reports root before it reaches the store. */
function isSafeSegment(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && !value.includes('..');
}

const routes: FastifyPluginAsync<RoutesOptions> = async (app, options) => {
  const store = options.store ?? fixtureStore();

  /** Subjects are addressed by name; be forgiving about case, exact match wins. */
  function resolveSubject(name: string) {
    const exact = recordsForSubject(store, name);
    if (exact.length > 0) return { name, records: exact };
    const lower = name.toLowerCase();
    const match = store.all().find((r) => r.subject.toLowerCase() === lower);
    if (!match) return null;
    return { name: match.subject, records: recordsForSubject(store, match.subject) };
  }

  // GET /subjects — the Overview table. One row per subject, both legs, risk descending.
  app.get('/subjects', async (): Promise<SubjectState[]> => hallmarks(store.all()));

  // GET /subjects/:name — the subject detail page: the composed row plus full history.
  app.get<{ Params: { name: string } }>('/subjects/:name', async (request, reply) => {
    const resolved = resolveSubject(request.params.name);
    if (!resolved) return fail(reply, 404, `unknown subject: ${request.params.name}`);
    return {
      subject: subjectHallmark(resolved.name, resolved.records).state,
      history: sortNewestFirst(resolved.records), // newest first, both legs interleaved
    };
  });

  // GET /reports/:subject/:file — the rendered report and its source.
  app.get<{ Params: { subject: string; file: string } }>(
    '/reports/:subject/:file',
    async (request, reply) => {
      const { subject, file } = request.params;
      if (!isSafeSegment(subject) || !isSafeSegment(file)) {
        return fail(reply, 400, 'invalid report path');
      }

      const record = store.all().find((r) => r.subject === subject && r.file === file);
      if (!record) return fail(reply, 404, `unknown report: ${subject}/${file}`);

      const stored = await store.read(record.path);
      // The index is built from frontmatter and outlives the file; UX.md §5 wants this to
      // read as "the report is gone", not as "the subject does not exist".
      if (!stored) return fail(reply, 410, `report file missing: ${record.path}`);

      const body = stored.body ?? '';
      const response: ReportResponse = {
        meta: stored.meta ?? record.meta,
        html: renderMarkdown(body),
        raw: stored.raw ?? body,
      };
      return response;
    },
  );

  // GET /findings — grouped by rule, or the queue for one finding status.
  app.get<{ Querystring: { group?: string; status?: string } }>(
    '/findings',
    async (request, reply) => {
      const { group, status } = request.query;

      if (status !== undefined) {
        if (!FINDING_STATUSES.includes(status as FindingStatus)) {
          return fail(reply, 400, `unknown status: ${status}`);
        }
        return findingsByStatus(store.all(), status as FindingStatus);
      }

      if (group !== undefined && group !== 'rule') {
        return fail(reply, 400, `unknown grouping: ${group}`);
      }

      return groupByRule(store.all());
    },
  );
};

export default routes;
