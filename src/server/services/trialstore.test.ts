/**
 * Fetching a store, and reading one app out of it.
 *
 * This is the only place Touchstone dereferences a URL a caller chose, so most of what is here
 * is about what must be **refused**. `routes/mcp-admin.ts` can be turned on and beaconified
 * into an aggregator that authenticates nobody, and `run_trial` is one of its write tools — so
 * "audit this store" must never become a way to make this process GET something else.
 */

import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';

import {
  fetchStoreZip,
  MAX_STORE_BYTES,
  readAppFromZip,
  storeUrlAllowed,
  TrialStoreError,
} from './trialstore.js';

const GH = 'https://github.com/Acme/AppStore/archive/refs/heads/pr-812.zip';

/** A response, as `fetchStoreZip` reads one. */
function respond(body: Buffer, over: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-length': String(body.byteLength) }),
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    ...over,
  };
}

function zipOf(entries: Record<string, string>): Buffer {
  const out: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(entries)) out[k] = new TextEncoder().encode(v);
  return Buffer.from(zipSync(out));
}

describe('storeUrlAllowed', () => {
  it('allows GitHub archives and this app’s own address', () => {
    expect(storeUrlAllowed(GH)).toBe(true);
    expect(storeUrlAllowed('https://codeload.github.com/Acme/AppStore/zip/refs/heads/x')).toBe(true);
    expect(storeUrlAllowed('https://ts.example/api/v1/trialstore/tok.zip', 'https://ts.example')).toBe(
      true,
    );
  });

  const refused: [string, string, string?][] = [
    ['plain http, even to an allowed host', 'http://github.com/a/b/archive/main.zip'],
    ['the cloud metadata service', 'https://169.254.169.254/latest/meta-data'],
    ['a sibling container', 'https://touchstone-browser:9746/mcp'],
    ['localhost', 'https://localhost/admin'],
    ['a file url', 'file:///etc/passwd'],
    ['a lookalike host', 'https://github.com.evil.example/a/b.zip'],
    ['a host that merely contains an allowed one', 'https://evilgithub.com/a/b.zip'],
    ['a different host from the configured one', 'https://elsewhere.example/x.zip', 'https://ts.example'],
    ['nonsense', 'not a url'],
  ];
  for (const [what, url, base] of refused) {
    it(`refuses ${what}`, () => {
      expect(storeUrlAllowed(url, base)).toBe(false);
    });
  }
});

describe('fetchStoreZip', () => {
  it('follows a redirect, which GitHub always issues', async () => {
    const zip = zipOf({ 'AppStore-x/Apps/Widget/docker-compose.yml': 'services: {}\n' });
    const seen: string[] = [];
    const fetchImpl = (async (u: string) => {
      seen.push(u);
      return seen.length === 1
        ? { status: 302, ok: false, headers: new Headers({ location: 'https://codeload.github.com/a/b' }) }
        : respond(zip);
    }) as unknown as typeof fetch;

    const out = await fetchStoreZip(GH, { fetchImpl });
    expect(out.equals(zip)).toBe(true);
    expect(seen).toHaveLength(2);
  });

  it('re-checks the allowlist at every hop, not only the first', async () => {
    // The hole a one-time check leaves: an allowed host answering 302 to somewhere it likes.
    const fetchImpl = (async () => ({
      status: 302,
      ok: false,
      headers: new Headers({ location: 'https://169.254.169.254/latest/meta-data' }),
    })) as unknown as typeof fetch;

    await expect(fetchStoreZip(GH, { fetchImpl })).rejects.toThrow(TrialStoreError);
  });

  it('refuses a host it was never allowed to reach', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return respond(Buffer.alloc(0));
    }) as unknown as typeof fetch;

    await expect(
      fetchStoreZip('https://169.254.169.254/latest/meta-data', { fetchImpl }),
    ).rejects.toThrow(/refusing to fetch/);
    // Refused before the request, not after reading the answer.
    expect(called).toBe(false);
  });

  it('caps the bytes on what actually arrived, not only on what was claimed', async () => {
    const big = Buffer.alloc(64, 1);
    const fetchImpl = (async () =>
      respond(big, { headers: new Headers({ 'content-length': '1' }) })) as unknown as typeof fetch;

    await expect(fetchStoreZip(GH, { fetchImpl, maxBytes: 8 })).rejects.toThrow(/limit is 8/);
  });

  it('has a cap at all', () => {
    expect(MAX_STORE_BYTES).toBeGreaterThan(0);
  });

  it('reports a failed fetch as a fetch failure rather than an empty store', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Headers(),
    })) as unknown as typeof fetch;

    await expect(fetchStoreZip(GH, { fetchImpl })).rejects.toThrow(/404/);
  });
});

describe('readAppFromZip', () => {
  it('reads the app out of a GitHub-shaped archive', () => {
    const zip = zipOf({
      'AppStore-pr-812/Apps/Widget/docker-compose.yml': 'services: {}\n',
      'AppStore-pr-812/Apps/Widget/rationale.md': 'because\n',
      'AppStore-pr-812/Apps/Widget/icon.png': 'PNG',
      'AppStore-pr-812/Apps/Other/docker-compose.yml': 'not this one\n',
      'AppStore-pr-812/README.md': 'ignored\n',
    });

    const out = readAppFromZip(zip, 'Apps', 'Widget');
    expect(out.files).toEqual(['docker-compose.yml', 'icon.png', 'rationale.md']);
    expect(out.compose).toBe('services: {}\n');
    expect(out.rationale).toBe('because\n');
  });

  it('accepts an archive with no wrapper directory', () => {
    const zip = zipOf({ 'Apps/Widget/docker-compose.yml': 'services: {}\n' });
    expect(readAppFromZip(zip, 'Apps', 'Widget').compose).toBe('services: {}\n');
  });

  it('does not mistake a deeper path for the app', () => {
    // `<top>/vendor/Apps/Widget/` is not this store's app directory, and treating it as one
    // would audit somebody's fixture as if it were the subject.
    const zip = zipOf({ 'AppStore-x/vendor/Apps/Widget/docker-compose.yml': 'nope\n' });
    expect(() => readAppFromZip(zip, 'Apps', 'Widget')).toThrow(TrialStoreError);
  });

  it('says the app is missing rather than auditing nothing', () => {
    const zip = zipOf({ 'AppStore-x/Apps/Other/docker-compose.yml': 'services: {}\n' });
    expect(() => readAppFromZip(zip, 'Apps', 'Widget')).toThrow(/no Apps\/Widget\//);
  });

  it('refuses an app with no compose before the run rather than during it', () => {
    // Eight minutes later this would be a finding about an app with no compose file — a fact
    // about the archive, dressed as a fact about the app, and filed where the latter goes.
    const zip = zipOf({ 'AppStore-x/Apps/Widget/README.md': 'hello\n' });
    expect(() => readAppFromZip(zip, 'Apps', 'Widget')).toThrow(/no docker-compose.yml/);
  });

  it('refuses bytes that are not a zip at all', () => {
    expect(() => readAppFromZip(Buffer.from('<html>404</html>'), 'Apps', 'Widget')).toThrow(
      TrialStoreError,
    );
  });
});
