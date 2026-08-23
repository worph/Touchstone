/**
 * The instance's own settings. Two properties are worth a test and the rest is plumbing:
 * a context prompt survives the round trip and is bounded, and the config never leaves the
 * process with a credential in it.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REDACTED, type TouchstoneConfig } from '../store/config.js';
import { ContextStore, MAX_CONTEXT_BYTES } from '../store/context.js';
import routes from './settings.js';

let dir: string;
let app: FastifyInstance;

async function serve(options: Parameters<typeof routes>[1] = {}): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(routes, options);
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-settings-'));
});

afterEach(async () => {
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the context prompt', () => {
  it('reads as empty when nothing has ever been written', async () => {
    app = await serve({ context: new ContextStore(dir) });
    const res = await app.inject({ method: 'GET', url: '/settings/context' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ text: '', bytes: 0, modified_at: null });
  });

  it('survives the round trip', async () => {
    app = await serve({ context: new ContextStore(dir) });
    const put = await app.inject({
      method: 'PUT',
      url: '/settings/context',
      payload: { text: 'This box audits the staging store. Never arm the scheduler.' },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().bytes).toBeGreaterThan(0);

    const got = await app.inject({ method: 'GET', url: '/settings/context' });
    expect(got.json().text).toContain('Never arm the scheduler');
    expect(got.json().modified_at).not.toBeNull();
  });

  /** Clearing it is a legitimate edit, not a malformed one. */
  it('accepts an empty string', async () => {
    const store = new ContextStore(dir);
    await store.write('something');
    app = await serve({ context: store });
    const res = await app.inject({ method: 'PUT', url: '/settings/context', payload: { text: '' } });
    expect(res.statusCode).toBe(200);
    expect((await store.read()).text).toBe('');
  });

  it('refuses one that would crowd out the conversation', async () => {
    app = await serve({ context: new ContextStore(dir) });
    const res = await app.inject({
      method: 'PUT',
      url: '/settings/context',
      payload: { text: 'x'.repeat(MAX_CONTEXT_BYTES + 1) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('limit');
  });

  it('refuses a body with no text at all', async () => {
    app = await serve({ context: new ContextStore(dir) });
    const res = await app.inject({ method: 'PUT', url: '/settings/context', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('says so rather than 404ing when there is nowhere to keep one', async () => {
    app = await serve({});
    expect((await app.inject({ method: 'GET', url: '/settings/context' })).statusCode).toBe(503);
    expect(
      (await app.inject({ method: 'PUT', url: '/settings/context', payload: { text: 'x' } })).statusCode,
    ).toBe(503);
  });
});

describe('the config', () => {
  const config = {
    dataDir: '/data',
    admin_mcp: { enabled: true, token: 'hunter2', read_only: false },
    scheduler: { armed: false, tick_min: 60 },
    origins: [{ id: 'yundera', repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' }],
    notify: { outlets: [{ kind: 'telegram', target: '-100123' }] },
  } as unknown as TouchstoneConfig;

  it('hides a credential and keeps everything else verbatim', async () => {
    app = await serve({ config });
    const body = (await app.inject({ method: 'GET', url: '/config' })).json();
    expect(body.config.admin_mcp.token).toBe(REDACTED);
    expect(body.config.admin_mcp.enabled).toBe(true);
    expect(body.config.origins[0].repo).toBe('Yundera/AppStore');
    expect(body.config.notify.outlets[0].target).toBe('-100123');
    expect(body.path).toBe('/data/config.yaml');
  });

  /** An unset credential and a hidden one are different problems. */
  it('leaves an unset credential visibly unset', async () => {
    app = await serve({ config: { ...config, admin_mcp: { enabled: false, token: '', read_only: true } } as TouchstoneConfig });
    expect((await app.inject({ method: 'GET', url: '/config' })).json().config.admin_mcp.token).toBe('');
  });

  it('answers with nulls rather than failing when it was given no config', async () => {
    app = await serve({});
    const body = (await app.inject({ method: 'GET', url: '/config' })).json();
    expect(body.config).toBeNull();
    expect(body.path).toBeNull();
  });
});
