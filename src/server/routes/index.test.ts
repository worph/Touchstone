import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ReportResponse, RuleGroup, SubjectState } from '../../shared/types.js';
import { FIXTURE_RECORDS, fixtureStore } from '../domain/fixtures.js';
import type { LocatedFinding } from '../domain/findings.js';
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
    expect(body.meta.risk_score).toBe(112);
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

describe('GET /findings', () => {
  it('groups by rule over the current assays — five subjects share one cpu_shares fix', async () => {
    const { status, body } = await get<RuleGroup[]>('/api/v1/findings?group=rule');
    expect(status).toBe(200);
    const cpu = body.find((g) => g.title === 'cpu_shares on reserved tier 10');
    expect(cpu?.subjects).toEqual(['OpenClaw', 'Prowlarr', 'qBittorrent', 'Radarr', 'Sonarr']);
    expect(cpu?.severity).toBe('minor');
    expect(cpu?.status).toBe('fail');
    expect(cpu?.risk).toBe(5);
  });

  it('keeps a rule that passes on one subject and fails on another as separate rows', async () => {
    const { body } = await get<RuleGroup[]>('/api/v1/findings?group=rule');
    const d1 = body.filter((g) => g.rule === 'D1');
    expect(d1).toHaveLength(1);
    expect(d1[0]?.status).toBe('pass');
    expect(d1[0]?.risk).toBe(0);
  });

  it('defaults to grouping by rule and rejects an unknown grouping', async () => {
    expect((await get<RuleGroup[]>('/api/v1/findings')).body.length).toBeGreaterThan(0);
    expect((await get('/api/v1/findings?group=subject')).status).toBe(400);
  });

  it('serves the suspected-Critical queue', async () => {
    const { status, body } = await get<LocatedFinding[]>('/api/v1/findings?status=unverified');
    expect(status).toBe(200);
    expect(body.map((f) => f.subject)).toEqual(['OpenClaw', 'Prowlarr', 'Sonarr']);
    expect(body.every((f) => f.rule === 'E9' && f.severity === 'critical')).toBe(true);
    // the queue is actionable only because each row says where it was seen
    expect(body[0]?.file).toBeTruthy();
  });

  it('400s an unknown status', async () => {
    const { status, body } = await get<{ error: string }>('/api/v1/findings?status=whatever');
    expect(status).toBe(400);
    expect(body.error).toMatch(/unknown status/);
  });
});
