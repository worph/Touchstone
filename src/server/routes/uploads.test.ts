/**
 * `/uploads/:token/*` — the door a trial's files come through.
 *
 * What is worth testing here is everything that decides how far a token reaches: that it
 * cannot be walked out of its own directory, that the caps are real rather than documented,
 * that an unknown token and a lapsed one are indistinguishable, and that swapping the
 * content-type parsers for this plugin does not disturb the JSON API registered beside it.
 * The last one is the kind of thing that works in a unit test of the plugin alone and breaks
 * the whole server, so it is tested through the real route tree.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { unzipSync } from 'fflate';

import { fixtureStore } from '../domain/fixtures.js';
import { UploadStore } from '../store/uploads.js';
import routes from './index.js';

let dir: string;
let app: FastifyInstance | undefined;

const LIMITS = { max_file_bytes: 1024, max_total_bytes: 2048, ttl_min: 60 };

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-uploads-'));
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

async function serve(now: () => Date = () => new Date()): Promise<{
  instance: FastifyInstance;
  uploads: UploadStore;
}> {
  const uploads = new UploadStore(
    path.join(dir, 'state'),
    path.join(dir, 'uploads'),
    LIMITS,
    now,
  );
  await uploads.load();

  const instance = Fastify();
  await instance.register(routes, {
    prefix: '/api/v1',
    store: fixtureStore(),
    uploads: { uploads, maxFileBytes: LIMITS.max_file_bytes },
  });
  await instance.ready();
  app = instance;
  return { instance, uploads };
}

const put = (instance: FastifyInstance, token: string, file: string, payload: string | Buffer) =>
  instance.inject({
    method: 'PUT',
    url: `/api/v1/uploads/${token}/${file}`,
    payload,
    headers: { 'content-type': 'application/octet-stream' },
  });

describe('writing into a session', () => {
  it('takes a file, lists it, and hands it back as the bytes that were sent', async () => {
    const { instance, uploads } = await serve();
    const session = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });

    const written = await put(instance, session.token, 'docker-compose.yml', 'name: touchstone\n');
    expect(written.statusCode).toBe(200);
    expect(written.json()).toMatchObject({ path: 'docker-compose.yml', bytes: 17 });

    const listed = await instance.inject({ method: 'GET', url: `/api/v1/uploads/${session.token}` });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { files: { path: string }[]; total_bytes: number; id: string };
    expect(body.files.map((f) => f.path)).toEqual(['docker-compose.yml']);
    expect(body.total_bytes).toBe(17);

    // YAML survived a round trip byte for byte. A JSON parser in this path would have
    // rejected it outright, which is the reason the parsers are swapped.
    expect(await uploads.readText(session, 'docker-compose.yml')).toBe('name: touchstone\n');

    // The token is the credential and is never echoed back to its own holder.
    expect(JSON.stringify(body)).not.toContain(session.token);
  });

  it('keeps nested paths, and deletes one file without touching the rest', async () => {
    const { instance, uploads } = await serve();
    const session = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });

    await put(instance, session.token, 'docker-compose.yml', 'a');
    await put(instance, session.token, 'pre-install/setup.sh', 'b');

    const removed = await instance.inject({
      method: 'DELETE',
      url: `/api/v1/uploads/${session.token}/pre-install/setup.sh`,
    });
    expect(removed.statusCode).toBe(200);

    expect((await uploads.manifest(session)).map((f) => f.path)).toEqual(['docker-compose.yml']);

    const again = await instance.inject({
      method: 'DELETE',
      url: `/api/v1/uploads/${session.token}/pre-install/setup.sh`,
    });
    expect(again.statusCode).toBe(404);
  });
});

describe('how far a token reaches', () => {
  it('refuses every shape of path that would leave the session directory', async () => {
    const { instance, uploads } = await serve();
    const session = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });

    for (const escape of ['../escaped.yml', 'ok/../../escaped.yml', '.hidden', 'a/../../b']) {
      const res = await put(instance, session.token, escape, 'x');
      expect(res.statusCode, `${escape} was not refused`).not.toBe(200);
    }

    // Nothing was created outside the session, whatever the router made of those paths.
    const stray = await fs.readdir(path.join(dir, 'uploads'));
    expect(stray).toEqual([session.id]);
  });

  it('cannot be used to read or write another session', async () => {
    const { instance, uploads } = await serve();
    const mine = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });
    const yours = await uploads.create({ subject: 'FileBrowser', repo: 'Yundera/AppStore' });

    await put(instance, yours.token, 'docker-compose.yml', 'yours');
    await put(instance, mine.token, 'docker-compose.yml', 'mine');

    expect(await uploads.readText(yours, 'docker-compose.yml')).toBe('yours');
    expect(await uploads.readText(mine, 'docker-compose.yml')).toBe('mine');
  });

  it('answers the same 404 for a token that never existed and one that has lapsed', async () => {
    let clock = new Date('2026-08-22T10:00:00Z');
    const { instance, uploads } = await serve(() => clock);
    const session = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });

    expect((await put(instance, session.token, 'a.yml', 'x')).statusCode).toBe(200);

    // Past its ttl_min, the same token is simply not a session any more.
    clock = new Date('2026-08-22T11:30:00Z');
    const lapsed = await put(instance, session.token, 'a.yml', 'x');
    const never = await put(instance, 'not-a-token-at-all', 'a.yml', 'x');
    expect(lapsed.statusCode).toBe(404);
    expect(never.statusCode).toBe(404);
    expect(lapsed.json()).toEqual(never.json());
  });
});

describe('the caps are real', () => {
  it('refuses a file over the per-file limit', async () => {
    const { instance, uploads } = await serve();
    const session = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });

    const res = await put(instance, session.token, 'big.yml', 'x'.repeat(LIMITS.max_file_bytes + 1));
    // Fastify refuses it as a body too large before the handler sees it; either way it is
    // not a 200 and nothing is written.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(await uploads.manifest(session)).toEqual([]);
  });

  it('refuses a file that would put the session over its total, but not a re-upload', async () => {
    const { instance, uploads } = await serve();
    const session = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });

    expect((await put(instance, session.token, 'a.yml', 'a'.repeat(1000))).statusCode).toBe(200);
    expect((await put(instance, session.token, 'b.yml', 'b'.repeat(1000))).statusCode).toBe(200);

    const third = await put(instance, session.token, 'c.yml', 'c'.repeat(1000));
    expect(third.statusCode).toBe(400);
    expect((third.json() as { error: string }).error).toContain('in total');

    // Replacing a file is the whole point of a debug loop: it must not count twice.
    const replaced = await put(instance, session.token, 'a.yml', 'a'.repeat(1000));
    expect(replaced.statusCode).toBe(200);
  });
});

describe('the parser swap stays inside this plugin', () => {
  it('leaves the JSON API registered beside it working', async () => {
    const { instance } = await serve();
    // If `removeAllContentTypeParsers` had escaped its encapsulation context, this would
    // come back as a buffer the route could not read.
    const res = await instance.inject({ method: 'GET', url: '/api/v1/subjects' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('registers nothing at all when there is no upload store', async () => {
    const instance = Fastify();
    await instance.register(routes, { prefix: '/api/v1', store: fixtureStore() });
    await instance.ready();
    app = instance;

    const res = await instance.inject({ method: 'GET', url: '/api/v1/uploads/anything' });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * The store zip a session produces.
 *
 * Serving it is no longer this plugin's job — a trial saves its own copy and serves that, so
 * the bench installs the archive that was audited rather than whatever the session holds by
 * the time it is asked (see `routes/trials.ts`). What is still owned here is the *shape*, and
 * that shape is the whole reason this works without knowing Maison's unzip internals: Maison's
 * own default store is a GitHub archive, which always wraps everything in one `<repo>-<ref>/`
 * directory, so reproducing it is correct whether Maison strips a level or globs for `Apps/`.
 */
describe('the store zip', () => {
  it('wraps the files the way a GitHub archive does', async () => {
    const { instance, uploads } = await serve();
    const session = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });
    await put(instance, session.token, 'docker-compose.yml', 'name: claude\n');
    await put(instance, session.token, 'icon.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const entries = unzipSync(new Uint8Array(await uploads.zipStore(session)));
    const names = Object.keys(entries).sort();

    // Exactly one top-level directory, and the app under `Apps/<Subject>/` inside it.
    const tops = new Set(names.map((n) => n.split('/')[0]));
    expect(tops.size).toBe(1);
    expect(names).toEqual([
      `AppStore-trial-${session.id}/Apps/ClaudeCode/docker-compose.yml`,
      `AppStore-trial-${session.id}/Apps/ClaudeCode/icon.png`,
    ]);

    // The bytes are the bytes, text and binary alike.
    const compose = entries[`AppStore-trial-${session.id}/Apps/ClaudeCode/docker-compose.yml`];
    expect(Buffer.from(compose!).toString('utf8')).toBe('name: claude\n');
    const icon = entries[`AppStore-trial-${session.id}/Apps/ClaudeCode/icon.png`];
    expect([...icon!]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('no longer answers on the uploads plugin, so there is one place a store is served', async () => {
    const { instance, uploads } = await serve();
    const session = await uploads.create({ subject: 'ClaudeCode', repo: 'Yundera/AppStore' });
    await put(instance, session.token, 'docker-compose.yml', 'name: claude\n');

    const res = await instance.inject({
      method: 'GET',
      url: `/api/v1/trialstore/${session.token}.zip`,
    });
    expect(res.statusCode).toBe(404);
  });
});
