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
import { subjectName } from '../../shared/subject.js';
import type { ReportResponse, SubjectState } from '../../shared/types.js';
import { fixtureStore } from '../domain/fixtures.js';
import { buildFixReport, fixReportFilename } from '../domain/fixreport.js';
import { hallmarks, sortNewestFirst, subjectHallmark, subjectNames } from '../domain/hallmark.js';
import { renderMarkdown } from '../domain/markdown.js';
import { readStandards } from '../domain/standards.js';
import { recordsForSubject, type AssayStore } from '../domain/store.js';
import { ambiguousMessage, resolveSubjectKey } from '../domain/subjects.js';
import type { TrialRoutesOptions } from './trials.js';
import type { UploadRoutesOptions } from './uploads.js';
import type { BrowserRoutesOptions } from './browser.js';
import type { AlertStore } from '../services/alerts.js';
import type { BenchProber } from '../services/bench.js';
import type { PortProber } from '../services/ports.js';
import type { ProtocolStore } from '../store/protocols.js';
import type { RevisionStore } from '../store/revisions.js';
import type { RunLedger } from '../services/ledger.js';
import type { EventLog } from '../services/events.js';
import type { PushService } from '../services/push.js';
import type { Runner } from '../runner/index.js';
import type { Scheduler } from '../scheduler/index.js';
import type { ChatRoutesOptions } from './chat.js';
import type { ControlsRoutesOptions } from './controls.js';
import type { SettingsRoutesOptions } from './settings.js';
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
import controlsRoutes from './controls.js';
import settingsRoutes from './settings.js';
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
  revisions?: RevisionStore;
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
  /**
   * This instance's own two settings surfaces: the administrator's context prompt, and the
   * config it booted with. Absent, both answer rather than 404 — see `routes/settings.ts`.
   */
  settings?: SettingsRoutesOptions;
  /**
   * The configuration that can be changed while the app is running — `routes/controls.ts`.
   *
   * Absent, `GET /controls` still answers: it lists what exists and marks each row
   * unsettable, which is the honest thing to say in a build where the scheduler and the
   * runner were never constructed.
   */
  controls?: ControlsRoutesOptions;
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
  await app.register(protocolRoutes, {
    protocols: options.protocols,
    revisions: options.revisions,
    events: options.events,
  });
  await app.register(controlsRoutes, {
    ...(options.controls ?? {}),
    ...(options.events ? { events: options.events } : {}),
  });
  await app.register(settingsRoutes, {
    ...(options.settings ?? {}),
    ...(options.events ? { events: options.events } : {}),
  });
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
  await app.register(publicRoutes, {
    store,
    ...(options.protocols ? { protocols: options.protocols } : {}),
    ...(options.registry ? { registry: options.registry } : {}),
  });
  await app.register(assayRoutes, {
    runner: options.runner,
    scheduler: options.scheduler,
    ledger: options.ledger,
    prober: options.prober,
  });

  /**
   * Subjects are addressed by key, `<origin>~<name>`, but a bare name still resolves — a URL
   * bookmarked before stores existed, or a person typing an app name. `resolveSubjectKey` is
   * the one matcher; `ambiguous` only becomes reachable with a second origin configured.
   */
  /**
   * The rubric in force, per section — what the `standard` badge on a row is measured
   * against.
   *
   * Read per request rather than captured, because the protocol directory is a volume: an
   * edit made over SSH has to show up on the next page load, not on the next restart. The
   * revision log is deliberately **not** consulted here — the badge only needs each section's
   * current hash, and `moved_at` (which does read the log) is the scheduler's half.
   *
   * Undefined when there is no protocol store to ask, and every row then comes back without a
   * `standard` at all rather than with a guess.
   */
  async function currentStandards() {
    if (!options.protocols) return undefined;
    try {
      return (await readStandards(options.protocols)).sections;
    } catch {
      // A page that cannot read the rubric still has verdicts worth rendering; it just has
      // nothing to qualify them with. Invariant 7's rule, applied one surface down.
      return undefined;
    }
  }

  function resolveSubject(input: string) {
    const resolved = resolveSubjectKey(input, subjectNames(store.all()));
    if (resolved.kind !== 'ok') return resolved;
    return { kind: 'ok' as const, name: resolved.key, records: recordsForSubject(store, resolved.key) };
  }

  /**
   * GET /subjects — the Store table. One row per **tracked** subject, both legs, risk
   * descending.
   *
   * The union of the registry and the archive, not the archive alone. An app that has never
   * been audited has no report file and so no index entry, and for as long as this returned
   * `hallmarks(store.all())` those apps were invisible to the operator: the page said 20
   * subjects while the scheduler queued 72, and the ones most in need of a first look were
   * the ones that could not be seen or started.
   *
   * The registry is asked for names only. Nothing about a verdict comes from it, so a store
   * that has gone unreachable cannot blank a row — `registry.list()` keeps serving its last
   * good list, and a subject that drops out of the store keeps its row through the archive.
   *
   * Keeping the row is not the same as saying nothing about it, which is what `delisted` is
   * for. `list()` no longer carries a delisted subject — it is the scheduler's candidate set
   * too — so those rows arrive here through the archive alone, and would otherwise be
   * indistinguishable from apps still on sale. See `SubjectRegistry.delisted`.
   */
  app.get('/subjects', async (): Promise<SubjectState[]> =>
    hallmarks(store.all(), {
      include: options.registry?.list() ?? [],
      standards: await currentStandards(),
      ...(options.registry ? { versions: options.registry.versions() } : {}),
      ...(options.registry ? { delisted: options.registry.delisted() } : {}),
    }));

  /**
   * Whether an audit of this subject has been asked for and not yet answered, and where it
   * sits in the line.
   *
   * `undefined` when there is no scheduler at all, and the page reads that as "no control to
   * offer" rather than as "not queued". Kept beside the hallmark rather than inside it: a
   * request is the scheduler's opinion about a subject, not a property of any assay, which is
   * the same line `try_n` and the park sit on — and `SubjectState` is what `/public` serves.
   */
  const queueOf = async (
    subject: string,
  ): Promise<{ queued?: boolean; queue_position?: number }> => {
    if (!options.scheduler) return {};
    const queued = options.scheduler.isFlagged(subject);
    if (!queued) return { queued };
    const at = (await options.scheduler.previewRequests()).findIndex(
      (r) => r.kind === 'audit' && r.id === subject,
    );
    return { queued, ...(at >= 0 ? { queue_position: at + 1 } : {}) };
  };

  // GET /subjects/:name — the subject detail page: the composed row plus full history.
  app.get<{ Params: { name: string } }>('/subjects/:name', async (request, reply) => {
    const resolved = resolveSubject(request.params.name);
    if (resolved.kind === 'ambiguous') {
      return fail(reply, 400, ambiguousMessage(request.params.name, resolved.candidates));
    }
    if (resolved.kind === 'ok') {
      return {
        subject: subjectHallmark(resolved.name, resolved.records, {
          standards: await currentStandards(),
          ...(options.registry ? { versions: options.registry.versions() } : {}),
          ...(options.registry ? { delisted: options.registry.delisted() } : {}),
        }).state,
        history: sortNewestFirst(resolved.records), // newest first, both legs interleaved
        ...(await queueOf(resolved.name)),
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
    return {
      subject: subjectHallmark(fromRegistry.key, []).state,
      history: [],
      ...(await queueOf(fromRegistry.key)),
    };
  });

  /**
   * DELETE /subjects/:name — throw away one app's archive.
   *
   * The only destructive verb in the read API, and the only place anything leaves the
   * archive. It exists because the archive is otherwise permanent by design and a store does
   * not stay still: an app the store has stopped offering keeps its rows, its risk in the
   * roll-up and its name in every count, for ever, about something nobody can install.
   *
   * **It refuses anything that is not delisted**, and that guard is the feature rather than
   * caution. `SubjectRegistry.delisted()` already draws the one distinction that makes this
   * safe — the store was *read* and does not list this app — so a live app cannot be purged
   * by a mistyped name or a stray click on a row, and neither can anything at all while the
   * store is unreachable. An operator who genuinely wants a live app's history gone has the
   * volume; that is a deliberate act and it should look like one.
   *
   * Not reachable from the chat or the admin MCP: `CHAT_TOOLS` has no delete. The registry is
   * what an agent may ask this app to do (invariant 6's neighbouring argument), and an
   * irreversible delete over a surface that authenticates nobody is not a thing to hand out
   * for the sake of symmetry.
   *
   * It answers with a count rather than a bare 204, because "0 files removed" is the truthful
   * answer for a subject somebody had already cleared off the volume by hand, and a caller
   * that is told nothing cannot tell that case from a delete that worked.
   */
  app.delete<{ Params: { name: string } }>('/subjects/:name', async (request, reply) => {
    const registry = options.registry;
    if (!registry) return fail(reply, 503, 'no registry is wired up, so nothing can be shown to be delisted');
    if (!store.purgeSubject) return fail(reply, 503, 'this archive cannot be written to');

    const resolved = resolveSubject(request.params.name);
    if (resolved.kind === 'ambiguous') {
      return fail(reply, 400, ambiguousMessage(request.params.name, resolved.candidates));
    }
    if (resolved.kind !== 'ok') return fail(reply, 404, `unknown subject: ${request.params.name}`);

    if (!registry.isDelisted(resolved.name)) {
      return fail(
        reply,
        409,
        `${resolved.name} is still in the store, or the store could not be read — only a delisted app's archive can be deleted`,
      );
    }

    // The run in flight is the one thing that can put files back after this returns, and the
    // scheduler is what knows about it. Refusing here rather than racing it.
    if (options.runner?.status().running?.subject === resolved.name) {
      return fail(reply, 409, `${resolved.name} is being audited right now`);
    }

    const { removed } = await store.purgeSubject(resolved.name);
    const forgotten = (await options.scheduler?.forget(resolved.name)) ?? false;
    options.events?.log({
      level: 'warn',
      code: 'SUBJECT_PURGED',
      message: `The archive for ${subjectName(resolved.name)} was deleted — it is no longer in the store`,
      subject: resolved.name,
      detail: { subject: resolved.name, files: removed, by: 'operator' },
    });
    return { subject: resolved.name, removed, forgotten };
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
