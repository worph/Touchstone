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

const BODY = { repo: 'Acme/AppStore', ref: 'pr-812', subject: 'Widget' };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-trials-'));
  events = new EventLog(dir);
  await events.load();
  trials = new TrialStore(dir, path.join(dir, 'trials'));
  await trials.load();
});

afterEach(async () => {
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('POST /trials', () => {
  it('starts a trial and answers before it finishes', async () => {
    const { runner, jobs } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events });

    const res = await app.inject({ method: 'POST', url: '/trials', payload: BODY });

    // 202, not 200: an audit takes minutes, and a socket held that long is at the mercy of
    // every proxy between here and the browser.
    expect(res.statusCode).toBe(202);
    const body = res.json() as { trial: { slug: string; ref: string } };
    expect(body.trial.ref).toBe('pr-812');

    await new Promise((r) => setTimeout(r, 10));
    expect(jobs).toHaveLength(1);
    const job = jobs[0] as { subject: string; trial: { repo: string; root: string } };
    // The slug is the synthetic origin, so the path machinery needs no special case.
    expect(job.subject).toBe(`${body.trial.slug}~Widget`);
    expect(job.trial.repo).toBe('Acme/AppStore');
    expect(job.trial.root).toContain(body.trial.slug);
  });

  it('refuses input that would choose the repository for us', async () => {
    const { runner, jobs } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events });

    for (const bad of [
      { ...BODY, repo: 'not-a-repo' },
      { ...BODY, ref: '../../etc/passwd' },
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
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events });

    const res = await app.inject({ method: 'POST', url: '/trials', payload: BODY });
    expect(res.statusCode).toBe(409);
    expect(jobs).toEqual([]);
  });

  it('says the runner is off rather than failing obscurely', async () => {
    const { runner } = runnerOf({ enabled: false });
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events });

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
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events });

    expect((await app.inject({ method: 'GET', url: '/trials/Acme-AppStore@nope' })).statusCode).toBe(404);
    for (const bad of ['..', 'a%2Fb', 'yundera~FileBrowser']) {
      const res = await app.inject({ method: 'GET', url: `/trials/${bad}` });
      expect([400, 404], bad).toContain(res.statusCode);
    }
  });

  it('lists trials newest first and can drop one from the list', async () => {
    const { runner } = runnerOf();
    app = await serve({ runner, trials, trialsRoot: path.join(dir, 'trials'), events });

    await trials.add({ slug: 'A@one', repo: 'A/B', ref: 'one', apps_path: 'Apps', subject: 'X', started_at: '2026-08-20T09:00:00.000Z' });
    await trials.add({ slug: 'A@two', repo: 'A/B', ref: 'two', apps_path: 'Apps', subject: 'X', started_at: '2026-08-20T10:00:00.000Z' });

    const listed = (await app.inject({ method: 'GET', url: '/trials' })).json() as { trials: { slug: string }[] };
    expect(listed.trials.map((t) => t.slug)).toEqual(['A@two', 'A@one']);

    expect((await app.inject({ method: 'DELETE', url: '/trials/A@one' })).statusCode).toBe(200);
    const after = (await app.inject({ method: 'GET', url: '/trials' })).json() as { trials: { slug: string }[] };
    expect(after.trials.map((t) => t.slug)).toEqual(['A@two']);
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
