/**
 * `/public` — the surface an app author sees.
 *
 * Two things are worth a test here and the rest is `index.test.ts`'s job. First that the board
 * and the operator table are the *same* answer, because a public verdict that has drifted from
 * the internal one is the failure mode this namespace invites. Second that read-only is
 * enforced rather than asserted — the guard is the only reason "no action" survives the next
 * person who needs a button.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN, subjectKey } from '../../shared/subject.js';
import type { SubjectState } from '../../shared/types.js';
import { fixtureStore } from '../domain/fixtures.js';
import routes from './index.js';
import { assertReadOnly } from './public.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(routes, { prefix: '/api/v1', store: fixtureStore() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

/** `body` is a getter: `fix.md` answers in markdown and eager parsing would throw on it. */
const get = async <T>(url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return {
    status: res.statusCode,
    get body() {
      return res.json() as T;
    },
    raw: res.body,
    headers: res.headers,
  };
};

describe('read-only by construction', () => {
  it('refuses to register a write verb under the prefix', () => {
    expect(() => assertReadOnly({ method: 'POST', url: '/public/subjects' })).toThrow(
      /read-only/,
    );
    expect(() => assertReadOnly({ method: ['GET', 'DELETE'], url: '/public/x' })).toThrow(
      /DELETE/,
    );
  });

  it('allows the verbs a board actually needs', () => {
    expect(() => assertReadOnly({ method: 'GET', url: '/public/subjects' })).not.toThrow();
    expect(() => assertReadOnly({ method: ['GET', 'HEAD'], url: '/public/subjects' })).not.toThrow();
  });

  it('has no write route to reach', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      const res = await app.inject({ method, url: '/api/v1/public/subjects' });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('GET /public/subjects', () => {
  it('is the operator table, unchanged — same verdicts, same composition', async () => {
    const pub = await get<SubjectState[]>('/api/v1/public/subjects');
    const ops = await get<SubjectState[]>('/api/v1/subjects');
    expect(pub.status).toBe(200);
    expect(pub.body).toEqual(ops.body);
  });

  /**
   * The one way the two lists are allowed to differ, and the reason it is a test rather than
   * a comment.
   *
   * The operator's table is the store's inventory: it unions the registry in, so an app that
   * has never been audited still gets a row and a button. The board is the archive alone —
   * publishing "we have not looked at this one" to app authors is a backlog with somebody
   * else's name on it, and it would also invite the reading that a never-run app has been
   * judged and found wanting.
   *
   * The parity test above uses a harness with no registry, so it would go on passing if this
   * distinction were lost. This one is what actually holds it.
   */
  it('does not show what the registry merely tracks — the operator table does', async () => {
    const withRegistry = Fastify();
    await withRegistry.register(routes, {
      prefix: '/api/v1',
      store: fixtureStore(),
      registry: { list: () => [subjectKey(DEFAULT_ORIGIN, 'NeverAudited')] } as never,
    });
    await withRegistry.ready();

    const ops = (await withRegistry.inject({ method: 'GET', url: '/api/v1/subjects' }))
      .json() as SubjectState[];
    const pub = (await withRegistry.inject({ method: 'GET', url: '/api/v1/public/subjects' }))
      .json() as SubjectState[];

    const row = ops.find((r) => r.label === 'NeverAudited');
    expect(row).toBeDefined();
    // A row, and honestly empty: no verdict either way, and nothing to age.
    expect(row?.static).toBeNull();
    expect(row?.functional).toBeNull();
    expect(row?.age_days).toBeNull();
    expect(row?.risk).toBe(0);

    expect(pub.some((r) => r.label === 'NeverAudited')).toBe(false);
    expect(pub.length).toBe(ops.length - 1);

    await withRegistry.close();
  });

  it('keeps blocked distinguishable from failing, which is the whole point of showing it', async () => {
    const { body } = await get<SubjectState[]>('/api/v1/public/subjects');
    const openclaw = body.find((r) => r.label === 'OpenClaw');
    expect(openclaw?.functional?.meta.status).toBe('blocked');
    expect(openclaw?.functional?.meta.verdict).toBeNull();
  });
});

describe('GET /public/subjects/:name', () => {
  it('returns the row alone — no history, and no run state', async () => {
    const { status, body } = await get<SubjectState & { history?: unknown }>(
      '/api/v1/public/subjects/OpenClaw',
    );
    expect(status).toBe(200);
    expect(body.label).toBe('OpenClaw');
    expect(body.name).toBe(subjectKey(DEFAULT_ORIGIN, 'OpenClaw'));
    expect(body.history).toBeUndefined();
  });

  it('resolves a bare name, as every other subject route does', async () => {
    const { status, body } = await get<SubjectState>('/api/v1/public/subjects/openclaw');
    expect(status).toBe(200);
    expect(body.label).toBe('OpenClaw');
  });

  it('404s an unknown subject', async () => {
    const { status, body } = await get<{ error: string }>('/api/v1/public/subjects/Nope');
    expect(status).toBe(404);
    expect(body.error).toContain('Nope');
  });

  /**
   * A subject the registry knows but the archive has never seen resolves on the operator
   * route and not here. That asymmetry is deliberate: the board reports what was assayed,
   * and an app with no assay has no hallmark to publish.
   */
  it('does not invent a row for a subject that has never been assayed', async () => {
    const { status } = await get<{ error: string }>('/api/v1/public/subjects/NeverAudited');
    expect(status).toBe(404);
  });
});

describe('GET /public/subjects/:name/fix.md', () => {
  it('serves the same brief the operator endpoint does, as markdown', async () => {
    const pub = await get<unknown>('/api/v1/public/subjects/OpenClaw/fix.md');
    const ops = await get<unknown>('/api/v1/subjects/OpenClaw/fix.md');
    expect(pub.status).toBe(200);
    expect(pub.headers['content-type']).toContain('text/markdown');
    expect(pub.raw).toBe(ops.raw);
  });

  it('404s rather than serving an empty document that would read as a pass', async () => {
    const { status } = await get<{ error: string }>('/api/v1/public/subjects/Nope/fix.md');
    expect(status).toBe(404);
  });
});
