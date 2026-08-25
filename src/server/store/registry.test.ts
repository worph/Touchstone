/**
 * The subject registry, once there is more than one store.
 *
 * The property under test throughout is **isolation**: what one store's GitHub outage may and
 * may not do to another's. An empty registry reads as "backlog empty" and idles the loop
 * forever, which is the one failure it is least able to notice — so a failed fetch must never
 * shrink anything.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '../services/events.js';
import { DEFAULT_APPS, SubjectRegistry } from './registry.js';
import type { OriginEntry } from './config.js';

const YUNDERA: OriginEntry = { id: 'yundera', repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' };
const ACME: OriginEntry = { id: 'acme', repo: 'Acme/AppStore', ref: 'main', apps_path: 'Apps' };

let dir: string;
let events: EventLog;

/**
 * A fetch that answers per repo, so one store can fail while the other succeeds.
 *
 * It answers **both** calls a refresh makes: the contents listing that decides which apps
 * exist, and the recursive tree that carries each app's compose blob sha. The tree answer is
 * derived from the same list so the two cannot disagree; `versions` overrides a sha per app
 * where a test cares about the value.
 */
function fetcher(
  answers: Record<string, string[] | Error>,
  versions: Record<string, string> = {},
): typeof fetch {
  return (async (url: string) => {
    const repo = Object.keys(answers).find((r) => String(url).includes(r));
    const answer = repo ? answers[repo]! : new Error('unknown repo');
    if (answer instanceof Error) throw answer;
    const tree = String(url).includes('/git/trees/');
    return {
      ok: true,
      status: 200,
      json: async () =>
        tree
          ? {
              truncated: false,
              tree: answer.map((name) => ({
                path: `Apps/${name}/docker-compose.yml`,
                type: 'blob',
                sha: versions[name] ?? `sha-${name}`,
              })),
            }
          : answer.map((name) => ({ type: 'dir', name })),
    };
  }) as unknown as typeof fetch;
}

function make(
  origins: OriginEntry[],
  answers: Record<string, string[] | Error>,
  versions: Record<string, string> = {},
): SubjectRegistry {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetcher(answers, versions);
  const reg = new SubjectRegistry({ stateDir: dir, events, origins });
  // Restored in afterEach; the constructor does not fetch.
  void realFetch;
  return reg;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-registry-'));
  events = new EventLog(dir);
  await events.load();
});

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('several stores', () => {
  it('namespaces each store\'s apps into its own keys', async () => {
    const reg = make([YUNDERA, ACME], { 'Yundera/AppStore': ['Ntfy'], 'Acme/AppStore': ['Ntfy', 'Widget'] });
    await reg.refresh();

    // The same app name in two stores is two subjects, which is the whole reason for the key.
    expect(reg.list()).toEqual(['yundera~Ntfy', 'acme~Ntfy', 'acme~Widget']);
  });

  it('does not let one store\'s outage empty another\'s list', async () => {
    const reg = make([YUNDERA, ACME], {
      'Yundera/AppStore': ['Ntfy', 'Caddy'],
      'Acme/AppStore': new Error('ECONNREFUSED'),
    });
    await reg.refresh();

    expect(reg.list()).toContain('yundera~Ntfy');
    expect(reg.list()).toContain('yundera~Caddy');
    expect(reg.reachable('yundera')).toBe(true);
    expect(reg.reachable('acme')).toBe(false);
    expect(reg.failureOf('acme')).toContain('ECONNREFUSED');
    // And the failure names the store, so "the registry is stale" is actionable.
    expect(events.query({ limit: 50 }).some((e) => e.code === 'REGISTRY_FAILED' && (e.detail as { origin?: string })?.origin === 'acme')).toBe(true);
  });

  it('keeps a store\'s last known list through a later outage', async () => {
    const reg = make([ACME], { 'Acme/AppStore': ['Widget'] });
    await reg.refresh();
    expect(reg.list()).toEqual(['acme~Widget']);

    globalThis.fetch = fetcher({ 'Acme/AppStore': new Error('HTTP 503') });
    await reg.refresh();

    // Still there. A registry that empties on a failed fetch reports "backlog empty", which
    // looks exactly like success.
    expect(reg.list()).toEqual(['acme~Widget']);
    // But no longer reachable, which is what stops a run being dispatched against it: the
    // agent would fetch the app's files from the same place and error, burning a try for an
    // infra condition. The subject stays in the backlog and the next tick tries again.
    expect(reg.reachable('acme')).toBe(false);
  });

  it('reports itself live only when every store has been read', async () => {
    const reg = make([YUNDERA, ACME], {
      'Yundera/AppStore': ['Ntfy'],
      'Acme/AppStore': new Error('nope'),
    });
    await reg.refresh();

    expect(reg.isLive).toBe(false);
    expect(reg.status().map((o) => [o.id, o.live])).toEqual([['yundera', true], ['acme', false]]);
  });
});

describe('cold start', () => {
  it('falls back to the built-in list for the Yundera store only', async () => {
    const reg = make([YUNDERA, ACME], {});
    // No refresh: nothing has been fetched.
    const list = reg.list();

    expect(list).toHaveLength(DEFAULT_APPS.length);
    expect(list.every((k) => k.startsWith('yundera~'))).toBe(true);
    // A brand-new store cold-starting empty is honest. The failure `DEFAULT_APPS` guards
    // against is the *known* store emptying, not an unknown one being unknown.
    expect(list.some((k) => k.startsWith('acme~'))).toBe(false);
  });

  it('uses a configured seed for another store', async () => {
    const reg = make([{ ...ACME, seed: ['Widget'] }], {});
    expect(reg.list()).toEqual(['acme~Widget']);
  });
});

describe('state on disk', () => {
  it('reads a file written before stores existed as the default store', async () => {
    await fs.writeFile(
      path.join(dir, 'registry.json'),
      JSON.stringify({ names: ['Ntfy', 'Caddy'], fetched_at: '2026-08-19T00:00:00.000Z' }),
      'utf8',
    );

    const reg = new SubjectRegistry({ stateDir: dir, events, origins: [YUNDERA] });
    await reg.load();

    expect(reg.list()).toEqual(['yundera~Ntfy', 'yundera~Caddy']);
    expect(reg.lastFetchedAt).toBe('2026-08-19T00:00:00.000Z');
  });

  it('round-trips per-store state', async () => {
    const reg = make([YUNDERA, ACME], { 'Yundera/AppStore': ['Ntfy'], 'Acme/AppStore': ['Widget'] });
    await reg.refresh();

    const reloaded = new SubjectRegistry({ stateDir: dir, events, origins: [YUNDERA, ACME] });
    await reloaded.load();

    expect(reloaded.list()).toEqual(['yundera~Ntfy', 'acme~Widget']);
  });
});

describe('a store taken out of config', () => {
  it('keeps its archived subjects out of the backlog', async () => {
    const reg = new SubjectRegistry({
      stateDir: dir,
      events,
      origins: [ACME],
      archived: () => ['acme~Widget', 'gone~Orphan'],
    });

    // `gone` has reports and stays reachable by URL, but it cannot be fetched or audited.
    // Leaving it schedulable would park it as the permanent stalest row and starve the rest.
    expect(reg.list()).toContain('acme~Widget');
    expect(reg.list()).not.toContain('gone~Orphan');
  });
});
