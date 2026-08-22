/**
 * `/trials` — audit a ref without touching what a subject carries.
 *
 * The whole surface exists so the PR question can be asked: *would this branch pass?* The
 * answer is a real audit, produced by the same runner reading the same protocol, written
 * somewhere the report index does not look — so asking cannot move a hallmark, cannot enter the
 * backlog and cannot cost a subject a retry.
 *
 * Three deliberate constraints:
 *
 * - **The same `Runner` instance as an audit.** It is single-flight process-wide, and
 *   `RunLedger.live()` assumes exactly one open run. Sharing it means a trial and an audit
 *   cannot collide, and a trial asked for during an audit gets the same honest 409 the re-assay
 *   button gets. A second instance would also break the browser lease, whose safety rests on
 *   "there is one run at a time" being true (`runner/index.ts`).
 * - **Never `scheduler.record()`.** A trial says nothing about a subject's schedule.
 * - **Its own index.** A second `ReportIndex` rooted at the trials directory, which the
 *   scheduler and the registry are never handed. That is what makes the isolation structural
 *   rather than a rule to remember.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import { asSubjectKey, subjectKey } from '../../shared/subject.js';
import type { TrialComparison } from '../../shared/trials.js';
import { renderMarkdown } from '../domain/markdown.js';
import { latestDone } from '../domain/hallmark.js';
import type { Runner } from '../runner/index.js';
import type { EventLog } from '../services/events.js';
import type { ReportIndex } from '../store/index.js';
import {
  isTrialSlug,
  TrialInputError,
  trialSlug,
  TrialStore,
  validateTrial,
} from '../store/trials.js';
import {
  dispatchTrial,
  specFromUpload,
  trialIndex,
  trialsReady,
  type TrialRunDeps,
  type TrialSpec,
} from '../services/trialrun.js';
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
  /** Upload sessions, so a trial can audit files instead of a ref. */
  uploads?: UploadStore;
  /** Touchstone's external address, so a trial can hand a bench a store to install from. */
  publicBaseUrl?: string;
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
    publicBaseUrl: options.publicBaseUrl,
    onError: (err, slug) => app.log.error({ err, slug }, 'trial failed'),
  });

  app.get('/trials', async () => ({ trials: options.trials?.list() ?? [] }));

  app.post<{ Body?: Record<string, unknown> }>('/trials', async (req, reply) => {
    const deps = trialDeps();
    const blocked = trialsReady(deps);
    if (blocked) {
      // One agent, one run. Naming what is running is the difference between "wait" and
      // "something is stuck", so the busy case carries it.
      const running = options.runner?.status().running;
      return blocked.code === 409 && running
        ? reply.code(409).send({ error: blocked.error, running })
        : fail(reply, blocked.code, blocked.error);
    }

    const body = req.body ?? {};
    const startedAt = new Date().toISOString();

    /**
     * Two ways to say what to audit, and only one of them names a repository.
     *
     * `{ upload }` audits the bytes in a session — no ref, nothing fetched, nothing that could
     * be stale. `{ repo, ref }` is the original: reviewing a branch that exists.
     */
    let spec: TrialSpec;
    const wanted = String(body.upload ?? '').trim();
    if (wanted) {
      const built = await specFromUpload(options.uploads, wanted, startedAt, options.publicBaseUrl);
      if (!built.ok) return fail(reply, built.code, built.error);
      spec = built.spec;
    } else {
      try {
        // These reach a prompt the agent runs `gh` against, so they are checked here rather
        // than trusted: this is the one place a caller chooses what repository gets read.
        const input = validateTrial(body);
        spec = { ...input, slug: trialSlug(input, startedAt) };
      } catch (err) {
        if (err instanceof TrialInputError) return fail(reply, 400, err.message);
        throw err;
      }
    }

    const record = await dispatchTrial(deps, spec, startedAt);
    return reply.code(202).send({ started: true, trial: record });
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
    const sections = [...new Set([...index.sections(), ...current.map((r) => r.meta.section)])];
    const shape = (rec: (typeof mine)[number] | null) =>
      rec
        ? {
            status: rec.meta.status,
            verdict: rec.meta.verdict ?? null,
            top_severity: rec.meta.top_severity,
            risk_score: Number(rec.meta.risk_score) || 0,
          }
        : null;

    const comparison: TrialComparison[] = sections.map((section) => ({
      section,
      trial: shape(index.latestAny(key, section)),
      current: shape(latestDone(current, trial.compare_to ?? '', section)),
    }));

    return { trial, comparison, history: mine };
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
