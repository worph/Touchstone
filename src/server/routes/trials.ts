/**
 * `/trials` — audit a candidate store without touching what a subject carries.
 *
 * The whole surface exists so the PR question can be asked: *would this pass?* The answer is a
 * real audit, produced by the same runner reading the same protocol, written somewhere the
 * report index does not look — so asking cannot move a hallmark, cannot enter the backlog and
 * cannot cost a subject a retry.
 *
 * **One input.** A trial names a store zip and an app inside it. An upload session is a way of
 * *producing* that zip rather than a second kind of trial, so past `buildSpec` there is one
 * record, one slug and one pipeline. See `services/trialrun.ts` for why that collapse also
 * fixed a correctness problem rather than only a tidiness one.
 *
 * Three deliberate constraints:
 *
 * - **The same `Runner` instance as an audit.** It is single-flight process-wide, and
 *   `RunLedger.live()` assumes exactly one open run. Sharing it means a trial and an audit
 *   cannot collide, and a trial asked for during an audit takes its place in the same queue an
 *   audit does. A second instance would also break the browser lease, whose safety rests on
 *   "there is one run at a time" being true (`runner/index.ts`).
 * - **Never `scheduler.record()`.** A trial says nothing about a subject's schedule. Since
 *   2026-09-01 the scheduler *starts* trials — it owns the agent, so it has to be the thing
 *   that decides what takes it next — but it still records nothing about a subject for one.
 *   The port it reaches this through carries `queued`, `running`, `dispatch` and `failed`,
 *   and no way to touch a try count, a park or a hallmark.
 * - **Its own index.** A second `ReportIndex` rooted at the trials directory, which the
 *   scheduler and the registry are never handed. That is what makes the isolation structural
 *   rather than a rule to remember.
 */

import { promises as fs } from 'node:fs';

import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { asSubjectKey, subjectKey } from '../../shared/subject.js';
import type { TrialCell, TrialComparison, TrialSummary } from '../../shared/trials.js';
import { renderMarkdown } from '../domain/markdown.js';
import { latestDone, subjectHallmark } from '../domain/hallmark.js';
import type { Runner } from '../runner/index.js';
import type { EventLog } from '../services/events.js';
import type { ReportIndex } from '../store/index.js';
import { isTrialSlug, TrialStore } from '../store/trials.js';
import {
  buildSpec,
  enqueueTrial,
  trialIndex,
  trialsIndex,
  trialsReady,
  type TrialRunDeps,
} from '../services/trialrun.js';
import type { OriginEntry } from '../store/config.js';
import { sectionsOf, type ProtocolStore } from '../store/protocols.js';
import type { UploadStore } from '../store/uploads.js';

export interface TrialRoutesOptions {
  runner?: Runner;
  trials?: TrialStore;
  /** Where trial reports are written. One directory per slug beneath it. */
  trialsRoot?: string;
  events?: EventLog;
  /** The real archive, so a trial can be shown beside what the subject carries today. */
  store?: ReportIndex;
  /** Every subject key the loop knows, for resolving what the trial is about. */
  known?: () => string[];
  /** Upload sessions — one of the two ways a caller can name a store zip. */
  uploads?: UploadStore;
  /** The configured stores, so a trial is judged against the right CONTRIBUTING.md. */
  origins?: OriginEntry[];
  /**
   * The protocol's own section order, so the comparison reads in the order every other screen
   * reads. Absent, the sections fall out of a directory listing, which is alphabetical and put
   * `functional` above `static` — the reverse of the Overview's two columns, on the one page
   * whose whole job is being compared against them.
   */
  protocols?: ProtocolStore;
  /** Touchstone's external address, so a trial can hand a bench the store it audited. */
  publicBaseUrl?: string;
  /** Injected in tests so a trial can be started without reaching GitHub. */
  fetchImpl?: typeof fetch;
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

const routes: FastifyPluginAsync<TrialRoutesOptions> = async (app, options) => {
  /** The one place the trial services are assembled, so both verbs see the same wiring. */
  const trialDeps = (): TrialRunDeps => ({
    runner: options.runner,
    trials: options.trials,
    uploads: options.uploads,
    trialsRoot: options.trialsRoot,
    events: options.events,
    known: options.known,
    origins: options.origins,
    publicBaseUrl: options.publicBaseUrl,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    onError: (err, slug) => app.log.error({ err, slug }, 'trial failed'),
  });

  /**
   * The list, with each trial's own sections on it.
   *
   * The row used to carry the record alone — one aggregate `outcome` for the whole job — and
   * the page drew it as a single `Result` cell. That threw away the answer a trial is run to
   * get: static failing and functional blocked are two different facts, and one word cannot
   * hold both. So the sections come along, composed by `subjectHallmark` over an index of the
   * trials tree — the same function the Store page's rows come from, so the two tables cannot
   * come to disagree about what `blocked` looks like or what counts toward risk.
   *
   * One index for the whole list rather than one per trial: `trialsIndex` walks the tree once
   * and the slug-as-origin does the separating. A trial with no reports yet — still running,
   * or blocked before it wrote one — composes a never-run row, which is what it is.
   */
  app.get('/trials', async () => {
    const rows = options.trials?.list() ?? [];
    if (rows.length === 0) return { trials: [] };
    const index = await trialsIndex(options.trialsRoot ?? '');
    const records = index.all();
    const trials: TrialSummary[] = rows.map((trial) => ({
      ...trial,
      state: subjectHallmark(subjectKey(trial.slug, trial.subject), records).state,
    }));
    return { trials };
  });

  app.post<{ Body?: Record<string, unknown> }>('/trials', async (req, reply) => {
    const deps = trialDeps();
    // What is left to refuse is a feature that is unconfigured or a runner that is switched
    // off. "The agent is busy" is no longer among them: that is what the queue is for.
    const blocked = trialsReady(deps);
    if (blocked) return fail(reply, blocked.code, blocked.error);

    const body = req.body ?? {};
    const startedAt = new Date().toISOString();

    /**
     * Two ways to name a store, and one pipeline past this point.
     *
     * `{ upload }` zips the bytes in a session; `{ store_url }` fetches an archive through the
     * host allowlist. Either way the result is one zip, and the app is read out of that zip —
     * so the bytes the static section judges are the bytes the bench installs.
     */
    const built = await buildSpec(deps, body, startedAt);
    if (!built.ok) return fail(reply, built.code, built.error);

    const record = await enqueueTrial(deps, built.spec, startedAt, built.compare_to);
    // `queued`, not `started`. The scheduler decides when it runs, and on an idle box the kick
    // inside `enqueueTrial` means that is a second from now — but saying "started" for
    // something that may sit behind two audits is the lie the 409 used to tell backwards.
    const position = options.trials?.queued().findIndex((t) => t.slug === record.slug) ?? -1;
    return reply
      .code(202)
      .send({ queued: true, trial: record, ...(position >= 0 ? { position: position + 1 } : {}) });
  });

  /**
   * A trial's own copy of the store, for a demo bench to install from.
   *
   * **This is the one address here meant to be fetched from outside the box**, because the
   * thing fetching it is a demo instance on the public internet with no credentials of ours.
   * The token in the path is the whole guard, and it is minted per trial — which is also what
   * makes Maison's in-process store cache harmless: it has never seen this URL.
   *
   * Deliberately *not* under `/public`. That prefix is the board an app author is sent to and
   * it "hands out no address it will not serve"; putting caller-supplied bytes in its namespace
   * would muddy exactly the property that makes publishing it safe. This lives under `/api/v1`
   * with everything else and is exempted from the SSO gate by name.
   *
   * The three headers are not decoration. Touchstone's origin also serves the operator UI, so
   * bytes somebody uploaded must never be sniffed into HTML and rendered there; and a store zip
   * that got cached would reintroduce the staleness this whole design exists to remove.
   */
  app.get<{ Params: { file: string } }>('/trialstore/:file', async (request, reply) => {
    const named = /^([A-Za-z0-9_-]+)\.zip$/.exec(request.params.file);
    if (!named) return fail(reply, 404, 'no such trial store');
    const found = options.trials?.byStoreToken(named[1]!);
    if (!found || !options.trials) return fail(reply, 404, 'no such trial store');

    let zip: Buffer;
    try {
      zip = await fs.readFile(options.trials.storeZipPath(found.slug));
    } catch {
      // The row outliving its bytes means the trial was swept mid-run. A 404 is the honest
      // answer: the bench's install will fail and the section is recorded errored infra.
      return fail(reply, 404, 'no such trial store');
    }

    return reply
      .type('application/zip')
      .header('content-disposition', `attachment; filename="${found.subject}-trial.zip"`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(zip);
  });

  app.get<{ Params: { slug: string } }>('/trials/:slug', async (request, reply) => {
    const { slug } = request.params;
    if (!isTrialSlug(slug)) return fail(reply, 400, 'invalid trial id');
    const trial = options.trials?.get(slug);
    if (!trial) return fail(reply, 404, `unknown trial: ${slug}`);

    const index = await trialIndex(options.trialsRoot ?? '', slug);
    const key = subjectKey(slug, trial.subject);
    const mine = index.forSubject(key);

    // The trial beside what the subject carries today. Which is the point of running one: a
    // verdict on a branch means little until you know whether it is better or worse than the
    // thing it would replace.
    const current = trial.compare_to ? (options.store?.forSubject(asSubjectKey(trial.compare_to)) ?? []) : [];
    const seen = [...new Set([...index.sections(), ...current.map((r) => r.meta.section)])];
    // The protocol's `order`, and only as a *sort key* — a section it has never heard of still
    // appears, after the ones it declares. Dropping one would hide an assay the runner wrote,
    // which is the failure invariant 6 names: a section the gate does not read is where a
    // Critical hides.
    const declared = sectionsOf(await (options.protocols?.list() ?? Promise.resolve([])));
    const rank = new Map(declared.map((d) => [d.id, d.order]));
    const sections = seen.sort((a, b) => {
      const ra = rank.get(a) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b) ?? Number.MAX_SAFE_INTEGER;
      return ra === rb ? a.localeCompare(b) : ra - rb;
    });
    // The whole of `AssayMeta` the status vocabulary reads, not a summary of it. `blocked_reason`
    // especially: `domain/assay.ts` writes a different sentence for each of the four ways a
    // section can block, and a cell that cannot see which one applies can only ever offer one
    // of them. It offered the `store_url_unconfigured` advice for an empty bench pool.
    const shape = (rec: (typeof mine)[number] | null): TrialCell | null =>
      rec
        ? {
            status: rec.meta.status,
            verdict: rec.meta.verdict ?? null,
            top_severity: rec.meta.top_severity,
            risk_score: Number(rec.meta.risk_score) || 0,
            blocked_reason: rec.meta.blocked_reason ?? null,
            standard: rec.meta.standard,
            standard_sha256: rec.meta.standard_sha256,
            standard_version: rec.meta.standard_version,
            started_at: rec.meta.started_at,
          }
        : null;

    const comparison: TrialComparison[] = sections.map((section) => ({
      section,
      trial: shape(index.latestAny(key, section)),
      current: shape(latestDone(current, trial.compare_to ?? '', section)),
    }));

    // The same composition the list and the Store page use, over this trial's own reports —
    // so the cards and the tabs below the comparison read a trial exactly as they read a
    // subject, and `scores: false` stays out of the risk figure without this route knowing why.
    const state = subjectHallmark(key, index.all()).state;

    return { trial, comparison, state, history: mine };
  });

  /** The trial's own report file, rendered — the same viewer the archive uses. */
  app.get<{ Params: { slug: string; file: string } }>(
    '/trials/:slug/reports/:file',
    async (request, reply) => {
      const { slug, file } = request.params;
      if (!isTrialSlug(slug) || file.includes('/') || file.includes('..')) {
        return fail(reply, 400, 'invalid report path');
      }
      const trial = options.trials?.get(slug);
      if (!trial) return fail(reply, 404, `unknown trial: ${slug}`);

      const index = await trialIndex(options.trialsRoot ?? '', slug);
      const record = index.all().find((r) => r.file === file);
      if (!record) return fail(reply, 404, `unknown report: ${file}`);
      const stored = await index.read(record.path);
      if (!stored) return fail(reply, 410, `report file missing: ${record.path}`);

      return {
        meta: stored.meta,
        html: renderMarkdown(stored.body ?? ''),
        raw: stored.raw ?? stored.body ?? '',
      };
    },
  );

  app.delete<{ Params: { slug: string } }>('/trials/:slug', async (request, reply) => {
    const { slug } = request.params;
    if (!isTrialSlug(slug)) return fail(reply, 400, 'invalid trial id');
    const removed = await options.trials?.remove(slug);
    if (!removed) return fail(reply, 404, `unknown trial: ${slug}`);
    // The reports go with the row. A trial is about a branch: when you are done with the
    // branch you are done with the evidence, and a row-only delete left directories nothing
    // could see or reach — carried in every backup and uninstall archive for good.
    return { deleted: slug };
  });
};

export default routes;
