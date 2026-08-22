/**
 * `/trials` — the endpoint half.
 *
 * The runner-level guarantees (a trial writes elsewhere, never enters the index, records the
 * functional section blocked) are tested in `runner/runner.test.ts`. What is left here is the
 * surface: what it refuses, and that it shares one agent with audits rather than racing them.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { zipSync } from 'fflate';

import { readAppFromZip } from '../services/trialstore.js';

import { EventLog } from '../services/events.js';
import { defaultCacheFile } from '../store/index.js';
import { TrialStore } from '../store/trials.js';
import type { Runner } from '../runner/index.js';
import routes from './trials.js';

let dir: string;
let app: FastifyInstance;
let trials: TrialStore;
let events: EventLog;

/** A runner that records what it was asked to do and answers with a verdict. */
function runnerOf(over: Partial<{ enabled: boolean; busy: boolean }> = {}) {
  const jobs: unknown[] = [];
  const runner = {
    enabled: over.enabled ?? true,
    busy: over.busy ?? false,
    status: () => ({ running: null, last: null }),
    run: async (job: unknown) => {
      jobs.push(job);
      return { kind: 'verdict' as const, verdict: 'compliant', risk: 0, files: ['a.md'] };
    },
  } as unknown as Runner;
  return { runner, jobs };
}

async function serve(opts: Record<string, unknown>): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(routes, opts as never);
  await instance.ready();
  return instance;
}

const STORE_URL = 'https://github.com/Acme/AppStore/archive/refs/heads/pr-812.zip';
const BODY = { store_url: STORE_URL, subject: 'Widget' };

/**
 * A store zip in GitHub's shape — one wrapper directory, then `Apps/<App>/`.
 *
 * **Two apps**, because a real store has fifty and the thing being asserted downstream is that
 * a trial keeps and serves only the one it audited. A single-app fixture would pass that test
 * by accident.
 */
function storeZip(app = 'Widget'): Buffer {
  const enc = new TextEncoder();
  return Buffer.from(
    zipSync({
      [`AppStore-pr-812/Apps/${app}/docker-compose.yml`]: enc.encode('services: {}\n'),
      'AppStore-pr-812/Apps/Bystander/docker-compose.yml': enc.encode('services: {}\n'),
      'AppStore-pr-812/Apps/Bystander/screenshot.png': enc.encode('not this app '.repeat(400)),
    }),
  );
}

/** Serves that zip to whatever asks, so no test reaches GitHub. */
function fetchOf(zip: Buffer = storeZip()): typeof fetch {
  return (async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': String(zip.byteLength) }),
    arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
  })) as unknown as typeof fetch;
}

/** Wait for a condition, or fail with what it was still waiting on. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`condition still false after ${ms}ms`);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-trials-'));
  events = new EventLog(dir);
  await events.load();
  trials = new TrialStore(dir, path.join(dir, 'trials'));
  await trials.load();
});

afterEach(async () => {
  await app?.close();
  // Retry once: a run dispatched by a test can still be writing as this fires, and a teardown
  // that fails the test it is tearing down hides whatever the test actually proved.
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('POST /trials', () => {
  it('starts a trial and answers before it finishes', async () => {
    const { runner, jobs } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events, fetchImpl: fetchOf() });

    const res = await app.inject({ method: 'POST', url: '/trials', payload: BODY });

    // 202, not 200: an audit takes minutes, and a socket held that long is at the mercy of
    // every proxy between here and the browser.
    expect(res.statusCode).toBe(202);
    const body = res.json() as { trial: { slug: string; source_url: string } };
    expect(body.trial.source_url).toBe(STORE_URL);

    // Poll rather than sleep. `POST /trials` answers 202 and dispatches the run without
    // awaiting it, so a fixed wait is a race that only loses when the suite is busy — which is
    // exactly when a flake is least welcome and hardest to read.
    await waitFor(() => jobs.length === 1);
    expect(jobs).toHaveLength(1);
    // And wait for the dispatch chain to *finish* writing. `POST /trials` returns before the
    // run does, so without this the outcome lands in `trials.json` while `afterEach` is
    // deleting the temp directory — an ENOTEMPTY that reads as a trials bug and is a test one.
    await waitFor(() => trials.get(body.trial.slug)?.outcome !== undefined);
    const job = jobs[0] as {
      subject: string;
      trial: { repo: string; root: string; store_url?: string; source: { compose: string } };
    };
    // The slug is the synthetic origin, so the path machinery needs no special case.
    expect(job.subject).toBe(`${body.trial.slug}~Widget`);
    expect(job.trial.root).toContain(body.trial.slug);
    // The app was read out of the archive rather than fetched separately — which is what makes
    // the bytes judged and the bytes installed the same thing.
    expect(job.trial.source.compose).toContain('services:');
  });

  it('refuses input that would choose what this process fetches', async () => {
    const { runner, jobs } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events, fetchImpl: fetchOf() });

    for (const bad of [
      { ...BODY, store_url: 'not-a-url' },
      { ...BODY, store_url: 'http://github.com/Acme/AppStore/archive/main.zip' },
      // The allowlist, reached through the route: a URL that parses but names a host this
      // process may not be made to GET.
      { ...BODY, store_url: 'https://169.254.169.254/latest/meta-data.zip' },
      { ...BODY, apps_path: '../secrets' },
      { ...BODY, subject: 'a/b' },
      {},
    ]) {
      const res = await app.inject({ method: 'POST', url: '/trials', payload: bad });
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(jobs).toEqual([]);
  });

  it('shares one agent with audits rather than racing them', async () => {
    // The Runner is single-flight process-wide and `RunLedger.live()` assumes one open run.
    // Sharing the instance is what makes that safe; the honest cost is this 409.
    const { runner, jobs } = runnerOf({ busy: true });
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events, fetchImpl: fetchOf() });

    const res = await app.inject({ method: 'POST', url: '/trials', payload: BODY });
    expect(res.statusCode).toBe(409);
    expect(jobs).toEqual([]);
  });

  it('says the runner is off rather than failing obscurely', async () => {
    const { runner } = runnerOf({ enabled: false });
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events, fetchImpl: fetchOf() });

    const res = await app.inject({ method: 'POST', url: '/trials', payload: BODY });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('runner.enabled');
  });

  it('is a real feature that is unconfigured, not a missing route', async () => {
    app = await serve({});
    const res = await app.inject({ method: 'POST', url: '/trials', payload: BODY });
    expect(res.statusCode).toBe(503);
  });
});

describe('GET and DELETE /trials/:slug', () => {
  it('404s an unknown trial and 400s a slug it did not produce', async () => {
    const { runner } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events, fetchImpl: fetchOf() });

    expect((await app.inject({ method: 'GET', url: '/trials/Acme-AppStore@nope' })).statusCode).toBe(404);
    for (const bad of ['..', 'a%2Fb', 'yundera~FileBrowser']) {
      const res = await app.inject({ method: 'GET', url: `/trials/${bad}` });
      expect([400, 404], bad).toContain(res.statusCode);
    }
  });

  it('lists trials newest first and can drop one from the list', async () => {
    const { runner } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events, fetchImpl: fetchOf() });

    const at = (t: string) => ({ repo: 'A/B', source_url: 'https://github.com/A/B/archive/main.zip', apps_path: 'Apps', subject: 'X', started_at: t });
    await trials.add({ slug: 'A@one', ...at('2026-08-20T09:00:00.000Z') });
    await trials.add({ slug: 'A@two', ...at('2026-08-20T10:00:00.000Z') });

    const listed = (await app.inject({ method: 'GET', url: '/trials' })).json() as { trials: { slug: string }[] };
    expect(listed.trials.map((t) => t.slug)).toEqual(['A@two', 'A@one']);

    expect((await app.inject({ method: 'DELETE', url: '/trials/A@one' })).statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/trials' })).json() as { trials: { slug: string }[] };
    expect(after.trials.map((t) => t.slug)).toEqual(['A@two']);
  });

  /**
   * A comparison cell carries **which** condition blocked it, not merely that one did.
   *
   * This shape used to be four fields wide — status, verdict, severity, risk — and the page
   * that reads it therefore had one sentence to offer for four different reasons. It printed
   * the `store_url_unconfigured` advice ("set `trials.public_base_url`") for an empty bench
   * pool and a dead browser sidecar alike, which is a correct-sounding answer to a question
   * nobody asked. Since 2026-08-22 a trial is a full audit, so all four reasons are reachable
   * and the distinction is load-bearing rather than theoretical.
   */
  it('says which condition blocked a section, not merely that one did', async () => {
    const { runner } = runnerOf();
    const trialsRoot = path.join(dir, 'trials');
    app = await serve({ runner, trials, trialsRoot, events, fetchImpl: fetchOf() });

    await trials.add({
      slug: 'A@blocked',
      repo: 'A/B',
      source_url: 'https://github.com/A/B/archive/main.zip',
      apps_path: 'Apps',
      subject: 'Widget',
      started_at: '2026-08-22T09:00:00.000Z',
    });

    // The slug is the synthetic origin, so a trial's tree is `<root>/<slug>/<slug>/<Subject>/`.
    const reports = path.join(trialsRoot, 'A@blocked', 'A@blocked', 'Widget');
    await fs.mkdir(reports, { recursive: true });
    await fs.writeFile(
      path.join(reports, '2026-08-22T09-00-00Z-functional.md'),
      [
        '---',
        'subject: Widget',
        // The origin is read from the frontmatter, and for a trial it is the slug — that is
        // the whole of "the slug doubles as a synthetic origin".
        "origin: 'A@blocked'",
        'section: functional',
        'standard: Functional Review Protocol',
        'standard_version: 6',
        'status: blocked',
        'verdict: null',
        'top_severity: none',
        'risk_score: 0',
        'blocked_reason: bench_unavailable',
        "started_at: '2026-08-22T09:00:00Z'",
        "finished_at: '2026-08-22T09:05:00Z'",
        'findings: []',
        '---',
        '',
        'No demo instance was free.',
        '',
      ].join('\n'),
      'utf8',
    );

    const res = await app.inject({ method: 'GET', url: '/trials/A@blocked' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      comparison: {
        section: string;
        trial: { status: string; blocked_reason?: string | null; standard_version?: number } | null;
      }[];
    };

    const functional = body.comparison.find((c) => c.section === 'functional');
    expect(functional?.trial?.status).toBe('blocked');
    // The point of the test: `bench_unavailable`, and not the one reason the page used to
    // assume — a cell that cannot tell them apart gives the operator the wrong instruction.
    expect(functional?.trial?.blocked_reason).toBe('bench_unavailable');
    expect(functional?.trial?.blocked_reason).not.toBe('store_url_unconfigured');
    // Invariant 9 travels with it, so a cell can cite the standard that judged it.
    expect(functional?.trial?.standard_version).toBe(6);
  });
});

/**
 * The store a trial serves — the one address here a demo bench on the public internet fetches.
 *
 * It is the trial's **own copy**, not the caller's URL and not the upload session's live
 * contents. That is what makes the bytes installed the bytes audited, and it is what makes
 * Maison's in-process store cache harmless: the token is minted per trial, so the URL has never
 * been fetched by anything. The headers matter for a different reason — this origin also serves
 * the SSO-gated operator UI, and bytes somebody supplied must never be sniffed into HTML there.
 */
describe('GET /trialstore/:token.zip', () => {
  it('serves the archive the trial audited, so it can never be rendered or cached', async () => {
    const { runner } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events, fetchImpl: fetchOf() });

    const started = await app.inject({ method: 'POST', url: '/trials', payload: BODY });
    const { trial } = started.json() as { trial: { slug: string; store_token: string } };
    await waitFor(() => trials.get(trial.slug)?.outcome !== undefined);

    const res = await app.inject({ method: 'GET', url: `/trialstore/${trial.store_token}.zip` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/zip');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('no-store');

    // NOT the archive that was fetched — a real store is fifty apps and 96 MB, and the trial
    // says nothing about the other forty-nine. What is served is the one app, repacked, and it
    // must read back as exactly what the audit was told it was judging. Anything else and the
    // compose assertion in `functional.md` would be checking two different things.
    const served = readAppFromZip(Buffer.from(res.rawPayload), 'Apps', 'Widget');
    expect(served).toEqual(readAppFromZip(storeZip(), 'Apps', 'Widget'));
    expect(res.rawPayload.length).toBeLessThanOrEqual(storeZip().byteLength);
  });

  it('404s an unknown token, a wrong shape, and a trial whose store has been swept', async () => {
    const { runner } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events, fetchImpl: fetchOf() });

    const started = await app.inject({ method: 'POST', url: '/trials', payload: BODY });
    const { trial } = started.json() as { trial: { slug: string; store_token: string } };
    await waitFor(() => trials.get(trial.slug)?.outcome !== undefined);

    expect((await app.inject({ method: 'GET', url: '/trialstore/nope.zip' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: `/trialstore/${trial.store_token}` })).statusCode,
    ).toBe(404);

    // Deleting the trial takes its store with it — the row and the bytes have one lifetime.
    await trials.remove(trial.slug);
    expect(
      (await app.inject({ method: 'GET', url: `/trialstore/${trial.store_token}.zip` })).statusCode,
    ).toBe(404);
  });
});

describe('the trial index', () => {
  it('must not share a cache file with the archive index', () => {
    // `defaultCacheFile` is `dirname(root)/state/index.json`, which is the SAME path for
    // `data/reports` and `data/trials`. Two indexes writing it would clobber each other and
    // cross-serve records — a trial's report surfacing as a subject's. `routes/trials.ts`
    // therefore passes `cacheFile: null`; this test is here so the collision is on the record.
    const data = path.join(dir, 'data');
    expect(defaultCacheFile(path.join(data, 'trials'))).toBe(
      defaultCacheFile(path.join(data, 'reports')),
    );
  });
});
