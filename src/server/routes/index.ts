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
import { hallmarks, sortNewestFirst, subjectHallmark, subjectNames } from '../domain/hallmark.js';
import { renderMarkdown } from '../domain/markdown.js';
import { recordsForSubject, type AssayStore } from '../domain/store.js';
import { ambiguousMessage, resolveSubjectKey } from '../domain/subjects.js';
import type { TrialRoutesOptions } from './trials.js';
import type { UploadRoutesOptions } from './uploads.js';
import type { BrowserRoutesOptions } from './browser.js';
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
import adminMcpRoutes, { type AdminMcpOptions } from './mcp-admin.js';
import protocolRoutes from './protocols.js';
import publicRoutes from './public.js';
import browserRoutes, { registerBrowserProxy } from './browser.js';
import scheduleRoutes from './schedule.js';
import trialRoutes from './trials.js';
import uploadRoutes from './uploads.js';

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
  /** The trial surface. Absent, `/trials` answers 503 rather than 404 — it is a real feature. */
  trials?: TrialRoutesOptions;
  /**
   * Where a trial's files are written when there is no ref to fetch them from.
   *
   * Absent, the routes are not registered at all rather than answering 503: unlike `/trials`,
   * an installation with no upload store has nothing to explain — there is no session to
   * write into and no token that could name one.
   */
  uploads?: UploadRoutesOptions;
  /** The browser sidecar, so a running audit can be watched. See `routes/browser.ts`. */
  browser?: BrowserRoutesOptions;
  boardUrl?: string;
  /** The administrator chat. Absent means the page renders and says it is not wired. */
  chat?: ChatRoutesOptions;
  /**
   * The chat's tools, served over MCP. Absent or disabled registers nothing — see
   * `routes/mcp-admin.ts` for why that is a real state rather than a 503.
   */
  adminMcp?: Omit<AdminMcpOptions, 'ctx' | 'events'>;
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
  /**
   * The same registry the chat calls, over MCP. It takes the chat's own context rather than a
   * second one assembled here: one definition of what an agent may ask this app, so the two
   * cannot come to disagree about it.
   */
  await app.register(adminMcpRoutes, {
    ...(options.adminMcp ?? {}),
    ...(options.chat?.ctx ? { ctx: options.chat.ctx } : {}),
    ...(options.events ? { events: options.events } : {}),
  });
  await app.register(protocolRoutes, { protocols: options.protocols, events: options.events });
  await app.register(chatRoutes, {
    ...(options.chat ?? {}),
    ...(options.events ? { events: options.events } : {}),
    ...(options.ports ? { ports: options.ports } : {}),
  });
  await app.register(trialRoutes, options.trials ?? {});
  // Its own plugin, and that matters: it swaps the content-type parsers for a
  // buffer-everything one, which must not reach the JSON API around it.
  await app.register(uploadRoutes, options.uploads ?? {});
  await app.register(browserRoutes, options.browser ?? {});
  // The proxies last: their upstream is fixed at registration, and they are skipped entirely
  // when no sidecar is configured.
  await registerBrowserProxy(app, options.browser?.browserUrl);
  /**
   * The one prefix meant to be read by somebody who does not operate this app — see
   * `routes/public.ts`. Registered from the same `store`, so the board and the operator
   * table cannot disagree, and read-only by a boot-time check rather than by convention.
   */
  await app.register(publicRoutes, { store });
  await app.register(assayRoutes, {
    runner: options.runner,
    scheduler: options.scheduler,
    ledger: options.ledger,
    store: options.store as never,
  });

  /**
   * Subjects are addressed by key, `<origin>~<name>`, but a bare name still resolves — a URL
   * bookmarked before stores existed, or a person typing an app name. `resolveSubjectKey` is
   * the one matcher; `ambiguous` only becomes reachable with a second origin configured.
   */
  function resolveSubject(input: string) {
    const resolved = resolveSubjectKey(input, subjectNames(store.all()));
    if (resolved.kind !== 'ok') return resolved;
    return { kind: 'ok' as const, name: resolved.key, records: recordsForSubject(store, resolved.key) };
  }

  // GET /subjects — the Overview table. One row per subject, both legs, risk descending.
  app.get('/subjects', async (): Promise<SubjectState[]> => hallmarks(store.all()));

  // GET /subjects/:name — the subject detail page: the composed row plus full history.
  app.get<{ Params: { name: string } }>('/subjects/:name', async (request, reply) => {
    const resolved = resolveSubject(request.params.name);
    if (resolved.kind === 'ambiguous') {
      return fail(reply, 400, ambiguousMessage(request.params.name, resolved.candidates));
    }
    if (resolved.kind === 'ok') {
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
    const name = request.params.name;
    const fromRegistry = resolveSubjectKey(name, options.registry?.list() ?? []);
    if (fromRegistry.kind === 'ambiguous') {
      return fail(reply, 400, ambiguousMessage(name, fromRegistry.candidates));
    }
    if (fromRegistry.kind !== 'ok') return fail(reply, 404, `unknown subject: ${name}`);
    return { subject: subjectHallmark(fromRegistry.key, []).state, history: [] };
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
    if (resolved.kind === 'ambiguous') {
      return fail(reply, 400, ambiguousMessage(request.params.name, resolved.candidates));
    }
    if (resolved.kind !== 'ok') return fail(reply, 404, `unknown subject: ${request.params.name}`);

    const state = subjectHallmark(resolved.name, resolved.records).state;
    const markdown = buildFixReport({
      // The brief is for a person fixing an app, so it is headed with the app's name. The
      // store it came from is already in the `subject_ref` line the report quotes.
      subject: state.label,
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
      .header('content-disposition', `inline; filename="${fixReportFilename(state.label)}"`)
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

      // `:subject` is a key, but a bare name still resolves — a report URL bookmarked before
      // stores existed, or one pasted out of an older report. Resolving first is also what
      // fixes the older bug in this line: matching on a bare name and taking the *first* hit
      // would serve one store's report for another store's identically-named app, which is a
      // wrong answer rather than a 404.
      const resolved = resolveSubject(subject);
      if (resolved.kind === 'ambiguous') {
        return fail(reply, 400, ambiguousMessage(subject, resolved.candidates));
      }
      const record =
        resolved.kind === 'ok'
          ? resolved.records.find((r) => r.file === file)
          : undefined;
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
