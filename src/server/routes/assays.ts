/**
 * `POST /assays` and `GET /assays/current` — audit one app, now.
 *
 * This is n8n's `Audit an app` form trigger, and it is also the validation path: until the
 * scheduler is armed it is the *only* way an audit happens, because two systems auditing the
 * same app contend for one Claude Code endpoint.
 *
 * **It does not wait by default, and that is not a convenience.** A real audit takes five to
 * ten minutes. A browser request held open that long is at the mercy of every proxy between
 * it and here — the Vite dev proxy, AppShield, Caddy — and a socket closed at minute four
 * looks exactly like a failed audit while the agent is still working. So the button starts a
 * run and polls, and `wait: true` stays available for a shell that would rather block.
 */

import type { FastifyPluginAsync } from 'fastify';

import { PHASE_LABEL, type RunStatus } from '../../shared/activity.js';
import { asSubjectKey, type SubjectKey } from '../../shared/subject.js';
import type { ReportResponse } from '../../shared/types.js';
import { ambiguousMessage, resolveSubjectKey } from '../domain/subjects.js';
import { renderMarkdown } from '../domain/markdown.js';
import { coverageOf } from '../services/ledger.js';
import type { RunLedger } from '../services/ledger.js';
import type { Runner, RunOutcome } from '../runner/index.js';
import type { Scheduler } from '../scheduler/index.js';
import type { ReportIndex } from '../store/index.js';

export interface AssayRoutesOptions {
  runner?: Runner;
  /** The in-flight run, so a six-minute wait can show what it has established so far. */
  ledger?: RunLedger;
  scheduler?: Scheduler;
  store?: ReportIndex;
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
  /** Block until the audit finishes and return the report with it. Default false. */
  wait?: boolean;
}

const routes: FastifyPluginAsync<AssayRoutesOptions> = async (app, options) => {
  /**
   * What is running, and what the last run produced. Polled by every part of the UI that
   * says something about the run in flight — the strip in the shell, the Overview's running
   * cells, the Activity card and the re-assay button all read this one endpoint.
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
    };
  });

  app.post<{ Body?: Body }>('/assays', async (req, reply) => {
    const asked = String(req.body?.subject ?? '').trim();
    if (!asked) return reply.code(400).send({ error: 'subject is required' });

    // The button sends a key; a shell or an old bookmark may send a bare app name. Both
    // resolve, and a bare name that exists in two stores is a 400 naming them rather than a
    // silent pick — auditing the wrong store's app would attribute its verdict to the other.
    const known = options.scheduler?.knownSubjects() ?? [];
    const resolved = resolveSubjectKey(asked, known);
    if (resolved.kind === 'ambiguous') {
      return reply.code(400).send({ error: ambiguousMessage(asked, resolved.candidates) });
    }
    // An unknown name still runs: the registry may be mid-refresh, and refusing here would
    // make a first-ever audit impossible. `asSubjectKey` puts a bare name in the default store.
    const subject = resolved.kind === 'ok' ? resolved.key : asSubjectKey(asked);

    const runner = options.runner;
    if (!runner) return reply.code(503).send({ error: 'no runner configured' });
    if (!runner.enabled) {
      // Not something a retry fixes, and not a 500 either: it is off on purpose, and the
      // message says where to turn it on.
      return reply.code(409).send({ error: 'the runner is disabled — set runner.enabled in config.yaml' });
    }
    if (runner.busy) {
      const running = runner.status().running;
      return reply.code(409).send({
        error: 'an audit is already running',
        running,
      });
    }

    // No depth: a run audits every section of the protocol, and the ones whose prerequisites
    // are missing are recorded as blocked rather than narrowing the job.
    const job = { subject, try_n: 1 } as const;

    if (req.body?.wait !== true) {
      // Fire and report. Errors are already classified inside `run`, and anything thrown
      // past it belongs in the log rather than in a response nobody is waiting for.
      void runAndRecord(runner, options.scheduler, job).catch((err) =>
        app.log.error({ err, subject }, 'hand-run assay failed'),
      );
      return reply.code(202).send({ started: true, subject });
    }

    const outcome = await runAndRecord(runner, options.scheduler, job);
    return { subject, outcome, report: await readReport(options.store, outcome) };
  });

  /**
   * The report a run produced, ready to render.
   *
   * The point of a manual trigger is to *read the thing*, so the blocking form hands it back
   * rather than a path the caller has to go and fetch.
   */
  async function readReport(
    store: ReportIndex | undefined,
    outcome: RunOutcome,
  ): Promise<ReportResponse | null> {
    if (!store || outcome.kind !== 'verdict') return null;
    const first = outcome.files[0];
    if (!first) return null;
    const file = await store.read(first);
    if (!file) return null;
    return { meta: file.meta, html: renderMarkdown(file.body), raw: file.raw };
  }
};

/**
 * Run, then tell the scheduler what it cost.
 *
 * A hand-run assay counts for scheduling exactly as a scheduled one does — it stamps the
 * finish, and clears or burns the try. Otherwise running one by hand would leave the subject
 * looking untouched and the next tick would pick it straight back up.
 */
async function runAndRecord(
  runner: Runner,
  scheduler: Scheduler | undefined,
  job: { subject: SubjectKey; try_n: number },
): Promise<RunOutcome> {
  const outcome = await runner.run(job);
  await scheduler?.record(job.subject, toSchedulerOutcome(outcome));
  return outcome;
}

function toSchedulerOutcome(outcome: RunOutcome) {
  switch (outcome.kind) {
    case 'verdict':
      return { kind: 'verdict' as const };
    case 'agent_busy':
      return { kind: 'agent_busy' as const };
    case 'blocked':
      return { kind: 'blocked' as const, reason: outcome.reason };
    default:
      return { kind: 'error' as const, reason: outcome.reason };
  }
}

export default routes;
