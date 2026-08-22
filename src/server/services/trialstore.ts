/**
 * Fetching a store zip, and reading one app out of it.
 *
 * This is the only place in Touchstone that dereferences a URL a caller chose, which makes it
 * the only place that needs an allowlist. Everything else the server fetches is configured
 * (`api.github.com` for the registry, the bench pool, the agent) or is a callback the agent
 * makes *inbound*. A trial reverses that: somebody names an address and this process GETs it.
 *
 * **Why that matters more here than it looks.** `routes/mcp-admin.ts` can be turned on and
 * beaconified into an aggregator that authenticates nobody, and `run_trial` is one of its write
 * tools. Without a host allowlist, "audit this store" would be a general-purpose request
 * forgery primitive pointed at whatever else is reachable from this box — the metadata service,
 * a sibling container, a management port. Invariant 6 is about what an agent may *assert*; this
 * is the same instinct applied to what an agent may make the server *reach*.
 *
 * Three guards, and they are independent on purpose:
 *
 * 1. **Host allowlist.** GitHub's archive hosts, plus Touchstone's own external address so an
 *    upload session's store can be re-read. Nothing else, and no way to configure "any".
 * 2. **Redirects are followed by hand**, re-checking the allowlist at every hop. `fetch`'s
 *    default `follow` would let an allowed host bounce us anywhere it liked.
 * 3. **A byte cap, enforced while streaming** rather than after. A `content-length` is a claim,
 *    not a fact, and an unbounded read is the failure mode that takes the box down rather than
 *    the request.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { unzipSync } from 'fflate';

/** Hosts a store archive may be fetched from. GitHub serves an archive for any ref. */
const ALLOWED_HOSTS = new Set(['github.com', 'www.github.com', 'codeload.github.com']);

/** How many hops. GitHub bounces `github.com/.../archive` to `codeload`, so one is not enough. */
const MAX_REDIRECTS = 4;

/** Refused past this. A store is an app directory, not a disk image. */
export const MAX_STORE_BYTES = 32 * 1024 * 1024;

export class TrialStoreError extends Error {}

/** What the prompt needs about the app, read out of the archive. */
export interface TrialSource {
  /** Every file in the app directory, so `assets` can be judged on what is actually there. */
  files: string[];
  compose: string;
  rationale?: string | null;
}

/**
 * Whether this URL may be fetched, given where the caller says Touchstone lives.
 *
 * `publicBaseUrl` is allowed because an upload session's store is served by *this* app, and a
 * trial of uploaded files goes through the same fetch as any other so there is one code path
 * rather than a bypass for the case we happen to trust.
 */
export function storeUrlAllowed(url: string, publicBaseUrl?: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (ALLOWED_HOSTS.has(parsed.hostname)) return true;
  if (publicBaseUrl) {
    try {
      if (new URL(publicBaseUrl).hostname === parsed.hostname) return true;
    } catch {
      // A malformed public_base_url is a config error, not a reason to widen the allowlist.
    }
  }
  return false;
}

/**
 * GET a store archive, following redirects by hand and refusing to grow past the cap.
 *
 * Every hop is re-checked: an allowlisted host that 302s elsewhere is exactly the hole a
 * one-time check leaves open.
 */
export async function fetchStoreZip(
  url: string,
  opts: { publicBaseUrl?: string; maxBytes?: number; fetchImpl?: typeof fetch } = {},
): Promise<Buffer> {
  const doFetch = opts.fetchImpl ?? fetch;
  const cap = opts.maxBytes ?? MAX_STORE_BYTES;
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!storeUrlAllowed(current, opts.publicBaseUrl)) {
      throw new TrialStoreError(
        `refusing to fetch ${current} — a store must come from GitHub or from this Touchstone`,
      );
    }
    const res = await doFetch(current, { redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      const next = res.headers.get('location');
      if (!next) throw new TrialStoreError(`${current} redirected without a location`);
      current = new URL(next, current).toString();
      continue;
    }
    if (!res.ok) {
      throw new TrialStoreError(`could not fetch the store: ${res.status} ${res.statusText}`);
    }
    const claimed = Number(res.headers.get('content-length') ?? 0);
    if (claimed > cap) {
      throw new TrialStoreError(`that store is ${claimed} bytes and the limit is ${cap}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    // Checked again against the bytes actually received: content-length is a claim.
    if (body.byteLength > cap) {
      throw new TrialStoreError(`that store is ${body.byteLength} bytes and the limit is ${cap}`);
    }
    return body;
  }
  throw new TrialStoreError(`the store URL redirected more than ${MAX_REDIRECTS} times`);
}

/**
 * Read one app's directory out of a store archive.
 *
 * A GitHub archive wraps everything in a single `<repo>-<ref>/` directory, and `UploadStore`
 * reproduces that shape deliberately so the two are indistinguishable here. An archive with
 * `<apps_path>/` at the root is accepted too — it costs one line and is what somebody hand-
 * rolling a store will produce on the first try.
 */
export function readAppFromZip(zip: Buffer, appsPath: string, subject: string): TrialSource {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(zip));
  } catch (err) {
    throw new TrialStoreError(`that store is not a readable zip: ${(err as Error).message}`);
  }

  const names = Object.keys(entries).filter((n) => !n.endsWith('/'));
  // Both layouts, tried in the order they actually occur.
  const wrapped = `/${appsPath}/${subject}/`;
  const bare = `${appsPath}/${subject}/`;
  const found = new Map<string, Uint8Array>();
  for (const name of names) {
    const at = name.indexOf(wrapped);
    // A wrapper is one segment: `<top>/Apps/<App>/…`, so the match must start after it and the
    // part before it must contain no slash of its own.
    if (at > 0 && !name.slice(0, at).includes('/')) {
      found.set(name.slice(at + wrapped.length), entries[name]!);
    } else if (name.startsWith(bare)) {
      found.set(name.slice(bare.length), entries[name]!);
    }
  }

  if (found.size === 0) {
    throw new TrialStoreError(
      `that store has no ${appsPath}/${subject}/ directory — check the app name and apps_path`,
    );
  }

  const text = (rel: string): string | null => {
    const bytes = found.get(rel);
    return bytes ? Buffer.from(bytes).toString('utf8') : null;
  };
  const compose = text('docker-compose.yml') ?? text('docker-compose.yaml');
  // The one failure worth catching before the run rather than during it: with no compose there
  // is nothing for the static rubric to read, and the audit would spend its minutes concluding
  // that an app has no compose file — a fact about the archive, dressed as a finding about the
  // app, and recorded where a finding about the app goes.
  if (!compose) {
    throw new TrialStoreError(
      `${appsPath}/${subject}/ in that store has no docker-compose.yml`,
    );
  }

  return {
    files: [...found.keys()].sort((a, b) => a.localeCompare(b)),
    compose,
    rationale: text('rationale.md'),
  };
}

/** Write the trial's own copy of the archive, creating its directory. */
export async function saveStoreZip(zipPath: string, zip: Buffer): Promise<void> {
  await fs.mkdir(path.dirname(zipPath), { recursive: true });
  await fs.writeFile(zipPath, zip);
}
