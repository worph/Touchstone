/**
 * Web push. VAPID keys are generated on first boot and kept in `state/push.json`.
 *
 * The narrow case for it: an assay that failed after its last retry, and an alert opening
 * or resolving. Those are the rows worth a phone buzzing (UX.md § Routing) — a push for
 * every completed assay is a push people turn off, and then the one that mattered is off
 * too. iOS is explicitly out of scope (ARCHITECTURE.md §4).
 *
 * Best-effort throughout, per principle 7: an undelivered push is a row in the log, never
 * an exception thrown at whatever was being reported.
 */

import path from 'node:path';
import webpush, { type PushSubscription, type WebPushError } from 'web-push';

import { readJson, writeJsonAtomic } from '../store/state.js';
import type { EventLog } from './events.js';

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  /** `mailto:` or an origin. Push services require a contact on the JWT. */
  subject: string;
}

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  created_at: string;
  /** Free text from the browser, so a stale registration can be recognised in the UI. */
  label?: string;
}

interface PushFile {
  vapid?: VapidKeys;
  subscriptions?: StoredSubscription[];
}

export interface PushNotification {
  title: string;
  body: string;
  /** Where clicking it lands. Relative, resolved against the app origin by the worker. */
  url?: string;
  tag?: string;
}

export interface PushServiceOptions {
  stateDir: string;
  events: EventLog;
  /** Contact for the VAPID JWT. Configurable because push services reject bad ones. */
  subject?: string;
}

export class PushService {
  private readonly file: string;
  private readonly events: EventLog;
  private readonly subject: string;
  private vapid?: VapidKeys;
  private subs: StoredSubscription[] = [];
  /** "Nobody has registered a device" is a fact about the install, said once, not per send. */
  private saidNoDevices = false;

  constructor(opts: PushServiceOptions) {
    this.file = path.join(opts.stateDir, 'push.json');
    this.events = opts.events;
    this.subject = opts.subject ?? 'mailto:touchstone@yundera.local';
  }

  /**
   * Load the keypair and registrations, generating the keypair if this is a first boot.
   *
   * Generating rather than requiring configuration is deliberate: a VAPID keypair is not a
   * secret shared with anyone, it is an identity this instance mints for itself, and
   * making the operator produce one would leave push unconfigured on every install.
   */
  async load(): Promise<void> {
    const stored = await readJson<PushFile>(this.file, {});
    this.subs = Array.isArray(stored.subscriptions) ? stored.subscriptions : [];

    if (stored.vapid?.publicKey && stored.vapid.privateKey) {
      this.vapid = stored.vapid;
    } else {
      const generated = webpush.generateVAPIDKeys();
      this.vapid = { ...generated, subject: this.subject };
      await this.persist();
    }
    webpush.setVapidDetails(this.vapid.subject, this.vapid.publicKey, this.vapid.privateKey);
  }

  /** The browser needs this to subscribe. Public by definition — safe to serve unauthenticated. */
  get publicKey(): string | null {
    return this.vapid?.publicKey ?? null;
  }

  get deviceCount(): number {
    return this.subs.length;
  }

  get configured(): boolean {
    return !!this.vapid;
  }

  /** Idempotent on `endpoint`: re-subscribing the same browser must not double its pushes. */
  async subscribe(sub: PushSubscription & { label?: string }): Promise<void> {
    const endpoint = sub.endpoint;
    const keys = sub.keys as { p256dh: string; auth: string };
    const existing = this.subs.findIndex((s) => s.endpoint === endpoint);
    const row: StoredSubscription = {
      endpoint,
      keys,
      created_at: existing >= 0 ? this.subs[existing]!.created_at : new Date().toISOString(),
      label: sub.label,
    };
    if (existing >= 0) this.subs[existing] = row;
    else this.subs.push(row);
    this.saidNoDevices = false;
    await this.persist();
    if (existing < 0) {
      this.events.log({
        level: 'info',
        code: 'PUSH_SUBSCRIBED',
        message: 'A device registered for push notifications',
      });
    }
  }

  async unsubscribe(endpoint: string): Promise<void> {
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    await this.persist();
  }

  /**
   * Send to every registered device. Never throws.
   *
   * Two failures are told apart because they need different actions: a 404/410 means the
   * browser retired that registration and we should forget it, and anything else means the
   * send failed and the registration is still good.
   */
  async notifyAll(notification: PushNotification): Promise<{ sent: number; failed: number }> {
    if (!this.vapid) {
      this.events.log({
        level: 'warn',
        code: 'PUSH_UNCONFIGURED',
        message: 'Nothing was pushed because push is not configured on this instance',
      });
      return { sent: 0, failed: 0 };
    }
    if (this.subs.length === 0) {
      if (!this.saidNoDevices) {
        this.saidNoDevices = true;
        this.events.log({
          level: 'debug',
          code: 'PUSH_NO_DEVICES',
          message: 'Nothing is being pushed because no device is registered',
        });
      }
      return { sent: 0, failed: 0 };
    }

    const payload = JSON.stringify(notification);
    const dead: string[] = [];
    let sent = 0;
    let failed = 0;

    await Promise.all(
      this.subs.map(async (sub) => {
        try {
          await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload);
          sent++;
        } catch (err) {
          const status = (err as WebPushError).statusCode;
          if (status === 404 || status === 410) {
            dead.push(sub.endpoint);
            this.events.log({
              level: 'info',
              code: 'PUSH_REGISTRATION_DEAD',
              message: 'A device is no longer registered and was forgotten',
              detail: { endpoint: sub.endpoint, status },
            });
            return;
          }
          failed++;
          this.events.log({
            level: 'warn',
            code: 'PUSH_FAILED',
            message: 'A device could not be reached with a notification',
            detail: {
              endpoint: sub.endpoint,
              status,
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }),
    );

    if (dead.length > 0) {
      this.subs = this.subs.filter((s) => !dead.includes(s.endpoint));
      await this.persist();
    }
    return { sent, failed };
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, { vapid: this.vapid, subscriptions: this.subs } satisfies PushFile);
    } catch (err) {
      console.error('could not write push.json', err);
    }
  }
}
