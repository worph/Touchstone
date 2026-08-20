/**
 * The automated-mode endpoints. Two things worth a test: that the page can tell "stopped"
 * from "no scheduler at all", and that the switch is a switch rather than a suggestion.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ScheduleResponse } from '../../shared/schedule.js';
import type { ReportIndex } from '../store/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import { EventLog } from '../services/events.js';
import { Scheduler } from '../scheduler/index.js';
import routes from './schedule.js';

let dir: string;
let events: EventLog;
let app: FastifyInstance;

const index = {
  sections: () => ['static'],
  latest: () => null,
  subjects: () => [],
} as unknown as ReportIndex;

const registry = { list: () => ['Alpha', 'Beta'], isLive: true } as unknown as SubjectRegistry;

async function serve(scheduler?: Scheduler): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(routes, { scheduler, registry });
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-schedroute-'));
  events = new EventLog(dir);
});

afterEach(async () => {
  await app?.close();
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

function make(armed = false): Scheduler {
  return new Scheduler({
    constants: { fresh_days: 7, stuck_days: 7, lease_min: 120, cooldown_min: 55, max_tries: 3 },
    armed,
    stateDir: dir,
    index,
    registry,
    events,
  });
}

describe('GET /schedule', () => {
  it('answers `armed: null` when there is no scheduler, not `false`', async () => {
    app = await serve();
    const body = (await app.inject({ method: 'GET', url: '/schedule' })).json() as ScheduleResponse;
    // "Stopped" is a state with a Start button; "not wired up" is not, and a page that
    // flattens the two offers a button that does nothing.
    expect(body.armed).toBeNull();
    expect(body.queue).toEqual([]);
  });

  it('serves the queue and the cadence the page renders', async () => {
    const s = make();
    await s.load();
    app = await serve(s);

    const body = (await app.inject({ method: 'GET', url: '/schedule' })).json() as ScheduleResponse;
    expect(body.armed).toBe(false);
    expect(body.constants.cooldown_min).toBe(55);
    expect(body.queue.map((r) => r.subject)).toEqual(['Alpha', 'Beta']);
    expect(body.queue[0]?.position).toBe(1);
  });

  it('reports the runner as a separate switch rather than folding it into `armed`', async () => {
    const s = make();
    await s.load();
    const instance = Fastify();
    await instance.register(routes, { scheduler: s, registry, runner: { enabled: false } as never });
    await instance.ready();
    app = instance;

    const body = (await app.inject({ method: 'GET', url: '/schedule' })).json() as ScheduleResponse;
    expect(body.armed).toBe(false);
    expect(body.runner_enabled).toBe(false);
  });
});

describe('POST /schedule/arm', () => {
  it('starts the loop and answers with the state that resulted', async () => {
    const s = make();
    await s.load();
    app = await serve(s);

    const res = await app.inject({ method: 'POST', url: '/schedule/arm', payload: { armed: true } });
    const body = res.json() as ScheduleResponse;
    expect(res.statusCode).toBe(200);
    expect(body.armed).toBe(true);
    expect(body.armed_source).toBe('override');
    // It decided on the way out, so the page has something to show immediately rather than
    // an hour of silence.
    expect(body.last_tick).not.toBeNull();
    expect(s.armed).toBe(true);
  });

  it('stops it again', async () => {
    const s = make(true);
    await s.load();
    app = await serve(s);
    const body = (
      await app.inject({ method: 'POST', url: '/schedule/arm', payload: { armed: false } })
    ).json() as ScheduleResponse;
    expect(body.armed).toBe(false);
    expect(s.armed).toBe(false);
  });

  it('refuses a body that is not a boolean rather than guessing', async () => {
    const s = make();
    await s.load();
    app = await serve(s);
    const res = await app.inject({ method: 'POST', url: '/schedule/arm', payload: { armed: 'yes' } });
    expect(res.statusCode).toBe(400);
    expect(s.armed).toBe(false);
  });

  it('answers 503 when there is no scheduler to arm', async () => {
    app = await serve();
    const res = await app.inject({ method: 'POST', url: '/schedule/arm', payload: { armed: true } });
    expect(res.statusCode).toBe(503);
  });
});
