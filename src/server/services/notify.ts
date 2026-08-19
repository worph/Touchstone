/**
 * Routing: which events leave the building, and by which door.
 *
 * The log gets everything and is authoritative. Beacon and push are *outlets*, and both
 * are best-effort — the app has to stay fully diagnosable from its own screens with every
 * port broken (ARCHITECTURE.md principle 7), which is exactly why nothing in here is
 * allowed to throw at its caller.
 *
 * The table is UX.md § Routing, verbatim:
 *
 *   tick summary              log ✓   beacon ✓   push —
 *   assay finished            log ✓   beacon ✓   push —
 *   assay failed after retry  log ✓   beacon ✓   push ✓
 *   alert opened / resolved   log ✓   beacon ✓   push ✓
 *   everything else           log ✓   beacon —   push —
 *
 * The last row is the one that keeps the others readable. A notifier that forwards
 * everything is a notifier people mute, and then the alert is muted too.
 */

import { callTool, McpError } from './mcp.js';
import type { Alert, AlertTransition } from './alerts.js';
import type { EventLog, EventRecord } from './events.js';
import type { PushService } from './push.js';

/**
 * The tool names were read off the live Beacon aggregator with `server_doc`, not from
 * memory. Both take `text` and an optional destination id; when the id is omitted the
 * bridge uses its own default chat, which is what makes an outlet with no id valid.
 */
const OUTLET_TOOLS = {
  telegram: 'beacon-yunderalabs.telegram-mcp__send_message',
  discord: 'beacon-yunderalabs.discord-mcp__send_message',
} as const;

export type OutletKind = keyof typeof OUTLET_TOOLS;

export interface OutletConfig {
  kind: OutletKind;
  /** Telegram chat id or Discord channel id. Omitted means the bridge's default. */
  target?: string;
  enabled?: boolean;
  /** Human name for the log and the Activity environment block. */
  label?: string;
}

/**
 * Which codes go out, and how far. Anything absent is log-only by the table above.
 *
 * `ALERT_OPENED` and `ALERT_RESOLVED` are deliberately NOT here. An alert transition also
 * writes an event, so routing both would send every alert twice — once bare, once with its
 * impact line. `handleAlert` owns alerts end to end; this table owns everything else.
 */
const ROUTES: Record<string, { beacon: boolean; push: boolean }> = {
  BENCH_POOL_DOWN: { beacon: true, push: false },
  IMPORT_FAILED: { beacon: true, push: false },
  // P3 and P4 add TICK_COMPLETED, ASSAY_FINISHED and ASSAY_GAVE_UP here. They are not
  // listed yet because nothing writes them yet, and a route to a code nobody emits reads
  // as coverage that does not exist.
};

export function routeFor(code: string): { beacon: boolean; push: boolean } {
  return ROUTES[code] ?? { beacon: false, push: false };
}

export interface NotifierOptions {
  outlets: OutletConfig[];
  events: EventLog;
  push?: PushService;
  beaconUrl?: string;
  /** Seconds allowed per outlet call. Short: a hung bridge must not queue behind itself. */
  timeout?: number;
}

/**
 * Sends. One instance, wired to the log's `onAppend` in `src/server/index.ts`.
 *
 * It reads from the same event stream the UI reads, rather than being called at each site
 * that has news. That is what keeps the routing table in one file — and it means anything
 * that reaches the log is routable later without touching the code that wrote it.
 */
export class Notifier {
  private readonly opts: NotifierOptions;
  /** Serialises sends so a burst cannot open twenty sockets to the same bridge. */
  private queue: Promise<void> = Promise.resolve();
  /** "No outlet is configured" is a fact about the install, so it is said once, not per send. */
  private saidUnconfigured = false;

  constructor(opts: NotifierOptions) {
    this.opts = opts;
  }

  private get enabled(): OutletConfig[] {
    return this.opts.outlets.filter((o) => o.enabled !== false && o.kind in OUTLET_TOOLS);
  }

  get configured(): boolean {
    return this.enabled.length > 0;
  }

  /**
   * Called for every appended event. Fire-and-forget by design.
   *
   * Its own failures are logged with `notify` codes, and `notify` events are never routed
   * — otherwise a dead Beacon would notify about failing to notify, forever.
   */
  handleEvent(event: EventRecord): void {
    if (event.category === 'notify') return;
    const route = routeFor(event.code);
    if (!route.beacon && !route.push) return;

    if (route.beacon) this.enqueue(this.formatEvent(event));
    if (route.push && this.opts.push) {
      void this.opts.push.notifyAll({
        title: titleFor(event),
        body: event.message,
        url: event.subject ? `/s/${encodeURIComponent(event.subject)}` : '/activity',
        tag: event.code,
      });
    }
  }

  /**
   * Alerts route on their transition rather than through `handleEvent`, so the outlet
   * message can carry the impact line ("functional queue paused") that makes a two-word
   * alert actionable. The dedup that matters already happened in `AlertStore`: this is
   * only ever called on an actual open or resolve.
   */
  handleAlert(alert: Alert, kind: AlertTransition): void {
    const head = kind === 'opened' ? '⚠️ Touchstone alert' : '✅ Touchstone recovered';
    const lines = [`${head}: ${alert.title}`];
    if (alert.detail) lines.push(alert.detail);
    if (kind === 'opened' && alert.impact) lines.push(alert.impact);
    this.enqueue(lines.join('\n'));

    // Alerts are the one thing worth a phone buzzing in both directions: an outage is
    // useless to learn about late, and so is a recovery you are still working around.
    void this.opts.push?.notifyAll({
      title: kind === 'opened' ? 'Touchstone — something needs you' : 'Touchstone — recovered',
      body: alert.title,
      url: '/activity',
      tag: alert.key,
    });
  }

  /** Send one message to every enabled outlet. Exposed for a `test outlets` action. */
  async send(text: string): Promise<{ sent: number; failed: number }> {
    const outlets = this.enabled;
    if (outlets.length === 0) {
      if (!this.saidUnconfigured) {
        this.saidUnconfigured = true;
        this.opts.events.log({
          level: 'debug',
          code: 'NOTIFY_UNCONFIGURED',
          message: 'Nothing is being sent out because no outlet is configured',
        });
      }
      return { sent: 0, failed: 0 };
    }

    let sent = 0;
    let failed = 0;
    for (const outlet of outlets) {
      try {
        await callTool(
          OUTLET_TOOLS[outlet.kind],
          outlet.kind === 'telegram'
            ? { text, ...(outlet.target ? { chatId: outlet.target } : {}) }
            : { text, ...(outlet.target ? { channelId: outlet.target } : {}) },
          { url: this.opts.beaconUrl, timeout: this.opts.timeout ?? 20 },
        );
        sent++;
      } catch (err) {
        failed++;
        this.opts.events.log({
          level: 'warn',
          code: 'NOTIFY_FAILED',
          message: `The ${outlet.label ?? outlet.kind} outlet did not accept the message`,
          detail: {
            outlet: outlet.label ?? outlet.kind,
            error: err instanceof McpError ? err.message : String(err),
          },
        });
      }
    }
    return { sent, failed };
  }

  private enqueue(text: string): void {
    this.queue = this.queue.then(() => this.send(text).then(() => undefined)).catch(() => undefined);
  }

  private formatEvent(event: EventRecord): string {
    const subject = event.subject ? ` · ${event.subject}${event.leg ? ` (${event.leg})` : ''}` : '';
    return `${levelGlyph(event.level)} Touchstone${subject}: ${event.message}`;
  }
}

function levelGlyph(level: EventRecord['level']): string {
  if (level === 'error') return '⛔';
  if (level === 'warn') return '⚠️';
  return 'ℹ️';
}

function titleFor(event: EventRecord): string {
  if (event.level === 'error') return 'Touchstone — something needs you';
  if (event.level === 'warn') return 'Touchstone — heads up';
  return 'Touchstone';
}
