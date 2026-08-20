import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AlertStore, type Alert, type AlertTransition } from './alerts.js';
import { EventLog } from './events.js';

let dir: string;
let events: EventLog;
let transitions: { alert: Alert; kind: AlertTransition }[];
/** Every store a test made, so teardown can settle their writes before deleting the dir. */
let made: AlertStore[];

function store(): AlertStore {
  const s = new AlertStore(dir, {
    events,
    onTransition: (alert, kind) => transitions.push({ alert, kind }),
  });
  made.push(s);
  return s;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-alerts-'));
  events = new EventLog(dir);
  transitions = [];
  made = [];
});

afterEach(async () => {
  // `open` and `resolve` do not await their own writes, by design. Without settling them a
  // write lands while `rm -r` is walking the directory and the teardown fails ENOTEMPTY —
  // roughly one full-suite run in five.
  await Promise.all(made.map((s) => s.flush()));
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * The whole point of the module. On 2026-08-05 a single bench outage produced 49 error
 * rows and 12 parked apps; the requirement is that the same outage produces one card,
 * however many times it is observed.
 */
describe('dedup by key', () => {
  it('is one open alert however many probes see the condition', () => {
    const alerts = store();
    for (let i = 0; i < 40; i++) {
      alerts.open({ key: 'bench.auth', title: 'The demo bench pool is refusing our credentials' });
    }
    expect(alerts.openAlerts()).toHaveLength(1);
    expect(alerts.openCount).toBe(1);
  });

  it('notifies once for forty observations', () => {
    const alerts = store();
    for (let i = 0; i < 40; i++) alerts.open({ key: 'bench.auth', title: 'still down' });
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.kind).toBe('opened');
  });

  it('logs once, not once per probe', async () => {
    const alerts = store();
    for (let i = 0; i < 40; i++) alerts.open({ key: 'bench.auth', title: 'still down' });
    await events.flush();
    expect(events.query({ code: 'ALERT_OPENED' })).toHaveLength(1);
  });

  it('refreshes the detail and last-seen without reopening', async () => {
    const alerts = store();
    const first = alerts.open({ key: 'bench.auth', title: 'down', detail: 'demostaging1' });
    await new Promise((r) => setTimeout(r, 5));
    const second = alerts.open({
      key: 'bench.auth',
      title: 'down',
      detail: 'demostaging1 · demostaging2',
    });
    expect(second.transitioned).toBe(false);
    expect(second.alert.opened_at).toBe(first.alert.opened_at);
    expect(second.alert.detail).toBe('demostaging1 · demostaging2');
    expect(second.alert.last_seen_at >= first.alert.last_seen_at).toBe(true);
  });

  it('keeps two different conditions apart', () => {
    const alerts = store();
    alerts.open({ key: 'bench.auth', title: 'auth' });
    alerts.open({ key: 'bench.unreachable', title: 'unreachable' });
    expect(alerts.openAlerts().map((a) => a.key)).toEqual(['bench.auth', 'bench.unreachable']);
  });
});

describe('resolution', () => {
  it('is silent when nothing was open — a healthy pool must not announce recovery', () => {
    const alerts = store();
    for (let i = 0; i < 10; i++) alerts.resolve('bench.auth');
    expect(transitions).toHaveLength(0);
    expect(alerts.openCount).toBe(0);
  });

  it('resolves once and reports how long it was open', async () => {
    const alerts = store();
    alerts.open({ key: 'bench.auth', title: 'down' });
    alerts.resolve('bench.auth', 'recovered');
    alerts.resolve('bench.auth', 'recovered');
    await events.flush();
    expect(transitions.map((t) => t.kind)).toEqual(['opened', 'resolved']);
    const resolved = events.query({ code: 'ALERT_RESOLVED' });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]?.detail).toMatchObject({ key: 'bench.auth' });
  });

  it('treats a condition that comes back as a new outage', async () => {
    const alerts = store();
    const first = alerts.open({ key: 'bench.auth', title: 'down' });
    alerts.resolve('bench.auth');
    // Millisecond resolution: without a gap the reopen would share a timestamp with the
    // first outage and the assertion below would pass or fail on scheduling luck.
    await new Promise((r) => setTimeout(r, 5));
    const again = alerts.open({ key: 'bench.auth', title: 'down again' });
    expect(again.transitioned).toBe(true);
    expect(again.alert.opened_at).not.toBe(first.alert.opened_at);
    expect(again.alert.resolved_at).toBeUndefined();
  });

  it('keeps the resolved row so the recovery is still answerable', () => {
    const alerts = store();
    alerts.open({ key: 'bench.auth', title: 'down' });
    alerts.resolve('bench.auth');
    expect(alerts.openAlerts()).toHaveLength(0);
    expect(alerts.all().filter((a) => a.state === 'resolved')).toHaveLength(1);
  });
});

describe('across a restart', () => {
  /**
   * A restart during an outage must not read as a new outage: the operator would be
   * notified again, and `open · 2d` would reset to `open · 0m` every deploy.
   */
  it('reloads an open alert without reopening or renotifying', async () => {
    const first = store();
    const opened = first.open({ key: 'bench.auth', title: 'down', detail: 'demostaging1' });
    await new Promise((r) => setTimeout(r, 20));

    transitions = [];
    const second = store();
    await second.load();
    expect(second.isOpen('bench.auth')).toBe(true);
    expect(second.get('bench.auth')?.opened_at).toBe(opened.alert.opened_at);

    second.open({ key: 'bench.auth', title: 'down', detail: 'demostaging1' });
    expect(transitions).toHaveLength(0);
  });

  it('starts empty when state/ has been deleted', async () => {
    const fresh = store();
    await fresh.load();
    expect(fresh.openAlerts()).toEqual([]);
  });
});
