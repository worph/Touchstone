/**
 * The API. Registered by `src/server/index.ts` under `/api/v1`.
 *
 * The archive half — subjects and reports — is derived on the fly from the assay index and
 * holds no state. The activity half — events, alerts, benches, push — is registered from
 * here too but implemented in sibling files, because each owns a service and the read API
 * should not grow a dependency on the prober to serve a report.
 *
 * Everything arrives by injection:
 *
 *   await app.register(registerRoutes, { prefix: '/api/v1', store: index, events, alerts });
 *
 * With no `store` the routes serve `src/server/domain/fixtures.ts`, so `yarn dev` shows a
 * working page before the importer has ever run. With no services the activity endpoints
 * answer empty rather than 404 — the Activity page must render on an instance where none
 * of this is running, which is the same reason the log is a local file.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ReportResponse, SubjectState } from '../../shared/types.js';
import { fixtureStore } from '../domain/fixtures.js';
import { buildFixReport, fixReportFilename } from '../domain/fixreport.js';
import { hallmarks, sortNewestFirst, subjectHallmark } from '../domain/hallmark.js';
import { renderMarkdown } from '../domain/markdown.js';
import { recordsForSubject, type AssayStore } from '../domain/store.js';
import type { AlertStore } from '../services/alerts.js';
import type { BenchProber } from '../services/bench.js';
import type { PortProber } from '../services/ports.js';
import type { ProtocolStore } from '../store/protocols.js';
import type { RunLedger } from '../services/ledger.js';
import type { EventLog } from '../services/events.js';
import type { PushService } from '../services/push.js';
import type { Runner } from '../runner/index.js';
import type { Scheduler } from '../scheduler/index.js';
import type { ChatRoutesOptions } from './chat.js';
import type { SubjectRegistry } from '../store/registry.js';
import alertRoutes from './alerts.js';
import benchRoutes from './benches.js';
import eventRoutes from './events.js';
import pushRoutes from './push.js';
import assayRoutes from './assays.js';
import chatRoutes from './chat.js';
import mcpRoutes from './mcp.js';
import protocolRoutes from './protocols.js';
import scheduleRoutes from './schedule.js';

export interface RoutesOptions {
  /** The index built at boot. Omitted in dev and in the route tests. */
  store?: AssayStore;
  events?: EventLog;
  alerts?: AlertStore;
  prober?: BenchProber;
  ports?: PortProber;
  protocols?: ProtocolStore;
  ledger?: RunLedger;
  push?: PushService;
  scheduler?: Scheduler;
  runner?: Runner;
  registry?: SubjectRegistry;
  boardUrl?: string;
  /** The administrator chat. Absent means the page renders and says it is not wired. */
  chat?: ChatRoutesOptions;
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

/** Reject anything that could climb out of the reports root before it reaches the store. */
function isSafeSegment(value: string): boolean {
  return value.length > 0 && !value.includes('/') && !value.includes('\\') && !value.includes('..');
}

const routes: FastifyPluginAsync<RoutesOptions> = async (app, options) => {
  const store = options.store ?? fixtureStore();

  await app.register(eventRoutes, { events: options.events });
  await app.register(alertRoutes, { alerts: options.alerts });
  await app.register(benchRoutes, {
    prober: options.prober,
    ports: options.ports,
    boardUrl: options.boardUrl,
  });
  await app.register(pushRoutes, { push: options.push });
  await app.register(scheduleRoutes, {
    scheduler: options.scheduler,
    registry: options.registry,
    runner: options.runner,
  });
  await app.register(mcpRoutes, { ledger: options.ledger });
  await app.register(protocolRoutes, { protocols: options.protocols, events: options.events });
  await app.register(chatRoutes, {
    ...(options.chat ?? {}),
    ...(options.events ? { events: options.events } : {}),
    ...(options.ports ? { ports: options.ports } : {}),
  });
  await app.register(assayRoutes, {
    runner: options.runner,
    scheduler: options.scheduler,
    ledger: options.ledger,
    store: options.store as never,
  });

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
    if (resolved) {
      return {
        subject: subjectHallmark(resolved.name, resolved.records).state,
        history: sortNewestFirst(resolved.records), // newest first, both legs interleaved
      };
    }

    /**
     * Not in the archive — which is not the same as not a subject.
     *
     * The index is built from report files, so an app that has never been assayed has no
     * entry, and the very first audit of one is *guaranteed* to be in this state while it
     * runs. 404 meant every link to it — the running strip, the Activity card, the log rows
     * naming it — landed on "unknown subject" for the whole run and then worked afterwards.
     *
     * The registry is the authority on what is a subject, so ask it. The page already has
     * the state for this ("It is in the registry and nothing more"); it was never given the
     * chance to render.
     */
    const known = options.registry?.list() ?? [];
    const name = request.params.name;
    const match = known.find((s) => s === name) ?? known.find((s) => s.toLowerCase() === name.toLowerCase());
    if (!match) return fail(reply, 404, `unknown subject: ${name}`);
    return { subject: subjectHallmark(match, []).state, history: [] };
  });

  /**
   * GET /subjects/:name/fix.md — the audit, addressed to whoever has to fix the app.
   *
   * Markdown, not JSON, and deliberately: it is handed to a person or pasted into a model,
   * and a document that needs unwrapping first is a document that gets unwrapped wrongly.
   * The UI fetches this same endpoint rather than composing its own copy.
   */
  app.get<{ Params: { name: string } }>('/subjects/:name/fix.md', async (request, reply) => {
    const resolved = resolveSubject(request.params.name);
    if (!resolved) return fail(reply, 404, `unknown subject: ${request.params.name}`);

    const state = subjectHallmark(resolved.name, resolved.records).state;
    const markdown = buildFixReport({
      subject: resolved.name,
      // Every section the subject has, in the order the archive reports them — the brief is
      // as wide as the protocol is, not as wide as a two-column table.
      sections: Object.values(state.sections)
        .filter(Boolean)
        .map((rec) => ({ meta: rec!.meta, path: rec!.path })),
    });
    // No assay at all. There is nothing honest to brief anyone on, and an empty document
    // would read as a clean bill of health.
    if (!markdown) return fail(reply, 404, `no assay to report on for ${resolved.name}`);

    return reply
      .type('text/markdown; charset=utf-8')
      .header('content-disposition', `inline; filename="${fixReportFilename(resolved.name)}"`)
      .send(markdown);
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
};

export default routes;
