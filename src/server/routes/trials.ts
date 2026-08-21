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
import path from 'node:path';

import { asSubjectKey, subjectKey } from '../../shared/subject.js';
import type { TrialComparison, TrialRecord } from '../../shared/trials.js';
import { renderMarkdown } from '../domain/markdown.js';
import { latestDone } from '../domain/hallmark.js';
import { resolveSubjectKey } from '../domain/subjects.js';
import type { Runner } from '../runner/index.js';
import type { EventLog } from '../services/events.js';
import { buildIndex, type ReportIndex } from '../store/index.js';
import {
  isTrialSlug,
  TrialInputError,
  trialSlug,
  TrialStore,
  validateTrial,
} from '../store/trials.js';

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
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

/**
 * A trial's reports, read on demand.
 *
 * Built per request rather than held, because trials are rare and a warm index of debris is not
 * worth a cache. **`cacheFile: null` is load-bearing**: `defaultCacheFile()` derives
 * `<dirname(root)>/state/index.json`, which for `data/trials` is the *same file* the archive's
 * index uses. Two indexes writing it would clobber each other and cross-serve records.
 */
function trialIndex(root: string): Promise<ReportIndex> {
  return buildIndex(root, { cacheFile: null });
}

const routes: FastifyPluginAsync<TrialRoutesOptions> = async (app, options) => {
  const rootOf = (slug: string) => path.join(options.trialsRoot ?? '', slug);

  app.get('/trials', async () => ({ trials: options.trials?.list() ?? [] }));

  app.post<{ Body?: Record<string, unknown> }>('/trials', async (req, reply) => {
    const trials = options.trials;
    const runner = options.runner;
    if (!trials || !options.trialsRoot) return fail(reply, 503, 'trials are not configured');
    if (!runner) return fail(reply, 503, 'no runner configured');
    if (!runner.enabled) {
      return fail(reply, 409, 'the runner is disabled — set runner.enabled in config.yaml');
    }
    if (runner.busy) {
      // One agent, one run. Saying which kind is running is the difference between "wait" and
      // "something is stuck".
      const running = runner.status().running;
      return reply.code(409).send({ error: 'a run is already in progress', running });
    }

    let input;
    try {
      // These reach a prompt the agent runs `gh` against, so they are checked here rather than
      // trusted: this is the one place a caller chooses what repository gets read.
      input = validateTrial(req.body ?? {});
    } catch (err) {
      if (err instanceof TrialInputError) return fail(reply, 400, err.message);
      throw err;
    }

    const startedAt = new Date().toISOString();
    const slug = trialSlug(input, startedAt);

    // What this trial is *about*, when the app also exists in a configured store — so the
    // result can be put beside what that subject currently carries. A branch adding a new app
    // has no counterpart, which is a normal PR and not an error.
    const match = resolveSubjectKey(input.subject, options.known?.() ?? []);

    const record: TrialRecord = {
      slug,
      repo: input.repo,
      ref: input.ref,
      apps_path: input.apps_path,
      subject: input.subject,
      ...(match.kind === 'ok' ? { compare_to: match.key } : {}),
      started_at: startedAt,
    };
    await trials.add(record);

    options.events?.log({
      level: 'info',
      code: 'TRIAL_STARTED',
      message: `Trialling ${input.subject} from ${input.repo}@${input.ref}`,
      detail: { slug, repo: input.repo, ref: input.ref, subject: input.subject },
    });

    // Fire and report, exactly as `POST /assays` does: a real audit takes minutes and a socket
    // held that long is at the mercy of every proxy in between.
    void runner
      .run({
        // The slug is the synthetic origin, so the report path machinery is untouched.
        subject: subjectKey(slug, input.subject),
        try_n: 1,
        trial: { repo: input.repo, ref: input.ref, apps_path: input.apps_path, root: rootOf(slug) },
      })
      .then(async (outcome) => {
        const finished = new Date().toISOString();
        if (outcome.kind === 'verdict') {
          await trials.update(slug, {
            finished_at: finished,
            outcome: 'verdict',
            verdict: outcome.verdict,
            risk_score: outcome.risk,
            files: outcome.files,
          });
          options.events?.log({
            level: 'info',
            code: 'TRIAL_COMPLETED',
            message: `Trial of ${input.subject} at ${input.ref} — ${outcome.verdict}`,
            detail: {
              slug,
              subject: input.subject,
              verdict: outcome.verdict,
              risk: outcome.risk,
              files: outcome.files.length,
            },
          });
          return;
        }
        const reason =
          outcome.kind === 'agent_busy'
            ? 'the agent was busy'
            : outcome.kind === 'blocked'
              ? outcome.reason
              : outcome.reason;
        await trials.update(slug, { finished_at: finished, outcome: outcome.kind, error: reason });
        options.events?.log({
          level: 'warn',
          code: 'TRIAL_FAILED',
          message: `Trial of ${input.subject} at ${input.ref} did not complete — ${reason}`,
          detail: { slug, subject: input.subject, reason },
        });
      })
      .catch((err) => app.log.error({ err, slug }, 'trial failed'));

    return reply.code(202).send({ started: true, trial: record });
  });

  app.get<{ Params: { slug: string } }>('/trials/:slug', async (request, reply) => {
    const { slug } = request.params;
    if (!isTrialSlug(slug)) return fail(reply, 400, 'invalid trial id');
    const trial = options.trials?.get(slug);
    if (!trial) return fail(reply, 404, `unknown trial: ${slug}`);

    const index = await trialIndex(rootOf(slug));
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

      const index = await trialIndex(rootOf(slug));
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
    // The reports stay on disk. Deleting the row is a tidy-up of the list; removing an audit
    // somebody may still be reading is a different and more destructive act.
    return { deleted: slug };
  });
};

export default routes;
