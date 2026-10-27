import { describe, expect, it } from 'vitest';

import { closeRunTabs } from './browsertabs.js';

const SINCE = '2026-10-27T10:00:00.000Z';
const T = Date.parse(SINCE);

function sidecar(pages: { pageId: string; createdAt: number; keepUntil: number | null }[], opts: { listStatus?: number; deleteStatus?: (id: string) => number } = {}) {
  const deleted: string[] = [];
  const calls: string[] = [];
  const fake = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${u}`);
    if (u.endsWith('/api/pages') && (init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ pages }), { status: opts.listStatus ?? 200 });
    }
    const id = decodeURIComponent(u.split('/api/pages/')[1] ?? '');
    deleted.push(id);
    return new Response('{}', { status: opts.deleteStatus?.(id) ?? 200 });
  }) as typeof fetch;
  return { fake, deleted, calls };
}

describe('closeRunTabs', () => {
  it('closes only tabs first seen during the lease, and spares held ones', async () => {
    const s = sidecar([
      { pageId: 'before', createdAt: T - 1, keepUntil: null },
      { pageId: 'run-1', createdAt: T, keepUntil: null },
      { pageId: 'run-2', createdAt: T + 60_000, keepUntil: null },
      { pageId: 'held', createdAt: T + 5, keepUntil: T + 10 * 60_000 },
      { pageId: 'hold-expired', createdAt: T + 5, keepUntil: T + 1 },
    ]);
    const logged: unknown[] = [];
    const out = await closeRunTabs({
      url: 'http://touchstone-browser-1:9746/mcp',
      since: SINCE,
      holder: 'yundera~Wger',
      fetch: s.fake,
      now: () => T + 2 * 60_000,
      events: { log: (e) => (logged.push(e), e as never) },
    });
    expect(s.deleted.sort()).toEqual(['hold-expired', 'run-1', 'run-2']);
    expect(s.calls[0]).toBe('GET http://touchstone-browser-1:9746/api/pages');
    expect(out).toEqual({ closed: 3, kept: 1, failed: 0 });
    expect(logged).toHaveLength(1);
  });

  it('counts a 410 as closed and a 500 as failed, and never throws', async () => {
    const s = sidecar(
      [
        { pageId: 'gone', createdAt: T, keepUntil: null },
        { pageId: 'stuck', createdAt: T, keepUntil: null },
      ],
      { deleteStatus: (id) => (id === 'gone' ? 410 : 500) },
    );
    const out = await closeRunTabs({ url: 'http://b:9746/mcp', since: SINCE, holder: 'x', fetch: s.fake });
    expect(out).toEqual({ closed: 1, kept: 0, failed: 1 });
  });

  it('gives up quietly when the sidecar cannot list its tabs', async () => {
    const broken = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    expect(await closeRunTabs({ url: 'http://b:9746/mcp', since: SINCE, holder: 'x', fetch: broken })).toEqual({ closed: 0, kept: 0, failed: 0 });
    const s = sidecar([{ pageId: 'p', createdAt: T, keepUntil: null }], { listStatus: 503 });
    expect(await closeRunTabs({ url: 'http://b:9746/mcp', since: SINCE, holder: 'x', fetch: s.fake })).toEqual({ closed: 0, kept: 0, failed: 0 });
    expect(s.deleted).toEqual([]);
  });

  it('writes no event when there was nothing to close', async () => {
    const s = sidecar([{ pageId: 'old', createdAt: T - 1, keepUntil: null }]);
    const logged: unknown[] = [];
    await closeRunTabs({ url: 'http://b:9746/mcp', since: SINCE, holder: 'x', fetch: s.fake, events: { log: (e) => (logged.push(e), e as never) } });
    expect(logged).toEqual([]);
  });
});
