/**
 * Alerts: deduplicated environment conditions. One outage is one row.
 *
 * This is the piece that answers the defect of record. On 2026-08-05 the demo pool began
 * returning 401 and n8n turned that into 49 errored runs and 12 parked apps — one row per
 * attempt, none of them saying "the bench is down". An alert is *stateful*: it opens once,
 * refreshes while the condition persists, and resolves when the probe succeeds. A two-day
 * outage is one card (UX.md §2.3).
 *
 * There is no ack and no mute. Both were dropped with the incident engine (§1.4 G), and
 * both would let the one card this app exists to show be dismissed.
 */

import path from 'node:path';

import { readJson, writeJsonAtomic } from '../store/state.js';
import type { Alert, AlertKey } from '../../shared/activity.js';
import type { EventLog } from './events.js';

export type { Alert, AlertKey };

/**
 * The closed set from ARCHITECTURE.md § What it tells you. Keys are closed on purpose:
 * dedup is by key, so a key built by interpolation (`bench.auth.demostaging1`) would
 * silently reintroduce one-row-per-thing.
 */
export const ALERT_KEYS: AlertKey[] = [
  'bench.auth',
  'bench.unreachable',
  'agent.auth',
  'agent.unavailable',
  'browser.unavailable',
];

export interface AlertInput {
  key: AlertKey;
  title: string;
  detail?: string;
  impact?: string;
}

export type AlertTransition = 'opened' | 'resolved';

export interface AlertStoreOptions {
  events?: EventLog;
  /** Called only on a transition — never on a refresh. This is what routing hangs off. */
  onTransition?: (alert: Alert, kind: AlertTransition) => void;
}

/**
 * The alert set. Small, mutable, atomically rewritten — `state/alerts.json`.
 *
 * Held in memory and written through on every change. The file matters only so a restart
 * during an outage does not report the outage as new, which would push a second time.
 */
export class AlertStore {
  private readonly file: string;
  private readonly events?: EventLog;
  private readonly onTransition?: (alert: Alert, kind: AlertTransition) => void;
  private byKey = new Map<AlertKey, Alert>();

  constructor(stateDir: string, opts: AlertStoreOptions = {}) {
    this.file = path.join(stateDir, 'alerts.json');
    this.events = opts.events;
    this.onTransition = opts.onTransition;
  }

  async load(): Promise<void> {
    const rows = await readJson<Alert[]>(this.file, []);
    if (!Array.isArray(rows)) return;
    for (const row of rows) {
      if (row && ALERT_KEYS.includes(row.key)) this.byKey.set(row.key, row);
    }
  }

  /**
   * Assert that a condition is currently true.
   *
   * Idempotent by design: call it on every probe. A condition already open is refreshed —
   * `last_seen_at` moves, the detail is updated so the card shows the current hosts — and
   * *nothing is logged or notified*. That is the whole dedup rule, in one branch.
   */
  open(input: AlertInput): { alert: Alert; transitioned: boolean } {
    const now = new Date().toISOString();
    const existing = this.byKey.get(input.key);

    if (existing && existing.state === 'open') {
      const alert: Alert = {
        ...existing,
        title: input.title,
        detail: input.detail,
        impact: input.impact,
        last_seen_at: now,
      };
      this.byKey.set(input.key, alert);
      void this.track();
      return { alert, transitioned: false };
    }

    // Either new, or previously resolved and now back. Both are an opening: a condition
    // that recovered and failed again is a new outage, and `opened_at` should say so.
    const alert: Alert = {
      key: input.key,
      state: 'open',
      title: input.title,
      detail: input.detail,
      impact: input.impact,
      opened_at: now,
      last_seen_at: now,
    };
    this.byKey.set(input.key, alert);
    void this.track();

    this.events?.log({
      level: 'error',
      code: 'ALERT_OPENED',
      message: input.title,
      detail: { key: input.key, detail: input.detail },
    });
    this.fire(alert, 'opened');
    return { alert, transitioned: true };
  }

  /**
   * Assert that a condition is currently false.
   *
   * Also idempotent, and also silent unless something changes — a healthy bench probed
   * every five minutes must not produce a recovery notice every five minutes.
   */
  resolve(key: AlertKey, title?: string): { alert: Alert | null; transitioned: boolean } {
    const existing = this.byKey.get(key);
    if (!existing || existing.state === 'resolved') return { alert: existing ?? null, transitioned: false };

    const now = new Date().toISOString();
    const alert: Alert = {
      ...existing,
      state: 'resolved',
      title: title ?? existing.title,
      last_seen_at: now,
      resolved_at: now,
    };
    this.byKey.set(key, alert);
    void this.track();

    const openForMinutes = Math.max(
      0,
      Math.round((Date.parse(now) - Date.parse(existing.opened_at)) / 60_000),
    );
    this.events?.log({
      level: 'info',
      code: 'ALERT_RESOLVED',
      message: title ?? `${existing.title} — recovered`,
      detail: { key, openForMinutes },
    });
    this.fire(alert, 'resolved');
    return { alert, transitioned: true };
  }

  /** Open alerts, oldest first — the card stack on Activity reads top-down by age. */
  openAlerts(): Alert[] {
    return [...this.byKey.values()]
      .filter((a) => a.state === 'open')
      .sort((a, b) => a.opened_at.localeCompare(b.opened_at));
  }

  /** Every alert we hold, including resolved ones — the resolved row is the recovery record. */
  all(): Alert[] {
    return [...this.byKey.values()].sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  }

  get(key: AlertKey): Alert | null {
    return this.byKey.get(key) ?? null;
  }

  isOpen(key: AlertKey): boolean {
    return this.byKey.get(key)?.state === 'open';
  }

  get openCount(): number {
    return this.openAlerts().length;
  }

  private fire(alert: Alert, kind: AlertTransition): void {
    // Routing is best-effort by principle 7: a Beacon that refuses must not turn an alert
    // into an exception thrown at the prober that raised it.
    try {
      this.onTransition?.(alert, kind);
    } catch (err) {
      console.error('alert routing failed', alert.key, err);
    }
  }

  /**
   * Await whatever write is in flight.
   *
   * `open` and `resolve` deliberately do not await their own persistence — an alert must be
   * raised the moment it is true, not one disk write later, and a slow filesystem must not
   * hold up the probe that noticed. That leaves a write that can land after its caller has
   * moved on, which is fine in a running process and is not fine for a test that is about to
   * delete the directory underneath it. This is how a caller says "and now settle".
   */
  async flush(): Promise<void> {
    await this.inFlight;
  }

  private inFlight?: Promise<void>;

  /** Start a write and remember it, so `flush` has something to await. */
  private track(): void {
    const previous = this.inFlight ?? Promise.resolve();
    this.inFlight = previous.then(() => this.persist()).catch(() => {});
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, this.all());
    } catch (err) {
      console.error('could not write alerts.json', err);
    }
  }
}
