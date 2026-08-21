/**
 * The browser viewer surface.
 *
 * The behaviour worth pinning is what it does when the sidecar is *not* there: invariant 7
 * says the app stays diagnosable with every outbound port broken, so an unreachable browser is
 * a row that says so, never a 500 and never a blank panel with no explanation.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import routes, { browserBase, contextForSubject } from './browser.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(opts: Record<string, unknown>): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(routes, opts as never);
  await instance.ready();
  return instance;
}

describe('browserBase', () => {
  it('trims the MCP suffix to reach the viewer surfaces beside it', () => {
    expect(browserBase('http://touchstone-browser-1:9746/mcp')).toBe('http://touchstone-browser-1:9746');
    expect(browserBase('http://touchstone-browser-1:9746/mcp/')).toBe('http://touchstone-browser-1:9746');
    expect(browserBase('http://touchstone-browser-1:9746')).toBe('http://touchstone-browser-1:9746');
  });
});

describe('contextForSubject', () => {
  it('matches the isolated context the prompt asks the agent to open', () => {
    // Kept in step with `runner/prompt.ts` by hand. If the prompt's wording changes this stops
    // matching and the panel widens to every tab — noise, never the wrong tab.
    expect(contextForSubject('FileBrowser')).toBe('functional-FileBrowser-audit');
  });
});

describe('GET /browser/pages', () => {
  it('says so when no sidecar is configured, rather than pretending', async () => {
    app = await serve({});
    const res = await app.inject({ method: 'GET', url: '/browser/pages' });
    expect(res.statusCode).toBe(503);
  });

  it('reports an unreachable browser as a state, not an error', async () => {
    // Invariant 7. A 500 here would make "the sidecar is down" indistinguishable from "the app
    // is broken", on the one page an operator opens to find out which.
    app = await serve({ browserUrl: 'http://127.0.0.1:1/mcp' });
    const res = await app.inject({ method: 'GET', url: '/browser/pages' });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { pages: unknown[]; unreachable?: string };
    expect(body.pages).toEqual([]);
    expect(body.unreachable).toBeTruthy();
  });

  it('narrows the tab list to the running audit, and can be widened', async () => {
    const pages = [
      { pageId: 'a', owner: 'functional-FileBrowser-audit', url: 'https://demo/store', title: 'Maison' },
      { pageId: 'b', owner: null, url: 'about:blank', title: 'about:blank' },
      { pageId: 'c', owner: 'functional-Ntfy-audit', url: 'https://demo/x', title: 'Other' },
    ];
    const upstream = Fastify();
    upstream.get('/api/pages', async () => ({ pages }));
    await upstream.listen({ port: 0, host: '127.0.0.1' });
    const port = (upstream.server.address() as { port: number }).port;

    try {
      app = await serve({
        browserUrl: `http://127.0.0.1:${port}/mcp`,
        runningSubject: () => 'FileBrowser',
      });

      const mine = (await app.inject({ method: 'GET', url: '/browser/pages' })).json() as {
        pages: { pageId: string }[];
        filtered: boolean;
        context: string;
      };
      expect(mine.pages.map((p) => p.pageId)).toEqual(['a']);
      expect(mine.filtered).toBe(true);
      expect(mine.context).toBe('functional-FileBrowser-audit');

      const all = (await app.inject({ method: 'GET', url: '/browser/pages?all=1' })).json() as {
        pages: { pageId: string }[];
        filtered: boolean;
      };
      expect(all.pages).toHaveLength(3);
      expect(all.filtered).toBe(false);
    } finally {
      await upstream.close();
    }
  });

  it('falls back to every tab when nothing is running', async () => {
    // Better than an empty panel: between runs the operator still wants to see what the
    // browser is holding — a leaked tab from a previous audit is a real thing to notice.
    const upstream = Fastify();
    upstream.get('/api/pages', async () => ({ pages: [{ pageId: 'a', owner: null, url: 'about:blank', title: '' }] }));
    await upstream.listen({ port: 0, host: '127.0.0.1' });
    const port = (upstream.server.address() as { port: number }).port;

    try {
      app = await serve({ browserUrl: `http://127.0.0.1:${port}/mcp`, runningSubject: () => null });
      const body = (await app.inject({ method: 'GET', url: '/browser/pages' })).json() as {
        pages: unknown[];
        filtered: boolean;
        context: string | null;
      };
      expect(body.pages).toHaveLength(1);
      expect(body.filtered).toBe(false);
      expect(body.context).toBeNull();
    } finally {
      await upstream.close();
    }
  });
});

describe('GET /browser/screenshot', () => {
  it('never caches — a still is stale the moment it is taken', async () => {
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const upstream = Fastify();
    upstream.get('/api/screenshot', async (_r, reply) => reply.type('image/png').send(png));
    await upstream.listen({ port: 0, host: '127.0.0.1' });
    const port = (upstream.server.address() as { port: number }).port;

    try {
      app = await serve({ browserUrl: `http://127.0.0.1:${port}/mcp` });
      const res = await app.inject({ method: 'GET', url: '/browser/screenshot' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(res.headers['cache-control']).toBe('no-store');
    } finally {
      await upstream.close();
    }
  });

  it('502s a broken sidecar rather than serving a blank image', async () => {
    app = await serve({ browserUrl: 'http://127.0.0.1:1/mcp' });
    expect((await app.inject({ method: 'GET', url: '/browser/screenshot' })).statusCode).toBe(502);
  });
});
