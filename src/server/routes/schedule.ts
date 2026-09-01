/**
 * `GET /schedule`, `POST /schedule/arm` and `POST /schedule/tick` — what the driver thinks,
 * a switch for whether it may act on it, and a way to ask it to think again.
 *
 * This exists for shadow mode before it exists for the UI. The whole validation technique
 * for phase 1 is comparing our pick against n8n's `- **State:**` line, and that comparison
 * needs a single endpoint that answers "what would you do right now, and why" without
 * waiting an hour for the timer.
 *
 * `POST /schedule/tick` is safe to call while the scheduler is disarmed — it decides and
 * logs and claims nothing. Once armed it *will* claim, which is why the response says which
 * mode answered rather than leaving the caller to assume.
 */

import { asSubjectKey } from '../../shared/subject.js';
import { resolveSubjectKey } from '../domain/subjects.js';
import { SUBJECT_KEY_SEP, subjectName } from '../../shared/subject.js';

/**
 * Replace any `<origin>~<name>` in a prose line with the bare app name.
 *
 * Only touches tokens that actually carry the separator, so a line with no subject in it — or
 * with an app whose name happens to contain a tilde — comes back unchanged.
 */
function displayKeys(line: string): string {
  return line.replace(
    new RegExp(`[A-Za-z0-9._-]+${SUBJECT_KEY_SEP}[A-Za-z0-9._-]+`, 'g'),
    (m) => subjectName(m),
  );
}
import type { FastifyPluginAsync } from 'fastify';

import type { ScheduleResponse } from '../../shared/schedule.js';
import type { Scheduler } from '../scheduler/index.js';
import type { Runner } from '../runner/index.js';
import type { SubjectRegistry } from '../store/registry.js';

export interface ScheduleRoutesOptions {
  scheduler?: Scheduler;
  registry?: SubjectRegistry;
  /**
   * Read for one field. The page has to be able to say "armed, but the runner is off"
   * *before* someone presses start, and the alternative — a second fetch the page joins by
   * hand — puts the precondition and the switch on different clocks.
   */
  runner?: Runner;
}

const routes: FastifyPluginAsync<ScheduleRoutesOptions> = async (app, options) => {
  const answer = async (): Promise<ScheduleResponse> => {
    const snap = options.scheduler?.snapshot();
    return {
      // Absent rather than false when there is no scheduler at all, so "disarmed" and
      // "not wired up" cannot be confused on the page that reports it.
      armed: snap?.armed ?? null,
      armed_default: snap?.armed_default ?? null,
      armed_source: snap?.armed_source ?? 'config',
      runner_enabled: options.runner ? options.runner.enabled : null,
      // `stateLine()` embeds the subject, and the subject is a key — `yundera~AIOStreams`.
      // That is an address, not something to show a person, so it is split here at the wire
      // rather than in `policy.ts`, whose whole value is being byte-diffable against the live
      // n8n loop. Same reason the queue rows are rendered by their bare name.
      last_tick: snap?.last_tick
        ? { ...snap.last_tick, state: displayKeys(snap.last_tick.state) }
        : null,
      next_tick_at: snap?.next_tick_at ?? null,
      last_finished_at: snap?.last_finished_at ?? null,
      cooldown_left_min: snap?.cooldown_left_min ?? 0,
      constants: snap?.constants ?? {
        tick_min: 0,
        fresh_days: 0,
        stuck_days: 0,
        lease_min: 0,
        cooldown_min: 0,
        max_tries: 0,
      },
      // Bare names on the way out, for the same reason the State line gets them: `label` is
      // what a person reads and `id` is the address, and `policy.ts` deals only in addresses
      // because its output is diffed and tested rather than rendered.
      requests: ((await options.scheduler?.previewRequests()) ?? []).map((r) =>
        r.kind === 'audit' ? { ...r, label: subjectName(r.label) } : r,
      ),
      queue: (await options.scheduler?.previewQueue()) ?? [],
      subjects: snap?.subjects ?? {},
      registry: {
        count: options.registry?.list().length ?? 0,
        live: options.registry?.isLive ?? false,
        fetched_at: options.registry?.lastFetchedAt ?? null,
        origins: options.registry?.status() ?? [],
      },
    };
  };

  app.get('/schedule', async () => answer());

  /**
   * Start or stop automated mode.
   *
   * Stopping does not touch the audit in flight — see `Scheduler.setArmed`. It also does not
   * touch `runner.enabled`: that switch gates hand-run assays too, and a start button that
   * quietly turned the manual path on as well would be doing something nobody asked for.
   */
  app.post<{ Body?: { armed?: unknown } }>('/schedule/arm', async (req, reply) => {
    if (!options.scheduler) return reply.code(503).send({ error: 'No scheduler is wired up.' });
    const armed = req.body?.armed;
    if (typeof armed !== 'boolean') {
      return reply.code(400).send({ error: 'Send { "armed": true } or { "armed": false }.' });
    }
    await options.scheduler.setArmed(armed);
    // Decide immediately on start, so pressing the button either produces a claim or says
    // in one sentence why it did not. An hour of silence is not an answer.
    if (armed) await options.scheduler.tick();
    return answer();
  });

  /**
   * Flag an app for re-audit, or take the flag off.
   *
   * Deliberately *not* a dispatch. `POST /assays` starts an audit now and contends with
   * whatever else has the agent; this only says "include it in the backlog", and the loop
   * reaches it in its own order under the same cooldown, park and bench gate as everything
   * else. The response is the whole schedule answer, so the caller sees the queue the flag
   * produced rather than having to ask again.
   *
   * The subject is resolved against what the loop knows for the same reason `/schedule/tick`
   * does it: a name typed on a page is not a key, and flagging a subject the registry has
   * never heard of would write a row nothing ever reads.
   */
  app.post<{ Body?: { subject?: unknown; flagged?: unknown } }>(
    '/schedule/flag',
    async (req, reply) => {
      if (!options.scheduler) return reply.code(503).send({ error: 'No scheduler is wired up.' });
      const { subject, flagged } = req.body ?? {};
      if (typeof subject !== 'string' || !subject.trim()) {
        return reply.code(400).send({ error: 'Send { "subject": "<app>", "flagged": true }.' });
      }
      if (typeof flagged !== 'boolean') {
        return reply.code(400).send({ error: 'Send { "flagged": true } or { "flagged": false }.' });
      }
      const hit = resolveSubjectKey(subject, options.scheduler.knownSubjects());
      if (hit.kind !== 'ok') {
        return reply.code(404).send({
          error:
            hit.kind === 'ambiguous'
              ? `More than one app is called ${subject} — name the store too, as <store>~${subject}.`
              : `No app called ${subject} is in the store list.`,
        });
      }
      const changed = await options.scheduler.setFlagged(hit.key, flagged);
      return { ...(await answer()), subject: hit.key, flagged, changed };
    },
  );

  /**
   * Think again, now. Takes no body.
   *
   * It used to accept `{ forced: [...] }` — one app name that bypassed freshness and the
   * cooldown, n8n's form trigger ported across. The request queue replaced it on 2026-09-01:
   * `POST /assays` is the same intention arrived at honestly, from a button, with a place in
   * a line and a row an operator can see and cancel. `forced` had no UI caller and no way to
   * be seen once pressed, and two spellings of "run this one now" is how they drift.
   */
  app.post('/schedule/tick', async () => {
    if (!options.scheduler) return { ...(await answer()), ran: false };
    const decision = await options.scheduler.tick();
    return { ...(await answer()), ran: true, decision };
  });
};

export default routes;
