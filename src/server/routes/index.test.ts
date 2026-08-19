import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReportResponse, SubjectState } from '../../shared/types.js';
import { FIXTURE_RECORDS, fixtureStore } from '../domain/fixtures.js';
import routes from './index.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  await app.register(routes, { prefix: '/api/v1', store: fixtureStore() });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

const get = async <T>(url: string) => {
  const res = await app.inject({ method: 'GET', url });
  return { status: res.statusCode, body: res.json() as T };
};

describe('registration', () => {
  it('serves the fixture archive when no store is injected, as src/server/index.ts does', async () => {
    const bare = Fastify();
    await bare.register(routes, { prefix: '/api/v1' });
    await bare.ready();
    const res = await bare.inject({ method: 'GET', url: '/api/v1/subjects' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as SubjectState[]).length).toBeGreaterThan(0);
    await bare.close();
  });
});

describe('GET /subjects', () => {
  it('returns one row per subject, risk descending', async () => {
    const { status, body } = await get<SubjectState[]>('/api/v1/subjects');
    expect(status).toBe(200);
    expect(body).toHaveLength(new Set(FIXTURE_RECORDS.map((r) => r.subject)).size);
    expect(body[0]?.name).toBe('OpenClaw');
    expect(body.map((r) => r.risk)).toEqual([...body.map((r) => r.risk)].sort((a, b) => b - a));
  });

  it('reports blocked legs as blocked, with no verdict standing in', async () => {
    const { body } = await get<SubjectState[]>('/api/v1/subjects');
    const openclaw = body.find((r) => r.name === 'OpenClaw');
    expect(openclaw?.static?.meta.verdict).toBe('non-compliant');
    expect(openclaw?.functional?.meta.status).toBe('blocked');
    expect(openclaw?.functional?.meta.verdict).toBeNull();
  });
});

describe('GET /subjects/:name', () => {
  it('returns the row and the full history, newest first', async () => {
    const { status, body } = await get<{ subject: SubjectState; history: { path: string }[] }>(
      '/api/v1/subjects/OpenClaw',
    );
    expect(status).toBe(200);
    expect(body.subject.name).toBe('OpenClaw');
    expect(body.history).toHaveLength(4); // both legs interleaved
    expect(body.history[0]?.path).toContain('2026-08-05T09-31-00Z-functional');
  });

  it('404s an unknown subject with an error object', async () => {
    const { status, body } = await get<{ error: string }>('/api/v1/subjects/Nope');
    expect(status).toBe(404);
    expect(body.error).toMatch(/unknown subject/);
  });
});

describe('GET /reports/:subject/:file', () => {
  const file = '2026-08-05T09-14-22Z-static.md';

  it('returns meta, rendered html and the raw markdown', async () => {
    const { status, body } = await get<ReportResponse>(`/api/v1/reports/OpenClaw/${file}`);
    expect(status).toBe(200);
    expect(body.meta.subject).toBe('OpenClaw');
    expect(body.meta.risk_score).toBe(232);
    expect(body.html).toContain('<h1');
    expect(body.html).toContain('id="yundera-appstore-openclaw"');
    expect(body.raw).toContain('# Yundera/AppStore — OpenClaw');
  });

  it('404s an unknown report', async () => {
    expect((await get('/api/v1/reports/OpenClaw/nope.md')).status).toBe(404);
    expect((await get('/api/v1/reports/Nope/anything.md')).status).toBe(404);
  });

  it('refuses to climb out of the reports root', async () => {
    for (const url of [
      '/api/v1/reports/%2e%2e/passwd.md',
      '/api/v1/reports/OpenClaw/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/api/v1/reports/OpenClaw/..%5cetc',
    ]) {
      const { status } = await get(url);
      expect([400, 404]).toContain(status); // rejected by the guard or unmatched by the router
    }
  });
});

/**
 * The activity endpoints exist whether or not the services behind them are running.
 *
 * This is the shape UX.md §2.3 requires: the page has to render on an instance with no
 * prober, no outlets and no push, and say so — an app that can only tell you what is wrong
 * by having everything working is an app that goes quiet exactly when you need it.
 */
describe('the activity endpoints with no services injected', () => {
  it('serves an empty log rather than a 404', async () => {
    const { status, body } = await get<{ events: unknown[]; last_seq: number }>('/api/v1/events');
    expect(status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.last_seq).toBe(0);
  });

  it('names the event codes so the filter menu can be built without a second copy', async () => {
    const { body } = await get<{ codes: Record<string, string> }>('/api/v1/events');
    expect(body.codes.BENCH_AUTH_FAILED).toBeTruthy();
  });

  it('serves no alerts, which is different from failing to answer', async () => {
    const { status, body } = await get<{ open: unknown[]; resolved: unknown[] }>('/api/v1/alerts');
    expect(status).toBe(200);
    expect(body).toEqual({ open: [], resolved: [] });
  });

  it('reports an empty bench pool as down, not as fine', async () => {
    const { status, body } = await get<{ benches: unknown[]; pool_up: boolean }>('/api/v1/benches');
    expect(status).toBe(200);
    expect(body.benches).toEqual([]);
    expect(body.pool_up).toBe(false);
  });

  it('reports push as unconfigured in a field rather than by failing', async () => {
    const { status, body } = await get<{ configured: boolean; public_key: string | null }>('/api/v1/push');
    expect(status).toBe(200);
    expect(body).toEqual({ configured: false, public_key: null, devices: 0 });
  });

  it('refuses a subscription when there is nothing to subscribe to', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/push/subscribe',
      payload: { endpoint: 'https://push.example/x', keys: { p256dh: 'a', auth: 'b' } },
    });
    expect(res.statusCode).toBe(503);
  });
});
