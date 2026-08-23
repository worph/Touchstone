/**
 * Reading a store's own files — the guards, and the one that is a safety property.
 *
 * The path checks are the obvious half. The cache is the half worth a test of its own: the
 * GitHub budget this spends is the registry's budget, and an origin that goes unreachable
 * stops the runner dispatching. A conversation that re-reads the contribution guide three
 * times must cost one request, not three.
 */

import { describe, expect, it } from 'vitest';

import { pathProblem, StoreDocError, StoreDocReader } from './storedoc.js';

const ORIGIN = { id: 'yundera', repo: 'Yundera/AppStore', ref: 'main' };

/** A fetch that records what it was asked for and answers with a canned contents payload. */
function fakeFetch(payload: unknown, opts: { status?: number; headers?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    calls.push(String(url));
    return {
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      headers: { get: (k: string) => opts.headers?.[k] ?? null },
      json: async () => payload,
    };
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function fileOf(text: string) {
  const content = Buffer.from(text, 'utf8');
  return { type: 'file', size: content.byteLength, encoding: 'base64', content: content.toString('base64') };
}

describe('the path', () => {
  it('refuses a URL, because this reads a repository and not the internet', () => {
    expect(pathProblem('https://example.com/x')).toContain('URL');
  });

  it('refuses climbing out of the repository', () => {
    expect(pathProblem('../../etc/passwd')).toContain('..');
    expect(pathProblem('docs/../../secrets')).toContain('..');
  });

  it('refuses an absolute path, and says what to do instead', () => {
    expect(pathProblem('/CONTRIBUTING.md')).toContain('leading /');
  });

  it('allows the ordinary ones', () => {
    expect(pathProblem('CONTRIBUTING.md')).toBeNull();
    expect(pathProblem('Apps/FileBrowser/docker-compose.yml')).toBeNull();
  });
});

describe('reading a file', () => {
  it('asks for the pinned ref, not the default branch', async () => {
    const { impl, calls } = fakeFetch(fileOf('# Contributing'));
    const reader = new StoreDocReader({ fetchImpl: impl });
    await reader.read({ ...ORIGIN, ref: 'next' }, 'CONTRIBUTING.md');

    expect(calls[0]).toContain('/repos/Yundera/AppStore/contents/CONTRIBUTING.md');
    expect(calls[0]).toContain('ref=next');
  });

  it('hands back the text, decoded', async () => {
    const { impl } = fakeFetch(fileOf('# Contributing\n\ncpu_shares: 80 for user-facing.'));
    const doc = await new StoreDocReader({ fetchImpl: impl }).read(ORIGIN, 'CONTRIBUTING.md');

    expect(doc.kind).toBe('file');
    if (doc.kind !== 'file') throw new Error('expected a file');
    expect(doc.text).toContain('cpu_shares');
  });

  it('lists a directory, because "what docs are there" is the other question asked', async () => {
    const { impl } = fakeFetch([
      { name: 'CONTRIBUTING.md', type: 'file', size: 120 },
      { name: 'Apps', type: 'dir' },
    ]);
    const doc = await new StoreDocReader({ fetchImpl: impl }).read(ORIGIN, '.');

    expect(doc.kind).toBe('dir');
    if (doc.kind !== 'dir') throw new Error('expected a listing');
    expect(doc.entries.map((e) => e.name)).toEqual(['CONTRIBUTING.md', 'Apps']);
  });

  it('refuses a file over the cap, on the bytes that arrived and not the size claimed', async () => {
    const big = fileOf('x'.repeat(2048));
    // A claim of nothing, and two kilobytes in the payload: the cap has to hold on the second.
    const { impl } = fakeFetch({ ...big, size: 1 });
    await expect(new StoreDocReader({ fetchImpl: impl, maxBytes: 512 }).read(ORIGIN, 'big.md')).rejects.toThrow(
      /512/,
    );
  });

  it('refuses a binary rather than emptying it into a conversation', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x00, 0x01]);
    const { impl } = fakeFetch({ type: 'file', size: 4, encoding: 'base64', content: bytes.toString('base64') });
    await expect(new StoreDocReader({ fetchImpl: impl }).read(ORIGIN, 'logo.png')).rejects.toThrow(/binary/);
  });

  it('says a missing file is missing, naming the ref it looked at', async () => {
    const { impl } = fakeFetch({}, { status: 404 });
    await expect(new StoreDocReader({ fetchImpl: impl }).read(ORIGIN, 'nope.md')).rejects.toThrow(
      /Yundera\/AppStore@main has no nope\.md/,
    );
  });

  /** The registry reads the same budget, so this refusal has to be legible as one. */
  it('names the shared rate limit rather than implying the file is absent', async () => {
    const { impl } = fakeFetch({}, { status: 403, headers: { 'x-ratelimit-remaining': '0' } });
    await expect(new StoreDocReader({ fetchImpl: impl }).read(ORIGIN, 'CONTRIBUTING.md')).rejects.toThrow(
      /rate limit with the app registry/,
    );
  });

  it('refuses a bad path without spending a request on it', async () => {
    const { impl, calls } = fakeFetch(fileOf('x'));
    await expect(new StoreDocReader({ fetchImpl: impl }).read(ORIGIN, '../etc/passwd')).rejects.toBeInstanceOf(
      StoreDocError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('the cache', () => {
  it('spends one request on a document read three times', async () => {
    const { impl, calls } = fakeFetch(fileOf('# Contributing'));
    const reader = new StoreDocReader({ fetchImpl: impl });

    await reader.read(ORIGIN, 'CONTRIBUTING.md');
    await reader.read(ORIGIN, 'CONTRIBUTING.md');
    await reader.read(ORIGIN, 'CONTRIBUTING.md');

    expect(calls).toHaveLength(1);
    expect(reader.cached(ORIGIN, 'CONTRIBUTING.md')).toBe(true);
  });

  it('keys on the ref, so two origins over one repo do not answer for each other', async () => {
    const { impl, calls } = fakeFetch(fileOf('# Contributing'));
    const reader = new StoreDocReader({ fetchImpl: impl });

    await reader.read(ORIGIN, 'CONTRIBUTING.md');
    await reader.read({ ...ORIGIN, ref: 'next' }, 'CONTRIBUTING.md');

    expect(calls).toHaveLength(2);
  });

  it('expires, so a guide edited this afternoon is not answered from this morning', async () => {
    const { impl, calls } = fakeFetch(fileOf('# Contributing'));
    const reader = new StoreDocReader({ fetchImpl: impl, ttlMs: 0 });

    await reader.read(ORIGIN, 'CONTRIBUTING.md');
    await reader.read(ORIGIN, 'CONTRIBUTING.md');

    expect(calls).toHaveLength(2);
  });
});
