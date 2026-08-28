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
  latestAny: () => null,
  subjects: () => [],
} as unknown as ReportIndex;

const registry = {
  list: () => ['yundera~Alpha', 'yundera~Beta'],
  isLive: true,
  status: () => [
    { id: 'yundera', repo: 'Yundera/AppStore', ref: 'main', count: 2, live: true },
  ],
} as unknown as SubjectRegistry;

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
    // Keys, not bare names — the queue addresses subjects, and the page renders the app half.
    expect(body.queue.map((r) => r.subject)).toEqual(['yundera~Alpha', 'yundera~Beta']);
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

describe('what the page renders', () => {
  it('shows the app name in the last-decision line, not the subject key', async () => {
    // `stateLine()` embeds the subject, and the subject is `<origin>~<name>`. The Automation
    // page puts that line in front of a person, so the key has to be split before it ships.
    // Caught by screenshotting the page for the store listing, which is a reminder that a
    // display leak type-checks perfectly.
    const s = make();
    await s.load();
    await s.tick();

    app = await serve(s);
    const body = (await app.inject({ method: 'GET', url: '/schedule' })).json() as ScheduleResponse;

    expect(body.last_tick?.state).toBeTruthy();
    expect(body.last_tick?.state).not.toContain('~');
    expect(body.last_tick?.state).toContain('Alpha');
  });
});


/**
 * `POST /schedule/flag` — the one manual way into the backlog that is not a dispatch.
 *
 * The two things worth pinning: a name typed by a person is resolved against the registry
 * rather than written as given, and the answer carries the queue the flag produced, so the
 * page never has to guess whether the flag actually earned a position.
 */
describe('POST /schedule/flag', () => {
  it('flags an app by its bare name and answers with the queue it produced', async () => {
    const scheduler = make();
    await scheduler.load();
    app = await serve(scheduler);

    const res = await app.inject({
      method: 'POST',
      url: '/schedule/flag',
      payload: { subject: 'Alpha', flagged: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ScheduleResponse & { subject: string; changed: boolean };
    // Resolved to the key, not stored as typed — otherwise the row belongs to nobody.
    expect(body.subject).toBe('yundera~Alpha');
    expect(body.changed).toBe(true);
    expect(body.queue.find((r) => r.subject === 'yundera~Alpha')?.flagged).toBe(true);
    expect(scheduler.isFlagged('yundera~Alpha')).toBe(true);
  });

  it('takes the flag off again, and says when nothing moved', async () => {
    const scheduler = make();
    await scheduler.load();
    app = await serve(scheduler);
    const off = async () =>
      (
        await app.inject({
          method: 'POST',
          url: '/schedule/flag',
          payload: { subject: 'yundera~Alpha', flagged: false },
        })
      ).json() as { changed: boolean };

    expect((await off()).changed).toBe(false);
    await app.inject({
      method: 'POST',
      url: '/schedule/flag',
      payload: { subject: 'yundera~Alpha', flagged: true },
    });
    expect((await off()).changed).toBe(true);
    expect(scheduler.isFlagged('yundera~Alpha')).toBe(false);
  });

  it('refuses an app the store does not list, rather than writing a row nothing reads', async () => {
    const scheduler = make();
    await scheduler.load();
    app = await serve(scheduler);

    const res = await app.inject({
      method: 'POST',
      url: '/schedule/flag',
      payload: { subject: 'Nonesuch', flagged: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('refuses a request that does not say which way', async () => {
    const scheduler = make();
    await scheduler.load();
    app = await serve(scheduler);
    const res = await app.inject({
      method: 'POST',
      url: '/schedule/flag',
      payload: { subject: 'Alpha' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('says there is no scheduler rather than pretending it flagged something', async () => {
    app = await serve();
    const res = await app.inject({
      method: 'POST',
      url: '/schedule/flag',
      payload: { subject: 'Alpha', flagged: true },
    });
    expect(res.statusCode).toBe(503);
  });
});
