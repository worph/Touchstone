/**
 * `DELETE /subjects/:name` — the one verb that takes something out of the archive.
 *
 * Everything here is about the guard rather than about the delete. Removing files is the easy
 * half; what earns the tests is *which* subject may be removed, because the archive is
 * permanent by design and this is the single hole in that. The rule is one sentence — only a
 * **delisted** subject, i.e. one the store was successfully read and found not to list — and
 * every failure mode below is that sentence read too loosely:
 *
 *   - a live app deleted because somebody typed its name,
 *   - the whole archive deletable during a GitHub outage, when nothing is "in the store",
 *   - a subject deleted out from under the audit that is writing its next report.
 *
 * The last one is why the runner is consulted: the route is the only thing that can see both
 * the files and the run in flight.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN, subjectKey } from '../../shared/subject.js';
import { EventLog } from '../services/events.js';
import { buildIndex, type ReportIndex } from '../store/index.js';
import routes from './index.js';

let dir: string;
let reports: string;
let events: EventLog;

const REPORT = (subject: string, section: string) =>
  [
    '---',
    `subject: ${subject}`,
    `origin: ${DEFAULT_ORIGIN}`,
    `section: ${section}`,
    'standard: Static Review Protocol',
    'status: done',
    'verdict: compliant',
    'top_severity: none',
    'risk_score: 0',
    'started_at: 2026-08-05T09:14:22Z',
    'finished_at: 2026-08-05T09:29:41Z',
    '---',
    '',
    `# ${subject}`,
    '',
  ].join('\n');

async function write(rel: string, body: string): Promise<void> {
  const abs = path.join(reports, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
}

/**
 * An app store that offers `Live` and has never heard of `Gone`.
 *
 * A stub rather than a `SubjectRegistry`, because what the route needs from it is one boolean
 * and the real thing would have to be driven through a fetch to produce it. The one property
 * that matters is copied faithfully: `isDelisted` is the *only* question the route asks.
 */
function registry(delisted: string[]) {
  return {
    list: () => [subjectKey(DEFAULT_ORIGIN, 'Live')],
    versions: () => ({}),
    delisted: () => delisted,
    isDelisted: (key: string) => delisted.includes(key),
  } as never;
}

async function serve(index: ReportIndex, opts: Record<string, unknown> = {}) {
  const app = Fastify();
  await app.register(routes, { prefix: '/api/v1', store: index, events, ...opts });
  await app.ready();
  return app;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-delete-'));
  reports = path.join(dir, 'reports');
  events = new EventLog(dir);
  await events.load();
  await write(`${DEFAULT_ORIGIN}/Live/2026-08-05T09-14-22Z-static.md`, REPORT('Live', 'static'));
  await write(`${DEFAULT_ORIGIN}/Gone/2026-08-05T09-14-22Z-static.md`, REPORT('Gone', 'static'));
  await write(`${DEFAULT_ORIGIN}/Gone/2026-08-05T09-14-22Z-functional.md`, REPORT('Gone', 'functional'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('DELETE /subjects/:name', () => {
  it('removes a delisted subject’s reports, from disk and from the index together', async () => {
    const index = await buildIndex(reports, { cacheFile: null });
    const app = await serve(index, { registry: registry([subjectKey(DEFAULT_ORIGIN, 'Gone')]) });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/subjects/${encodeURIComponent(subjectKey(DEFAULT_ORIGIN, 'Gone'))}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ removed: 2 });

    // Gone from the index, so the table stops drawing it without a restart…
    expect(index.subjects()).toEqual([subjectKey(DEFAULT_ORIGIN, 'Live')]);
    // …and gone from disk, so it stays gone across one.
    await expect(fs.readdir(path.join(reports, DEFAULT_ORIGIN))).resolves.toEqual(['Live']);

    await app.close();
  });

  /**
   * The guard, stated the way it will actually be met: somebody deletes the wrong row, or an
   * agent gets hold of the route. An app the store still offers is not deletable at all.
   */
  it('refuses a subject the store still offers', async () => {
    const index = await buildIndex(reports, { cacheFile: null });
    const app = await serve(index, { registry: registry([]) });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/subjects/${encodeURIComponent(subjectKey(DEFAULT_ORIGIN, 'Live'))}`,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toContain('still in the store');
    expect(index.subjects()).toContain(subjectKey(DEFAULT_ORIGIN, 'Live'));

    await app.close();
  });

  /**
   * A store that cannot be read delists nobody, so during an outage this route refuses
   * everything. That is the registry's rule, inherited rather than restated — but it is worth
   * a test here, because the failure it prevents is the whole archive becoming deletable for
   * exactly as long as GitHub is down.
   */
  it('refuses everything while the store is unreadable, because nothing is delisted then', async () => {
    const index = await buildIndex(reports, { cacheFile: null });
    const app = await serve(index, { registry: registry([]) });

    for (const name of ['Live', 'Gone']) {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/subjects/${encodeURIComponent(subjectKey(DEFAULT_ORIGIN, name))}`,
      });
      expect(res.statusCode).toBe(409);
    }
    expect(index.size).toBe(3);

    await app.close();
  });

  it('refuses while that subject is being audited, rather than racing the writer', async () => {
    const index = await buildIndex(reports, { cacheFile: null });
    const app = await serve(index, {
      registry: registry([subjectKey(DEFAULT_ORIGIN, 'Gone')]),
      runner: {
        status: () => ({ running: { subject: subjectKey(DEFAULT_ORIGIN, 'Gone') } }),
      } as never,
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/subjects/${encodeURIComponent(subjectKey(DEFAULT_ORIGIN, 'Gone'))}`,
    });
    expect(res.statusCode).toBe(409);
    expect(index.size).toBe(3);

    await app.close();
  });

  it('404s a name nobody has ever had, rather than reporting a successful no-op', async () => {
    const index = await buildIndex(reports, { cacheFile: null });
    const app = await serve(index, { registry: registry([]) });

    const res = await app.inject({ method: 'DELETE', url: '/api/v1/subjects/NotAnApp' });
    expect(res.statusCode).toBe(404);

    await app.close();
  });

  /**
   * The archive is the only record that a subject was ever audited, so the deletion has to
   * leave one of its own. `warn`, not `info`: this is the one action in the app that cannot
   * be undone, and Activity's default filter has to show it.
   */
  it('leaves a warning in the log naming what went', async () => {
    const index = await buildIndex(reports, { cacheFile: null });
    const app = await serve(index, { registry: registry([subjectKey(DEFAULT_ORIGIN, 'Gone')]) });

    await app.inject({
      method: 'DELETE',
      url: `/api/v1/subjects/${encodeURIComponent(subjectKey(DEFAULT_ORIGIN, 'Gone'))}`,
    });
    await events.flush();

    const row = events.query({ limit: 20 }).find((e) => e.code === 'SUBJECT_PURGED');
    expect(row?.level).toBe('warn');
    expect(row?.message).toContain('Gone');
    expect(row?.detail).toMatchObject({ files: 2 });

    await app.close();
  });

  /**
   * Nothing a model can call may delete an audit. The chat's registry is also the admin MCP's
   * tool list (`routes/mcp-admin.ts` renders the same array), so this one assertion covers
   * both surfaces — and it is the reason the delete is an HTTP verb and not a tool.
   */
  it('is not reachable as a chat tool', async () => {
    const { CHAT_TOOLS } = await import('../chat/registry.js');
    expect(CHAT_TOOLS.some((t) => /delete|purge|remove/i.test(t.name))).toBe(false);
  });
});
