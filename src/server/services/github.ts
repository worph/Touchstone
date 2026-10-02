/**
 * The workshop's GitHub client — the only code in Touchstone that writes to GitHub.
 *
 * Everything else reads GitHub unauthenticated (`store/registry.ts`, `services/storedoc.ts`)
 * and this deliberately does not share their budget: a problem with the bot account must not
 * be able to make an origin unreachable and stop the runner (invariant 3).
 *
 * ## The guard is this file
 *
 * The token can move any branch of the origin repo, and `main` is not protected (D14 in
 * docs/auto-app-pr.md). So nothing on GitHub's side stops a bad call from rewriting the store.
 * Three rules keep that from being spellable rather than merely unused:
 *
 * - **Every ref write goes through `refWrite`,** which runs `assertOwnRef` before a request
 *   is built. `OWN_REF` admits `refs/heads/touchstone/<kind>/<name>` and nothing else — no
 *   slash in the name, no `..`, no leading dot or dash.
 * - **There is no update.** A branch is created once and deleted once. `request()` refuses
 *   PATCH and PUT on any `git/refs` path, so a force-push cannot be written even by accident.
 * - **The token never leaves.** It is in a header and nowhere else, and every error message is
 *   scrubbed of it before it is thrown — an error ends up in the event log and on a page.
 *
 * Commits are made through the Git Data API (blobs → tree → commit → ref), so there is no
 * clone, no `git` binary and no token-bearing remote on disk.
 */

import { isAppDirName } from '../store/trials.js';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** A ref outside `refs/heads/touchstone/` was asked for. Thrown before any request. */
export class GitHubRefRefused extends Error {}

export const OWN_REF = /^refs\/heads\/touchstone\/(fix|currency|wish)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Refuse any ref this client may not write. The test pins that `main` makes zero calls. */
export function assertOwnRef(ref: string): void {
  if (!OWN_REF.test(ref) || ref.includes('..') || ref.endsWith('.') || ref.endsWith('.lock')) {
    throw new GitHubRefRefused(`refusing to write ${JSON.stringify(ref)}: only refs/heads/touchstone/… is ours`);
  }
}

/** The branch name a PR's `head` takes — the ref without `refs/heads/`. */
export function branchOf(ref: string): string {
  assertOwnRef(ref);
  return ref.slice('refs/heads/'.length);
}

export interface GitHubOptions {
  token: string;
  /** `owner/name` — the origin repo, which the branches live on and the PRs target. */
  repo: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface TreeEntry {
  path: string;
  /** A blob sha, or `null` to delete the path. */
  sha: string | null;
}

export interface CommitAuthor {
  name: string;
  email: string;
}

const API = 'https://api.github.com';
const SHA_RE = /^[0-9a-f]{40}$/;

export class GitHubClient {
  private readonly pullFiles = new Map<string, string[]>();

  constructor(private readonly opts: GitHubOptions) {}

  get repo(): string {
    return this.opts.repo;
  }

  async user(): Promise<{ login: string; id: number }> {
    const u = await this.request<{ login?: string; id?: number }>('GET', '/user');
    return { login: String(u.login ?? ''), id: Number(u.id ?? 0) };
  }

  async repoInfo(): Promise<{ push: boolean; default_branch: string }> {
    const r = await this.request<{ permissions?: { push?: boolean }; default_branch?: string }>(
      'GET',
      this.repoPath(''),
    );
    return { push: r.permissions?.push === true, default_branch: String(r.default_branch ?? '') };
  }

  async labelExists(name: string): Promise<boolean> {
    try {
      await this.request('GET', this.repoPath(`/labels/${encodeURIComponent(name)}`));
      return true;
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return false;
      throw err;
    }
  }

  /** The commit a branch points at. */
  async headOf(branch: string): Promise<string> {
    const r = await this.request<{ object?: { sha?: string } }>(
      'GET',
      this.repoPath(`/git/ref/heads/${encodeBranch(branch)}`),
    );
    return checkSha(r.object?.sha, `head of ${branch}`);
  }

  /** The root tree of a commit. */
  async commitTree(commit: string): Promise<string> {
    const r = await this.request<{ tree?: { sha?: string } }>(
      'GET',
      this.repoPath(`/git/commits/${checkSha(commit, 'commit')}`),
    );
    return checkSha(r.tree?.sha, `tree of ${commit}`);
  }

  /**
   * The tree sha of `<appsPath>/<app>` at a commit, or `null` when the directory is absent.
   *
   * This is what "the app has not changed since the proposal was built on it" compares: a tree
   * sha moves when any file under it does, and stays put for any change elsewhere in the store.
   */
  async appTreeSha(appsPath: string, app: string, commit: string): Promise<string | null> {
    if (!isAppDirName(app)) throw new GitHubError(`not an app directory name: ${app}`);
    const dir = appsPath.replace(/^\/+|\/+$/g, '');
    let rows: unknown;
    try {
      rows = await this.request(
        'GET',
        this.repoPath(`/contents/${dir.split('/').map(encodeURIComponent).join('/')}?ref=${checkSha(commit, 'commit')}`),
      );
    } catch (err) {
      if (err instanceof GitHubError && err.status === 404) return null;
      throw err;
    }
    if (!Array.isArray(rows)) throw new GitHubError(`${dir} is not a directory`);
    const hit = (rows as { name?: string; type?: string; sha?: string }[]).find(
      (r) => r.name === app && r.type === 'dir',
    );
    return hit?.sha ? checkSha(hit.sha, `tree of ${app}`) : null;
  }

  async createBlob(bytes: Uint8Array): Promise<string> {
    const r = await this.request<{ sha?: string }>('POST', this.repoPath('/git/blobs'), {
      content: Buffer.from(bytes).toString('base64'),
      encoding: 'base64',
    });
    return checkSha(r.sha, 'blob');
  }

  async createTree(baseTree: string, entries: TreeEntry[]): Promise<string> {
    const r = await this.request<{ sha?: string }>('POST', this.repoPath('/git/trees'), {
      base_tree: checkSha(baseTree, 'base tree'),
      tree: entries.map((e) => ({ path: e.path, mode: '100644', type: 'blob', sha: e.sha })),
    });
    return checkSha(r.sha, 'tree');
  }

  async createCommit(message: string, tree: string, parent: string, author: CommitAuthor): Promise<string> {
    const r = await this.request<{ sha?: string }>('POST', this.repoPath('/git/commits'), {
      message,
      tree: checkSha(tree, 'tree'),
      parents: [checkSha(parent, 'parent')],
      author,
      committer: author,
    });
    return checkSha(r.sha, 'commit');
  }

  /** Create `ref` at `sha`. Never moves an existing ref — GitHub answers 422 if it exists. */
  async createBranch(ref: string, sha: string): Promise<void> {
    await this.refWrite('create', ref, sha);
  }

  /** Delete `ref`. A ref already gone is not an error: the end state is the one asked for. */
  async deleteBranch(ref: string): Promise<void> {
    try {
      await this.refWrite('delete', ref);
    } catch (err) {
      if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) return;
      throw err;
    }
  }

  async openPull(input: { title: string; head: string; base: string; body: string }): Promise<{ number: number; url: string }> {
    const r = await this.request<{ number?: number; html_url?: string }>('POST', this.repoPath('/pulls'), {
      title: input.title,
      head: input.head,
      base: input.base,
      body: input.body,
      maintainer_can_modify: true,
    });
    if (typeof r.number !== 'number') throw new GitHubError('GitHub opened a pull request without a number');
    return { number: r.number, url: String(r.html_url ?? '') };
  }

  async addLabel(pull: number, label: string): Promise<void> {
    await this.request('POST', this.repoPath(`/issues/${pull}/labels`), { labels: [label] });
  }

  async pull(n: number): Promise<{ state: 'open' | 'closed'; merged: boolean }> {
    const r = await this.request<{ state?: string; merged?: boolean; merged_at?: string | null }>(
      'GET',
      this.repoPath(`/pulls/${n}`),
    );
    return { state: r.state === 'closed' ? 'closed' : 'open', merged: r.merged === true || !!r.merged_at };
  }

  /**
   * Every app directory an **open** pull request touches, whoever opened it.
   *
   * One list call plus one files call per PR, and the files are cached by `number@head sha`
   * so a PR that has not moved costs nothing on the next refresh.
   */
  async openPullApps(appsPath: string): Promise<Set<string>> {
    const prefix = appsPath.replace(/^\/+|\/+$/g, '') + '/';
    const pulls = await this.request<{ number?: number; head?: { sha?: string } }[]>(
      'GET',
      this.repoPath('/pulls?state=open&per_page=100'),
    );
    const out = new Set<string>();
    const live = new Set<string>();
    for (const p of Array.isArray(pulls) ? pulls : []) {
      if (typeof p.number !== 'number') continue;
      const key = `${p.number}@${p.head?.sha ?? ''}`;
      live.add(key);
      let files = this.pullFiles.get(key);
      if (!files) {
        const rows = await this.request<{ filename?: string }[]>(
          'GET',
          this.repoPath(`/pulls/${p.number}/files?per_page=100`),
        );
        files = (Array.isArray(rows) ? rows : []).map((r) => String(r.filename ?? ''));
        this.pullFiles.set(key, files);
      }
      for (const f of files) {
        if (!f.startsWith(prefix)) continue;
        const app = f.slice(prefix.length).split('/')[0];
        if (app) out.add(app);
      }
    }
    for (const key of this.pullFiles.keys()) if (!live.has(key)) this.pullFiles.delete(key);
    return out;
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  private repoPath(rest: string): string {
    return `/repos/${this.opts.repo}${rest}`;
  }

  /** The one door a ref write goes through. The guard runs before anything is built. */
  private async refWrite(op: 'create' | 'delete', ref: string, sha?: string): Promise<void> {
    assertOwnRef(ref);
    if (op === 'create') {
      await this.request('POST', this.repoPath('/git/refs'), { ref, sha: checkSha(sha, 'ref target') }, true);
    } else {
      await this.request('DELETE', this.repoPath(`/git/${ref}`), undefined, true);
    }
  }

  private async request<T = unknown>(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT',
    path: string,
    body?: unknown,
    viaRefWrite = false,
  ): Promise<T> {
    if (/\/git\/refs?\b/.test(path) && method !== 'GET') {
      if (method === 'PATCH' || method === 'PUT') {
        throw new GitHubRefRefused('refusing to update a ref: this client creates and deletes, never moves');
      }
      if (!viaRefWrite) throw new GitHubRefRefused('ref writes go through refWrite');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 30_000);
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(`${API}${path}`, {
        method,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${this.opts.token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'touchstone-workshop',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      if (!res.ok) {
        let message = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { message?: string };
          if (j.message) message = j.message;
        } catch {
          /* not JSON */
        }
        throw new GitHubError(this.scrub(`GitHub ${method} ${path} → HTTP ${res.status}: ${message}`), res.status);
      }
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (err) {
      if (err instanceof GitHubError || err instanceof GitHubRefRefused) throw err;
      throw new GitHubError(this.scrub(`GitHub ${method} ${path} failed: ${(err as Error).message}`));
    } finally {
      clearTimeout(timer);
    }
  }

  private scrub(text: string): string {
    return this.opts.token ? text.split(this.opts.token).join('••••') : text;
  }
}

function checkSha(value: unknown, what: string): string {
  if (typeof value !== 'string' || !SHA_RE.test(value)) {
    throw new GitHubError(`GitHub returned no usable sha for ${what}`);
  }
  return value;
}

function encodeBranch(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}
