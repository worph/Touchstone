/**
 * The workshop's GitHub client — and above all its guard.
 *
 * `main` on the store is unprotected (D14), so the token can rewrite it and nothing on GitHub's
 * side would stop it. The tests that matter most here are the ones that count fetch calls:
 * a refused ref must be refused **before** a request exists, not by GitHub.
 */

import { describe, expect, it } from 'vitest';

import { AlertStore } from './alerts.js';
import {
  assertOwnRef,
  branchOf,
  GitHubClient,
  GitHubError,
  GitHubNotFastForward,
  GitHubRefRefused,
  isValidDirectBranch,
  mergeableOf,
} from './github.js';
import { GitHubProbe } from './githubprobe.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TOKEN = 'github_pat_SECRET123';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

interface Call {
  method: string;
  url: string;
  body?: unknown;
  auth?: string;
}

/** A fetch that records every call and answers from a route table: `METHOD path` → [status, body]. */
function fakeGitHub(routes: Record<string, [number, unknown]> = {}) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      method,
      url: u,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.authorization,
    });
    const p = u.replace('https://api.github.com', '');
    const hit = routes[`${method} ${p}`] ?? routes[`${method} ${p.split('?')[0]}`];
    const [status, body] = hit ?? [404, { message: 'Not Found' }];
    return {
      ok: status < 400,
      status,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    } as Response;
  }) as typeof fetch;
  return { impl, calls };
}

function client(routes: Record<string, [number, unknown]> = {}) {
  const gh = fakeGitHub(routes);
  return { c: new GitHubClient({ token: TOKEN, repo: 'Yundera/AppStore', fetchImpl: gh.impl }), calls: gh.calls };
}

describe('the ref guard', () => {
  it.each([
    'refs/heads/main',
    'main',
    'refs/heads/touchstone/fix/../main',
    'refs/heads/touchstone/fix/a/b',
    'refs/heads/touchstone/other/App',
    'refs/heads/touchstone/fix/.hidden',
    'refs/heads/touchstone/fix/-dash',
    'refs/heads/touchstone/fix/App.lock',
    'refs/tags/touchstone/fix/App',
  ])('refuses %s', (ref) => {
    expect(() => assertOwnRef(ref)).toThrow(GitHubRefRefused);
  });

  it('admits the shape refFor produces', () => {
    expect(() => assertOwnRef('refs/heads/touchstone/fix/FileBrowser-20261002-ab12cd')).not.toThrow();
    expect(branchOf('refs/heads/touchstone/wish/Immich-20261002-ab12cd')).toBe('touchstone/wish/Immich-20261002-ab12cd');
  });

  it('createBranch on main makes zero requests', async () => {
    const { c, calls } = client();
    await expect(c.createBranch('refs/heads/main', SHA)).rejects.toThrow(GitHubRefRefused);
    expect(calls).toHaveLength(0);
  });

  it('deleteBranch on main makes zero requests', async () => {
    const { c, calls } = client();
    await expect(c.deleteBranch('refs/heads/main')).rejects.toThrow(GitHubRefRefused);
    await expect(c.deleteBranch('refs/heads/touchstone/fix/../../main')).rejects.toThrow(GitHubRefRefused);
    expect(calls).toHaveLength(0);
  });

  it('cannot update a ref through any door', async () => {
    const { c, calls } = client();
    const req = (c as unknown as { request: (m: string, p: string, b?: unknown) => Promise<unknown> }).request.bind(c);
    await expect(req('PATCH', '/repos/Yundera/AppStore/git/refs/heads/main', { sha: SHA })).rejects.toThrow(GitHubRefRefused);
    await expect(req('POST', '/repos/Yundera/AppStore/git/refs', { ref: 'refs/heads/main', sha: SHA })).rejects.toThrow(
      GitHubRefRefused,
    );
    expect(calls).toHaveLength(0);
  });

  it('creates and deletes an own ref', async () => {
    const ref = 'refs/heads/touchstone/fix/App-20261002-abcdef';
    const { c, calls } = client({
      'POST /repos/Yundera/AppStore/git/refs': [201, { ref }],
      [`DELETE /repos/Yundera/AppStore/git/${ref}`]: [204, undefined],
    });
    await c.createBranch(ref, SHA);
    await c.deleteBranch(ref);
    expect(calls.map((x) => x.method)).toEqual(['POST', 'DELETE']);
    expect(calls[0]!.body).toEqual({ ref, sha: SHA });
  });

  it('a branch already gone is not an error', async () => {
    const { c } = client({});
    await expect(c.deleteBranch('refs/heads/touchstone/fix/App-1')).resolves.toBeUndefined();
  });
});

describe('direct delivery: one branch, fast-forward only (D16)', () => {
  const direct = (routes: Record<string, [number, unknown]> = {}, directBranch = 'main') => {
    const gh = fakeGitHub(routes);
    return { c: new GitHubClient({ token: TOKEN, repo: 'Yundera/AppStore', fetchImpl: gh.impl, directBranch }), calls: gh.calls };
  };
  const HEAD = 'GET /repos/Yundera/AppStore/git/ref/heads/main';
  const PATCH = 'PATCH /repos/Yundera/AppStore/git/refs/heads/main';

  it('without a direct branch, advanceBranch makes zero requests', async () => {
    const { c, calls } = client();
    await expect(c.advanceBranch(SHA, SHA2)).rejects.toThrow(GitHubRefRefused);
    expect(calls).toHaveLength(0);
  });

  it('moves the configured branch with force:false, after checking its head', async () => {
    const { c, calls } = direct({ [HEAD]: [200, { object: { sha: SHA } }], [PATCH]: [200, {}] });
    await c.advanceBranch(SHA, SHA2);
    expect(calls.map((x) => x.method)).toEqual(['GET', 'PATCH']);
    expect(calls[1]!.body).toEqual({ sha: SHA2, force: false });
  });

  it('a head that moved is refused before the PATCH', async () => {
    const { c, calls } = direct({ [HEAD]: [200, { object: { sha: 'c'.repeat(40) } }] });
    await expect(c.advanceBranch(SHA, SHA2)).rejects.toThrow(GitHubNotFastForward);
    expect(calls.map((x) => x.method)).toEqual(['GET']);
  });

  it("GitHub's 422 is a not-fast-forward, scrubbed of the token", async () => {
    const { c } = direct({ [HEAD]: [200, { object: { sha: SHA } }], [PATCH]: [422, { message: `Update is not a fast forward ${TOKEN}` }] });
    const err = await c.advanceBranch(SHA, SHA2).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubNotFastForward);
    expect(String((err as Error).message)).not.toContain(TOKEN);
  });

  it('even with a direct branch, no other door moves a ref, and never with force', async () => {
    const { c, calls } = direct();
    const req = (c as unknown as { request: (m: string, p: string, b?: unknown, d?: string) => Promise<unknown> }).request.bind(c);
    await expect(req('PATCH', '/repos/Yundera/AppStore/git/refs/heads/main', { sha: SHA, force: false })).rejects.toThrow(GitHubRefRefused);
    await expect(req('PATCH', '/repos/Yundera/AppStore/git/refs/heads/main', { sha: SHA, force: true }, 'advance')).rejects.toThrow(GitHubRefRefused);
    await expect(req('PATCH', '/repos/Yundera/AppStore/git/refs/heads/dev', { sha: SHA, force: false }, 'advance')).rejects.toThrow(GitHubRefRefused);
    await expect(req('PUT', '/repos/Yundera/AppStore/git/refs/heads/main', { sha: SHA })).rejects.toThrow(GitHubRefRefused);
    await expect(c.createBranch('refs/heads/main', SHA)).rejects.toThrow(GitHubRefRefused);
    await expect(c.deleteBranch('refs/heads/main')).rejects.toThrow(GitHubRefRefused);
    expect(calls).toHaveLength(0);
  });

  it.each(['touchstone/fix/X', '../main', '-main', 'main.lock', 'a//b', '', 'main/'])('refuses %j as the direct branch', (b) => {
    expect(isValidDirectBranch(b)).toBe(false);
    expect(() => new GitHubClient({ token: TOKEN, repo: 'r/r', directBranch: b })).toThrow(GitHubRefRefused);
  });

  it('admits ordinary branch names', () => {
    for (const b of ['main', 'staging', 'release/2026']) expect(isValidDirectBranch(b)).toBe(true);
  });

  it('a tree entry can restore a whole directory', async () => {
    const { c, calls } = client({ 'POST /repos/Yundera/AppStore/git/trees': [201, { sha: SHA2 }] });
    await c.createTree(SHA, [{ path: 'Apps/X', sha: SHA, type: 'tree' }]);
    expect((calls[0]!.body as { tree: unknown[] }).tree).toEqual([{ path: 'Apps/X', mode: '040000', type: 'tree', sha: SHA }]);
  });
});

describe('the token', () => {
  it('is sent as a bearer and never appears in an error', async () => {
    const gh = fakeGitHub({ 'GET /user': [401, { message: `Bad credentials for ${TOKEN}` }] });
    const c = new GitHubClient({ token: TOKEN, repo: 'Yundera/AppStore', fetchImpl: gh.impl });
    const err = await c.user().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as Error).message).not.toContain(TOKEN);
    expect((err as GitHubError).status).toBe(401);
    expect(gh.calls[0]!.auth).toBe(`Bearer ${TOKEN}`);
  });
});

describe('the Git Data API', () => {
  it('builds a tree with deletions as sha:null and commits with the given author', async () => {
    const { c, calls } = client({
      'POST /repos/Yundera/AppStore/git/blobs': [201, { sha: SHA2 }],
      'POST /repos/Yundera/AppStore/git/trees': [201, { sha: SHA2 }],
      'POST /repos/Yundera/AppStore/git/commits': [201, { sha: SHA2 }],
    });
    expect(await c.createBlob(new Uint8Array([1, 2, 3]))).toBe(SHA2);
    await c.createTree(SHA, [
      { path: 'Apps/X/docker-compose.yml', sha: SHA2 },
      { path: 'Apps/X/old.txt', sha: null },
    ]);
    await c.createCommit('msg', SHA2, SHA, { name: 'Mael (Touchstone)', email: 'm@x' });
    expect(calls[0]!.body).toEqual({ content: 'AQID', encoding: 'base64' });
    expect((calls[1]!.body as { tree: { sha: string | null }[] }).tree[1]!.sha).toBeNull();
    expect((calls[2]!.body as { author: { name: string } }).author.name).toBe('Mael (Touchstone)');
  });

  it('reads an app tree sha, null when the directory is absent', async () => {
    const { c } = client({
      [`GET /repos/Yundera/AppStore/contents/Apps?ref=${SHA}`]: [
        200,
        [
          { name: 'FileBrowser', type: 'dir', sha: SHA2 },
          { name: 'README.md', type: 'file', sha: SHA },
        ],
      ],
    });
    expect(await c.appTreeSha('Apps', 'FileBrowser', SHA)).toBe(SHA2);
    expect(await c.appTreeSha('Apps', 'Immich', SHA)).toBeNull();
  });

  it('lists the apps open pull requests touch, and caches unchanged PRs', async () => {
    const routes: Record<string, [number, unknown]> = {
      'GET /repos/Yundera/AppStore/pulls?state=open&per_page=100': [200, [{ number: 7, head: { sha: SHA } }]],
      'GET /repos/Yundera/AppStore/pulls/7/files?per_page=100': [
        200,
        [{ filename: 'Apps/Immich/docker-compose.yml' }, { filename: 'README.md' }],
      ],
    };
    const { c, calls } = client(routes);
    expect([...(await c.openPullApps('Apps'))]).toEqual(['Immich']);
    expect([...(await c.openPullApps('Apps'))]).toEqual(['Immich']);
    expect(calls.filter((x) => x.url.includes('/files'))).toHaveLength(1);
  });
});

describe('the probe', () => {
  async function alertsIn(): Promise<AlertStore> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-ghprobe-'));
    const a = new AlertStore(dir);
    await a.load();
    return a;
  }

  const healthy: Record<string, [number, unknown]> = {
    'GET /user': [200, { login: 'Mael', id: 42 }],
    'GET /repos/Yundera/AppStore': [200, { permissions: { push: true }, default_branch: 'main' }],
    'GET /repos/Yundera/AppStore/labels/touchstone': [200, { name: 'touchstone' }],
  };

  it('is unconfigured, and silent, with no client', async () => {
    const alerts = await alertsIn();
    const p = new GitHubProbe({ expectedLogin: 'Mael', alerts });
    expect((await p.probe()).state).toBe('unconfigured');
    expect(alerts.isOpen('github.auth')).toBe(false);
  });

  it('opens github.auth for the wrong account, and resolves it on recovery', async () => {
    const alerts = await alertsIn();
    const wrong = client({ ...healthy, 'GET /user': [200, { login: 'someone', id: 1 }] });
    const p1 = new GitHubProbe({ client: wrong.c, expectedLogin: 'Mael', alerts });
    expect((await p1.probe()).state).toBe('failing');
    expect(alerts.isOpen('github.auth')).toBe(true);
    expect(p1.usable()).toBe(false);

    const right = client(healthy);
    const p2 = new GitHubProbe({ client: right.c, expectedLogin: 'Mael', alerts });
    const s = await p2.probe();
    expect(s.state).toBe('ok');
    expect(p2.userId).toBe(42);
    expect(alerts.isOpen('github.auth')).toBe(false);
  });

  it('a missing label warns but does not block', async () => {
    const alerts = await alertsIn();
    const { 'GET /repos/Yundera/AppStore/labels/touchstone': _drop, ...noLabel } = healthy;
    const { c } = client(noLabel);
    const p = new GitHubProbe({ client: c, expectedLogin: 'Mael', alerts });
    const s = await p.probe();
    expect(s.state).toBe('ok');
    expect(s.label).toBe(false);
    expect(p.usable()).toBe(true);
    expect(alerts.isOpen('github.auth')).toBe(true);
  });

  it('cannot push is a failure', async () => {
    const alerts = await alertsIn();
    const { c } = client({ ...healthy, 'GET /repos/Yundera/AppStore': [200, { permissions: { push: false } }] });
    const p = new GitHubProbe({ client: c, expectedLogin: 'Mael', alerts });
    expect((await p.probe()).problems.join()).toContain('cannot push');
  });
});

describe('whether an open PR would merge', () => {
  it('folds mergeable_state into the chip, with mergeable: false winning', () => {
    expect(mergeableOf(true, 'clean')).toBe('clean');
    expect(mergeableOf(true, 'has_hooks')).toBe('clean');
    expect(mergeableOf(true, 'unstable')).toBe('unstable');
    expect(mergeableOf(true, 'behind')).toBe('behind');
    expect(mergeableOf(true, 'blocked')).toBe('blocked');
    expect(mergeableOf(false, 'blocked')).toBe('conflicts');
    expect(mergeableOf(null, 'dirty')).toBe('conflicts');
    expect(mergeableOf(null, 'unknown')).toBe('unknown');
    expect(mergeableOf(true, 'draft')).toBe('unknown');
    expect(mergeableOf(undefined, undefined)).toBe('unknown');
  });
});
