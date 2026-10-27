/**
 * The settings over HTTP. The domain is tested next door; what is worth pinning here is the
 * wire: a refusal is a 400 with a sentence rather than a 500, an instance with no config.yaml
 * to write says so instead of accepting the write, and every answer carries the whole list —
 * the page renders one block and must not have to join two responses to do it.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReportIndex } from '../store/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import { EventLog } from '../services/events.js';
import { Scheduler } from '../scheduler/index.js';
import { ConfigFile } from '../store/configfile.js';
import routes from './controls.js';

let dir: string;
let app: FastifyInstance;
let events: EventLog;

function schedulerOf(): Scheduler {
  return new Scheduler({
    constants: { fresh_days: 7, stuck_days: 7, lease_min: 120, cooldown_min: 55, max_tries: 3 },
    armed: false,
    tickMin: 60,
    stateDir: dir,
    index: {
      sections: () => ['static'],
      latest: () => null,
      latestAny: () => null,
      subjects: () => [],
    } as unknown as ReportIndex,
    registry: { list: () => [], isLive: true } as unknown as SubjectRegistry,
    events,
  });
}

async function serve(options: Parameters<typeof routes>[1] = {}): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(routes, options);
  await instance.ready();
  return instance;
}

function configOf(): ConfigFile {
  return new ConfigFile({ file: path.join(dir, 'config.yaml') });
}

async function wired(): Promise<FastifyInstance> {
  return serve({ config: configOf(), scheduler: schedulerOf(), events });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-controls-routes-'));
  events = new EventLog(dir);
});

afterEach(async () => {
  await app?.close();
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('GET /controls', () => {
  it('answers with the list even when nothing is wired up', async () => {
    app = await serve();
    const res = await app.inject({ method: 'GET', url: '/controls' });
    expect(res.statusCode).toBe(200);
    expect(res.json().file).toBeNull();
  });

  it('names the config.yaml a change is written into', async () => {
    app = await wired();
    const res = await app.inject({ method: 'GET', url: '/controls' });
    expect(res.json().file).toBe(path.join(dir, 'config.yaml'));
    expect(res.json().controls.map((r: { key: string }) => r.key)).toContain('scheduler.fresh_days');
  });
});

describe('PUT /controls/:key', () => {
  it('applies the change, writes it into config.yaml, and answers with the whole list', async () => {
    app = await wired();
    const res = await app.inject({
      method: 'PUT',
      url: '/controls/scheduler.fresh_days',
      payload: { value: 14 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changed).toBe(true);
    const row = res.json().controls.find((r: { key: string }) => r.key === 'scheduler.fresh_days');
    expect(row).toMatchObject({ value: 14 });
    expect(await fs.readFile(path.join(dir, 'config.yaml'), 'utf8')).toContain('fresh_days: 14');
  });

  it('refuses an unusable value with a sentence, not a stack trace', async () => {
    app = await wired();
    const res = await app.inject({
      method: 'PUT',
      url: '/controls/scheduler.fresh_days',
      payload: { value: -1 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('scheduler.fresh_days');
  });

  it('refuses a key it does not have', async () => {
    app = await wired();
    const res = await app.inject({ method: 'PUT', url: '/controls/nonsense', payload: { value: 1 } });
    expect(res.statusCode).toBe(400);
  });

  /** No config file to write is a real state — dev, and the route tests. It must not pretend. */
  it('answers 503 when there is nowhere to keep the change', async () => {
    app = await serve({ scheduler: schedulerOf(), events });
    const res = await app.inject({
      method: 'PUT',
      url: '/controls/scheduler.fresh_days',
      payload: { value: 14 },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe('DELETE /controls/:key', () => {
  it('takes the key out of config.yaml and puts the default back', async () => {
    const scheduler = schedulerOf();
    app = await serve({ config: configOf(), scheduler, events });

    await app.inject({ method: 'PUT', url: '/controls/scheduler.cooldown_min', payload: { value: 240 } });
    expect(scheduler.constants.cooldown_min).toBe(240);

    const res = await app.inject({ method: 'DELETE', url: '/controls/scheduler.cooldown_min' });
    expect(res.statusCode).toBe(200);
    expect(scheduler.constants.cooldown_min).toBe(55);
    const row = res.json().controls.find((r: { key: string }) => r.key === 'scheduler.cooldown_min');
    expect(row).toMatchObject({ value: 55, source: 'config' });
    expect(await fs.readFile(path.join(dir, 'config.yaml'), 'utf8')).not.toContain('cooldown_min');
  });
});
