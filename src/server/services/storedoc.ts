/**
 * Reading a file out of a store's own repository.
 *
 * The rubric is supposed to track the store's contribution guide, and until now nothing in
 * Touchstone could see that guide: the chat could infer from what audits happened to quote it,
 * which is an inference about an inference. This is the other half of `get_protocol` — the
 * document the rubric is measured against.
 *
 * ## Why this is not a second `trialstore.ts`
 *
 * `services/trialstore.ts` is the only place a **caller-chosen URL** is dereferenced, and its
 * header explains at length why that one place needs a host allowlist, a re-check at every
 * redirect hop and a cap on what arrived. None of that applies here and the difference is not
 * a matter of degree: the host is a constant in this file, the repo and the ref come from
 * `config.yaml` via `SubjectRegistry.origins`, and the caller supplies only a **path inside a
 * repository Touchstone already reads on every registry refresh**. There is no request-forgery
 * primitive to build out of a path.
 *
 * Two consequences worth stating rather than rediscovering:
 *
 * - **No credential goes out.** The registry reads GitHub unauthenticated and so does this, so
 *   only public repositories resolve at all. There is nothing here to exfiltrate with a clever
 *   path, because there is nothing here a logged-out browser could not fetch.
 * - **The rate limit is shared.** Unauthenticated GitHub allows 60 requests an hour per IP and
 *   `SubjectRegistry.refreshOne` spends from the same budget. A chat turn that re-reads
 *   CONTRIBUTING.md three times must not be able to make an origin unreachable, because an
 *   unreachable origin stops the runner dispatching — an infra condition standing in the way of
 *   audits, which is what invariant 3 exists to prevent. Hence the cache below, which is a
 *   safety property and not a performance one.
 */

import { contentUrlFor } from '../store/registry.js';

/** What a read needs to know about a store. `apps_path` is not used; the path is given. */
export interface StoreOrigin {
  id: string;
  repo: string;
  ref: string;
}

export interface StoreFile {
  kind: 'file';
  path: string;
  bytes: number;
  text: string;
}

export interface StoreListing {
  kind: 'dir';
  path: string;
  entries: { name: string; type: string; bytes?: number }[];
}

export type StoreDoc = StoreFile | StoreListing;

export class StoreDocError extends Error {}

/** Big enough for any guide, small enough that nobody reads a tarball into a chat turn. */
const MAX_BYTES = 256 * 1024;

/** Long enough to cover one conversation about one document. */
const TTL_MS = 5 * 60 * 1000;

const MAX_PATH = 400;

/**
 * Why this path cannot be read, or null.
 *
 * Traversal is refused rather than normalised. `../../` out of a repository does not resolve to
 * anything on the contents API, so this is not defence in depth so much as refusing to send a
 * request whose meaning we cannot state — and the message it produces is one the model can act
 * on, which a GitHub 404 is not.
 */
export function pathProblem(raw: string): string | null {
  const path = raw.trim();
  if (path === '') return 'name a path inside the store, like CONTRIBUTING.md';
  if (path.length > MAX_PATH) return `that path is ${path.length} characters and the limit is ${MAX_PATH}`;
  if (path.includes('://')) return 'that is a URL — give a path inside the store, like docs/CONTRIBUTING.md';
  if (path.startsWith('/')) return 'paths are relative to the top of the repository, so drop the leading /';
  if (path.includes('\\')) return 'use / between path segments';
  if (path.split('/').some((seg) => seg === '..')) return 'a path may not climb out of the repository with ..';
  return null;
}

interface Cached {
  at: number;
  doc: StoreDoc;
}

export interface StoreDocOptions {
  fetchTimeoutMs?: number;
  maxBytes?: number;
  ttlMs?: number;
  /** Test seam. Production passes nothing and gets the global. */
  fetchImpl?: typeof fetch;
}

export class StoreDocReader {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly opts: StoreDocOptions = {}) {}

  /** For the tests, and for anybody wondering whether an answer was fresh. */
  cached(origin: StoreOrigin, path: string): boolean {
    const hit = this.cache.get(keyOf(origin, path));
    return hit !== undefined && Date.now() - hit.at < (this.opts.ttlMs ?? TTL_MS);
  }

  async read(origin: StoreOrigin, rawPath: string): Promise<StoreDoc> {
    const problem = pathProblem(rawPath);
    if (problem) throw new StoreDocError(problem);
    const path = rawPath.trim().replace(/^\/+|\/+$/g, '');

    const key = keyOf(origin, path);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < (this.opts.ttlMs ?? TTL_MS)) return hit.doc;

    const doc = await this.fetchDoc(origin, path);
    this.cache.set(key, { at: Date.now(), doc });
    return doc;
  }

  private async fetchDoc(origin: StoreOrigin, path: string): Promise<StoreDoc> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs ?? 30_000);
    const doFetch = this.opts.fetchImpl ?? fetch;
    try {
      const res = await doFetch(contentUrlFor(origin, path), {
        signal: controller.signal,
        headers: { 'user-agent': 'touchstone-registry', accept: 'application/vnd.github+json' },
      });

      if (res.status === 404) {
        throw new StoreDocError(`${origin.repo}@${origin.ref} has no ${path}`);
      }
      if (res.status === 403 || res.status === 429) {
        // Naming the budget matters: the same one gates the registry, so "try again later" is
        // the honest answer rather than "that file does not exist".
        const remaining = res.headers.get('x-ratelimit-remaining');
        throw new StoreDocError(
          `GitHub refused the read (HTTP ${res.status}` +
            (remaining === null ? '' : `, ${remaining} requests left this hour`) +
            ') — this shares its rate limit with the app registry, so wait rather than retry',
        );
      }
      if (!res.ok) throw new StoreDocError(`GitHub answered HTTP ${res.status} for ${path}`);

      const payload: unknown = await res.json();

      if (Array.isArray(payload)) {
        const rows = payload as { name?: string; type?: string; size?: number }[];
        return {
          kind: 'dir',
          path,
          entries: rows
            .filter((r) => typeof r.name === 'string')
            .map((r) => ({
              name: r.name!,
              type: r.type === 'dir' ? 'dir' : 'file',
              ...(typeof r.size === 'number' && r.type !== 'dir' ? { bytes: r.size } : {}),
            })),
        };
      }

      const row = (payload ?? {}) as { type?: string; size?: number; content?: string; encoding?: string };
      if (row.type !== 'file') {
        throw new StoreDocError(`${path} is a ${row.type ?? 'thing'}, not a file this can read`);
      }

      const cap = this.opts.maxBytes ?? MAX_BYTES;
      const claimed = typeof row.size === 'number' ? row.size : 0;
      if (claimed > cap) {
        throw new StoreDocError(`${path} is ${claimed} bytes and the limit is ${cap}`);
      }
      if (row.encoding !== 'base64' || typeof row.content !== 'string') {
        throw new StoreDocError(`GitHub returned no readable content for ${path}`);
      }

      const buf = Buffer.from(row.content, 'base64');
      // Checked against what arrived, not against what was claimed — the same reason
      // `trialstore.ts` checks twice.
      if (buf.byteLength > cap) {
        throw new StoreDocError(`${path} is ${buf.byteLength} bytes and the limit is ${cap}`);
      }
      if (buf.includes(0)) {
        throw new StoreDocError(`${path} is a binary file, so there is nothing to read out of it`);
      }

      return { kind: 'file', path, bytes: buf.byteLength, text: buf.toString('utf8') };
    } catch (err) {
      if (err instanceof StoreDocError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new StoreDocError(`${origin.repo}@${origin.ref} could not be read: ${message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

function keyOf(origin: StoreOrigin, path: string): string {
  return `${origin.repo}@${origin.ref}/${path}`;
}
