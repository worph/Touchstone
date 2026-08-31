/**
 * `/public` — the conformance board, for the people whose apps are being judged.
 *
 * Everything else in this API is an operator surface: it starts runs, arms the loop, edits the
 * protocol, talks to an agent. This prefix is the one part of Touchstone that is meant to be
 * readable by somebody who does not operate it — an app author who wants to know what the
 * standard says about their app and what to change. §8's AppShield sidecar terminates SSO in
 * front of the whole process, so "public" here means *the one prefix that may be excluded from
 * that*, and the value of the namespace is precisely that excluding it is a one-line decision
 * rather than an audit of forty handlers.
 *
 * Three rules hold it to that:
 *
 * - **It is read-only by construction, not by convention.** `assertReadOnly` runs on every
 *   route registered under this plugin and throws at boot on anything but GET/HEAD. A future
 *   `POST /public/…` does not ship and get noticed; it fails to start the server.
 * - **It hands out no address it will not serve.** There is no public report-file endpoint, so
 *   nothing here links into `/reports/*`, and the fix brief — which is the audit turned round
 *   to face a developer — is the whole of the evidence a visitor gets.
 * - **It composes nothing of its own.** The rows are `hallmarks()` and the brief is
 *   `buildFixReport()`, the same functions the operator pages read. A second composition would
 *   be a second opinion, and the public one would be the one nobody checks.
 *
 * History is deliberately absent (ARCHITECTURE §1.4 G): a visitor gets the hallmark each
 * subject carries now, which is the thing the hallmark *is*.
 */

import type { FastifyPluginAsync, FastifyReply, RouteOptions } from 'fastify';

import type { SubjectState } from '../../shared/types.js';
import { buildFixReport, fixReportFilename } from '../domain/fixreport.js';
import { hallmarks, subjectHallmark, subjectNames } from '../domain/hallmark.js';
import { readStandards } from '../domain/standards.js';
import { recordsForSubject, type AssayStore } from '../domain/store.js';
import type { ProtocolStore } from '../store/protocols.js';
import { ambiguousMessage, resolveSubjectKey } from '../domain/subjects.js';

export interface PublicRoutesOptions {
  /** The archive. Same instance the operator routes read — one composition, one answer. */
  store: AssayStore;
  /**
   * The rubric, read for one thing only: which revision judged each verdict on display.
   *
   * An app author is the person most entitled to know that the pass they are looking at was
   * reached under a rubric that has since been edited — it is the difference between "you
   * are done" and "this will be looked at again". Read-only, like everything here, and the
   * `onRoute` guard above is what keeps that true rather than this comment.
   */
  protocols?: ProtocolStore;
  /**
   * What the stores currently offer: each app's version, for the `app changed` badge, and
   * which archived apps are gone from the store entirely, for the `delisted` one.
   *
   * The board's readers are the app authors, and "this verdict is about a compose you have
   * since rewritten" is the single most useful thing it can tell them — with "and this app
   * is not in the store any more" a close second, since a board that goes on publishing a
   * verdict about a withdrawn app is publishing it about nothing.
   *
   * Structurally typed rather than `SubjectRegistry`, and both members are read-only, which
   * is invariant 10 expressed in the type: nothing this file can reach has a verb.
   */
  registry?: { versions: () => Record<string, string>; delisted: () => string[] };
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

/**
 * The guard behind rule one. Registered as an `onRoute` hook, so it runs when a route is
 * *declared* rather than when one is called: a write verb under this prefix is a boot failure
 * with a file and a line in it, which is the only kind of invariant that survives a year.
 *
 * Exported so the test can assert the refusal without having to author a broken plugin.
 */
export function assertReadOnly(route: Pick<RouteOptions, 'method' | 'url'>): void {
  const methods = Array.isArray(route.method) ? route.method : [route.method];
  for (const method of methods) {
    if (method === 'GET' || method === 'HEAD') continue;
    throw new Error(
      `the public API is read-only: ${method} ${route.url} may not be registered under /public`,
    );
  }
}

const routes: FastifyPluginAsync<PublicRoutesOptions> = async (app, options) => {
  app.addHook('onRoute', assertReadOnly);

  const store = options.store;

  /**
   * Resolve what somebody typed, exactly as the operator routes do — a bare `FileBrowser`
   * still works, and two stores shipping that name is a 400 naming both rather than a guess.
   * Only the archive is consulted here, deliberately: the registry is the *loop's* list of
   * what it intends to audit, and a public board should show what has been assayed, not what
   * is on a backlog.
   */
  /** The same read the operator routes make, and for the same reason. */
  async function currentStandards() {
    if (!options.protocols) return undefined;
    try {
      return (await readStandards(options.protocols)).sections;
    } catch {
      return undefined;
    }
  }

  function resolve(input: string) {
    const resolved = resolveSubjectKey(input, subjectNames(store.all()));
    if (resolved.kind !== 'ok') return resolved;
    return {
      kind: 'ok' as const,
      name: resolved.key,
      records: recordsForSubject(store, resolved.key),
    };
  }

  // GET /public/subjects — the board. Byte-for-byte the operator table's rows, because it is
  // the same call: a public verdict that differs from the internal one is the bug this
  // namespace would otherwise invite.
  app.get('/public/subjects', async (): Promise<SubjectState[]> =>
    hallmarks(store.all(), {
      standards: await currentStandards(),
      ...(options.registry ? { versions: options.registry.versions() } : {}),
      // An app author looking for their own app is the reader most owed this: their app is
      // on a public board carrying a verdict, and it is not in the store any more. Without
      // the mark the row is indistinguishable from one we are still auditing.
      ...(options.registry ? { delisted: options.registry.delisted() } : {}),
    }));

  // GET /public/subjects/:name — one app. The current assay per section and what each
  // recorded; no history, no report paths to follow, no run state.
  app.get<{ Params: { name: string } }>('/public/subjects/:name', async (request, reply) => {
    const resolved = resolve(request.params.name);
    if (resolved.kind === 'ambiguous') {
      return fail(reply, 400, ambiguousMessage(request.params.name, resolved.candidates));
    }
    if (resolved.kind !== 'ok') return fail(reply, 404, `unknown subject: ${request.params.name}`);
    return subjectHallmark(resolved.name, resolved.records, {
      standards: await currentStandards(),
      ...(options.registry ? { versions: options.registry.versions() } : {}),
      ...(options.registry ? { delisted: options.registry.delisted() } : {}),
    }).state;
  });

  /**
   * GET /public/subjects/:name/fix.md — the same brief the operator gets, for the one person
   * who can actually act on it.
   *
   * It quotes rather than summarises, so there is nothing here an author should be shielded
   * from: it is their app's findings, their evidence, and the remedy the audit proposed —
   * and where it proposed none, it says so instead of inventing one.
   */
  app.get<{ Params: { name: string } }>('/public/subjects/:name/fix.md', async (request, reply) => {
    const resolved = resolve(request.params.name);
    if (resolved.kind === 'ambiguous') {
      return fail(reply, 400, ambiguousMessage(request.params.name, resolved.candidates));
    }
    if (resolved.kind !== 'ok') return fail(reply, 404, `unknown subject: ${request.params.name}`);

    const state = subjectHallmark(resolved.name, resolved.records).state;
    const markdown = buildFixReport({
      subject: state.label,
      sections: Object.values(state.sections)
        .filter(Boolean)
        .map((rec) => ({ meta: rec!.meta, path: rec!.path })),
    });
    // Nothing to brief anyone on. An empty document would read as a clean bill of health,
    // which on a page aimed at the app's author is the worst possible thing to be wrong about.
    if (!markdown) return fail(reply, 404, `no assay to report on for ${resolved.name}`);

    return reply
      .type('text/markdown; charset=utf-8')
      .header('content-disposition', `inline; filename="${fixReportFilename(state.label)}"`)
      .send(markdown);
  });
};

export default routes;
