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
  /** Subject keys the archive holds — what `delisted()` is computed against. */
  archived?: string[],
): SubjectRegistry {
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetcher(answers, versions);
  const reg = new SubjectRegistry({
    stateDir: dir,
    events,
    origins,
    ...(archived ? { archived: () => archived } : {}),
  });
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

/**
 * An app the store stopped offering — **delisted**.
 *
 * The distinction the whole feature turns on is between "the store is unreadable, so keep
 * what we knew" and "the store is readable and does not list this". Both arrive as an
 * archived key with no live entry, and they mean opposite things: the first must change
 * nothing, the second must take the subject out of the backlog. A rule that got this wrong in
 * the permissive direction would retire every app in the store during a GitHub outage.
 */
describe('an app the store no longer offers', () => {
  it('marks it delisted and takes it out of the backlog, keeping the rest', async () => {
    const reg = make([YUNDERA], { 'Yundera/AppStore': ['Ntfy', 'Caddy'] }, {}, [
      'yundera~Ntfy',
      'yundera~CasaOS',
    ]);
    await reg.refresh();

    expect(reg.delisted()).toEqual(['yundera~CasaOS']);
    expect(reg.isDelisted('yundera~CasaOS')).toBe(true);
    // Out of the candidate set — auditing it would fetch a directory that is not there.
    expect(reg.list()).not.toContain('yundera~CasaOS');
    // And nothing else moved: an app that IS on offer is untouched by any of this.
    expect(reg.list()).toContain('yundera~Ntfy');
    expect(reg.isDelisted('yundera~Ntfy')).toBe(false);
  });

  it('says so once, when it happens, rather than every refresh', async () => {
    const reg = make([YUNDERA], { 'Yundera/AppStore': ['Ntfy'] }, {}, ['yundera~CasaOS']);
    await reg.refresh();
    await reg.refresh();

    const rows = events.query({ limit: 50 }).filter((e) => e.code === 'SUBJECT_DELISTED');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.message).toContain('CasaOS');
  });

  /**
   * The half that matters most. A store whose last fetch failed delists nobody — otherwise a
   * GitHub outage would retire the whole archive at once, and the recovery would be silent.
   */
  it('delists nobody while the store cannot be read', async () => {
    const reg = make([YUNDERA], { 'Yundera/AppStore': new Error('ECONNREFUSED') }, {}, [
      'yundera~CasaOS',
    ]);
    await reg.refresh();

    expect(reg.reachable('yundera')).toBe(false);
    expect(reg.delisted()).toEqual([]);
    // And it keeps its row in the list, which is the pre-existing outage behaviour unchanged.
    expect(reg.list()).toContain('yundera~CasaOS');
  });

  /**
   * A store dropped from `config.yaml` is a different condition and keeps its own answer: its
   * subjects are already out of `list()`, and calling them delisted would put a chip on a row
   * on the strength of a store nobody asked about.
   */
  it('says nothing about a store that is not configured at all', async () => {
    const reg = make([YUNDERA], { 'Yundera/AppStore': ['Ntfy'] }, {}, ['gone~Orphan']);
    await reg.refresh();

    expect(reg.delisted()).toEqual([]);
    expect(reg.list()).not.toContain('gone~Orphan');
  });
});


/**
 * The version half. It rides the same refresh as the app list and must never be able to harm
 * it: the list is what `reachable()` gates dispatch on, and a store that cannot be audited
 * because a *version* lookup failed would be the feature breaking the thing it exists to
 * sharpen (invariant 3).
 */
describe('what version of each app the store offers', () => {
  it('reads one blob sha per app from a single tree call', async () => {
    const reg = make([YUNDERA], { 'Yundera/AppStore': ['Ntfy', 'Caddy'] }, { Ntfy: 'aaa', Caddy: 'bbb' });
    await reg.refresh();

    expect(reg.versions()).toEqual({ 'yundera~Ntfy': 'aaa', 'yundera~Caddy': 'bbb' });
    expect(reg.versionOf('yundera~Ntfy')).toBe('aaa');
  });

  it('keeps stores apart, as the app lists are', async () => {
    const reg = make(
      [YUNDERA, ACME],
      { 'Yundera/AppStore': ['Ntfy'], 'Acme/AppStore': ['Ntfy'] },
      { Ntfy: 'shared-name-different-app' },
    );
    await reg.refresh();
    expect(Object.keys(reg.versions()).sort()).toEqual(['acme~Ntfy', 'yundera~Ntfy']);
  });

  it('has nothing to say about an app it was never offered a version for', async () => {
    const reg = make([YUNDERA], { 'Yundera/AppStore': ['Ntfy'] });
    await reg.refresh();
    // Absent, not empty-string: "we do not know" and "it changed" must not collapse.
    expect(reg.versionOf('yundera~Missing')).toBeUndefined();
  });

  it('survives a restart, so a tick after a reboot is not a blind one', async () => {
    const reg = make([YUNDERA], { 'Yundera/AppStore': ['Ntfy'] }, { Ntfy: 'aaa' });
    await reg.refresh();

    const reloaded = new SubjectRegistry({ stateDir: dir, events, origins: [YUNDERA] });
    await reloaded.load();
    expect(reloaded.versionOf('yundera~Ntfy')).toBe('aaa');
  });

  /**
   * The tree call failing is not the store failing. If it were, one flaky request would stop
   * the loop dispatching to that origin entirely.
   */
  it('keeps the last known versions and stays reachable when the tree call fails', async () => {
    const reg = make([YUNDERA], { 'Yundera/AppStore': ['Ntfy'] }, { Ntfy: 'aaa' });
    await reg.refresh();

    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/git/trees/')) throw new Error('boom');
      return { ok: true, status: 200, json: async () => [{ type: 'dir', name: 'Ntfy' }] };
    }) as unknown as typeof fetch;
    await reg.refresh();
    globalThis.fetch = realFetch;

    expect(reg.reachable('yundera')).toBe(true);
    expect(reg.versionOf('yundera~Ntfy')).toBe('aaa');
  });

  /**
   * A truncated tree is discarded rather than half-believed: a missing entry looks exactly
   * like an app with no compose, and would read as "nothing to compare" for every app the
   * truncation dropped.
   */
  it('discards a truncated tree rather than believing half of it', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/git/trees/')
          ? { truncated: true, tree: [{ path: 'Apps/Ntfy/docker-compose.yml', type: 'blob', sha: 'aaa' }] }
          : [{ type: 'dir', name: 'Ntfy' }],
    })) as unknown as typeof fetch;
    const reg = new SubjectRegistry({ stateDir: dir, events, origins: [YUNDERA] });
    await reg.refresh();
    globalThis.fetch = realFetch;

    expect(reg.reachable('yundera')).toBe(true);
    expect(reg.versionOf('yundera~Ntfy')).toBeUndefined();
  });

  /** Only the compose directly under the app directory — not one nested deeper. */
  it('ignores a compose that is not the app’s own', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        String(url).includes('/git/trees/')
          ? {
              truncated: false,
              tree: [
                { path: 'Apps/Ntfy/docker-compose.yml', type: 'blob', sha: 'aaa' },
                { path: 'Apps/Ntfy/extras/docker-compose.yml', type: 'blob', sha: 'nested' },
                { path: 'Apps/Ntfy', type: 'tree', sha: 'dir' },
              ],
            }
          : [{ type: 'dir', name: 'Ntfy' }],
    })) as unknown as typeof fetch;
    const reg = new SubjectRegistry({ stateDir: dir, events, origins: [YUNDERA] });
    await reg.refresh();
    globalThis.fetch = realFetch;

    expect(reg.versions()).toEqual({ 'yundera~Ntfy': 'aaa' });
  });
});
