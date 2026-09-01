/**
 * `POST /assays` and `GET /assays/current` — ask for one app to be audited.
 *
 * **It enqueues; it does not run.** Until 2026-09-01 this took the single agent directly and
 * answered `409 an audit is already running` when it could not, which is not an answer — it is
 * the caller being told to press the button again later, and it is why the operator learned
 * that the control which always worked (the flag) was the one that appeared to do nothing.
 *
 * What it does now is write the request and ask the scheduler to look. **Every admission
 * decision lives in the tick** — is the agent free, is there a bench, who asked first, is the
 * loop armed — so this route duplicates none of it and cannot drift from it. "Starts
 * immediately" is not a special case here: it is what the tick does when the line is empty,
 * and a request bypasses the cooldown so an idle box really does start within the second.
 *
 * Two refusals survive, and they are configuration answers rather than admission ones: there
 * is no runner, or the runner is switched off. Neither is fixed by waiting, and enqueuing into
 * work that can never run would leave a request at the head of a queue for ever.
 *
 * `wait: true` is gone with the direct-run path it depended on. A socket held open for a
 * ten-minute audit was at the mercy of every proxy in between anyway; `GET /assays/current` is
 * how a run is followed.
 */

import type { FastifyPluginAsync } from 'fastify';

import { PHASE_LABEL, type RunStatus } from '../../shared/activity.js';
import type { SubjectKey } from '../../shared/subject.js';
import { ambiguousMessage, resolveSubjectKey } from '../domain/subjects.js';
import { coverageOf } from '../services/ledger.js';
import type { BenchProber } from '../services/bench.js';
import type { RunLedger } from '../services/ledger.js';
import type { Runner } from '../runner/index.js';
import type { Scheduler } from '../scheduler/index.js';

export interface AssayRoutesOptions {
  runner?: Runner;
  /** The in-flight run, so a six-minute wait can show what it has established so far. */
  ledger?: RunLedger;
  scheduler?: Scheduler;
  /** The demo pool, reported on `/assays/current` — see the `bench` field there. */
  prober?: BenchProber;
}

/** How many settled requirements ride along. Enough to see movement, not a second report. */
const RECENT_REQUIREMENTS = 5;

/** A section's phase plan, labelled. The labels are the protocol's; `PHASE_LABEL` is the
 * fallback for a plan that names an id the table predates. */
function planOf(section: { phases: string[] }): { id: string; label: string }[] {
  return section.phases.map((id) => ({ id, label: PHASE_LABEL[id] ?? id }));
}

interface Body {
  subject?: string;
}

const routes: FastifyPluginAsync<AssayRoutesOptions> = async (app, options) => {
  /**
   * What is running, and what the last run produced. Polled by every part of the UI that
   * says something about the run in flight — the strip in the shell, the Overview's running
   * cells, the Activity card and the audit buttons all read this one endpoint.
   */
  app.get('/assays/current', async (): Promise<RunStatus> => {
    const live = options.ledger?.live() ?? null;
    const status = options.runner?.status() ?? { running: null, last: null };
    return {
      enabled: options.runner?.enabled ?? false,
      running: status.running,
      last: status.last,
      /**
       * What the running audit has settled so far. This is the reason the agent reports
       * incrementally at all — without it a six-minute run is a spinner, and a run that dies
       * partway looks identical to one that never started.
       *
       * The rows go out, not just their counts. `7 of 24` says how far along it is; `E9 auth
       * gate — pass` says what it is doing, and only the second one tells you a stuck run
       * from a slow one.
       */
      progress: live
        ? {
            ...coverageOf(live.requirements),
            of_canonical: live.canonical.length,
            // The plan, so the page can draw the track before anything has been reported —
            // and so it draws no track at all for a run whose sections have no phases.
            phase_plan: live.sections.flatMap((s) => planOf(s)),
            // The same work, split by the section that owns it. The merged fraction above
            // is true of the run and of neither section — `static` can be nearly done while
            // `functional` has not started, and one bar cannot say that.
            sections: live.sections.map((s) => {
              const mine = live.requirements.filter((r) => r.section === s.id);
              const { verified, failed } = coverageOf(mine);
              return {
                id: s.id,
                verified,
                failed,
                of_canonical: live.canonical.filter((c) => c.section === s.id).length,
                phase_plan: planOf(s),
              };
            }),
            phases: live.phases,
            // Settled order, newest first. The ledger appends and revises in place, so the
            // tail is the most recent work without sorting timestamps that may tie.
            recent: [...live.requirements].slice(-RECENT_REQUIREMENTS).reverse(),
          }
        : null,
      /**
       * The demo pool rides along, because every surface that offers to *start* a run is
       * already subscribed here.
       *
       * The re-assay button used to fetch `GET /benches` once on mount and keep a single
       * boolean from it, so its "no bench" note was a snapshot from page load — which is how
       * an operator came to act on a bench verdict that had been false for five minutes. One
       * poller, one answer, and the button can no longer disagree with the strip above it.
       */
      ...(options.prober ? { bench: { leasable: options.prober.leasable().length, window: options.prober.window() } } : {}),
      // The depth of the request queue, so the strip on every page can say what is after this
      // one. Absent rather than 0 when no scheduler is wired, which is not the same answer.
      ...(options.scheduler ? { queued: (await options.scheduler.previewRequests()).length } : {}),
    };
  });

  app.post<{ Body?: Body }>('/assays', async (req, reply) => {
    const asked = String(req.body?.subject ?? '').trim();
    if (!asked) return reply.code(400).send({ error: 'subject is required' });

    const scheduler = options.scheduler;
    if (!scheduler) return reply.code(503).send({ error: 'no scheduler is wired up' });

    /**
     * Resolved **strictly**, which is a change and a deliberate one.
     *
     * This route used to run an unknown name anyway, on the reasoning that the registry may be
     * mid-refresh and refusing would make a first-ever audit impossible. That reasoning does
     * not survive the queue: the tick's candidate set is `registry.list()`, so a request
     * written against a key outside it is never read, never drains, and leaves a row in
     * `state/schedule.json` that only a delete removes. A 404 naming the app is a better
     * answer than a request that silently goes nowhere, and the mid-refresh window is seconds.
     */
    const known = scheduler.knownSubjects();
    const resolved = resolveSubjectKey(asked, known);
    if (resolved.kind === 'ambiguous') {
      return reply.code(400).send({ error: ambiguousMessage(asked, resolved.candidates) });
    }
    if (resolved.kind !== 'ok') {
      return reply.code(404).send({ error: `No app called ${asked} is in the store list.` });
    }
    const subject: SubjectKey = resolved.key;

    const runner = options.runner;
    if (!runner) return reply.code(503).send({ error: 'no runner configured' });
    if (!runner.enabled) {
      // Not something a retry fixes, and not something a queue fixes either: it is off on
      // purpose, and the message says where to turn it on. Refused rather than enqueued, or
      // the request would sit at the head of a queue nothing could ever drain.
      return reply.code(409).send({ error: 'the runner is disabled — set runner.enabled in config.yaml' });
    }

    // The request itself. Already-requested is not an error and not a second request: the
    // timestamp is left where it is, so pressing Audit twice does not send the app to the
    // back of its own queue.
    const changed = await scheduler.setFlagged(subject, true, 'operator');

    // Ask the loop to look now rather than at the top of the hour. Its decision is not read
    // back: `tick()` coalesces with one already running and then hands out the *previous*
    // decision, which describes work this request had no part in.
    await scheduler.tick();

    // Answered from state, which is the only honest source. A claim on this subject means the
    // tick took it; anything else means it is in the line, and `previewRequests` says where.
    const started = Boolean(scheduler.snapshot().subjects[subject]?.claim);
    const queue = await scheduler.previewRequests();
    const at = queue.findIndex((r) => r.kind === 'audit' && r.id === subject);

    return reply.code(202).send({
      queued: true,
      started,
      already: !changed,
      subject,
      ...(at >= 0 ? { position: at + 1 } : {}),
      ...(started ? {} : { running: runner.status().running }),
    });
  });
};

export default routes;
