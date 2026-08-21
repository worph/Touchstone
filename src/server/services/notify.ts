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
 *   tick summary              log ✓   beacon —   push —
 *   assay finished            log ✓   beacon ✓   push ✓
 *   assay failed / blocked    log ✓   beacon ✓   push ✓
 *   alert opened / resolved   log ✓   beacon ✓   push ✓
 *   everything else           log ✓   beacon —   push —
 *
 * The last row is the one that keeps the others readable. A notifier that forwards
 * everything is a notifier people mute, and then the alert is muted too.
 *
 * **`assay finished` pushes, where UX.md §Routing originally said it should not.** That row
 * was written for a loop grinding through 69 subjects on its own; the case that matters now
 * is an operator who *asked* for a review and walked away, and for them a finished audit is
 * the whole point of the notification. The scheduler audits at most one subject an hour, so
 * the ceiling is ~24 a day even once it is armed. If that turns out to be too many, the fix
 * is to push only operator-initiated runs — which needs a `trigger` on the job, and is a
 * smaller change than muting the thing people asked to be told about.
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
  /**
   * Every way an audit can end, and all four push.
   *
   * The set is exhaustive on purpose. A table that carried only the happy path would make
   * silence ambiguous — an operator who asked for a review and heard nothing could not tell
   * a slow run from a dead one — and the whole reason the runner distinguishes `blocked`
   * from `failed` is so the answer can be "the bench is down", not "your app is broken".
   *
   * These are the codes the runner actually emits (`runner/index.ts`). An earlier version of
   * this table named `ASSAY_FINISHED` and `ASSAY_GAVE_UP`, which nothing has ever written.
   */
  ASSAY_COMPLETED: { beacon: true, push: true },
  ASSAY_FAILED: { beacon: true, push: true },
  ASSAY_BLOCKED: { beacon: false, push: true },
  AGENT_UNAUTHENTICATED: { beacon: true, push: true },

  /**
   * Trials notify nowhere.
   *
   * The case that put `assay finished` on the push list was an operator who *asks* for a
   * review and walks away, because an audit outlasts the page they asked from. A trial is
   * looked at immediately or not at all — it is one step inside reviewing a PR somebody is
   * already sitting in front of. It is still logged, so Activity has the whole story.
   */
  TRIAL_STARTED: { beacon: false, push: false },
  TRIAL_COMPLETED: { beacon: false, push: false },
  TRIAL_FAILED: { beacon: false, push: false },
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
        body: pushBodyFor(event),
        url: event.subject ? `/s/${encodeURIComponent(event.subject)}` : '/activity',
        tag: event.code,
      });
    }
  }

  /**
   * Alerts route on their transition rather than through `handleEvent`, so the outlet
   * message can carry the impact line ("sections that need a bench will be recorded blocked")
   * that makes a two-word
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
    const subject = event.subject ? ` · ${event.subject}${event.section ? ` (${event.section})` : ''}` : '';
    return `${levelGlyph(event.level)} Touchstone${subject}: ${event.message}`;
  }
}

function levelGlyph(level: EventRecord['level']): string {
  if (level === 'error') return '⛔';
  if (level === 'warn') return '⚠️';
  return 'ℹ️';
}

/**
 * What the phone actually says.
 *
 * `event.message` is one id-free sentence by design (MVP §7) — "An audit finished" — which
 * is right for a log where the subject is already a column, and useless on a lock screen.
 * So the body is composed here from `subject` and `detail` rather than by loosening the rule
 * that keeps log lines uniform. Anything without a formatter falls back to the sentence,
 * which is always safe.
 */
export function pushBodyFor(event: EventRecord): string {
  const d = (event.detail ?? {}) as Record<string, unknown>;
  const subject = event.subject ?? (typeof d.subject === 'string' ? d.subject : null);
  const name = subject ?? 'A subject';

  switch (event.code) {
    case 'ASSAY_COMPLETED': {
      const parts = [`${name} — ${String(d.verdict ?? 'no verdict')}`];
      if (typeof d.risk === 'number' && d.risk > 0) parts.push(`risk ${d.risk}`);
      // The functional half being blocked is the difference between "this app is fine" and
      // "half of this was never checked", so it belongs in the two lines someone reads.
      if (d.blocked) parts.push(`a section was blocked (${describeReason(String(d.blocked))})`);
      return parts.join(' · ');
    }
    case 'ASSAY_BLOCKED':
      return `${name} — could not start: ${describeReason(String(d.reason ?? 'unknown'))}`;
    case 'ASSAY_FAILED':
      return `${name} — the audit failed: ${trim(String(d.error ?? 'no reason given'), 120)}`;
    default:
      return event.message;
  }
}

/** Reasons are snake_case codes in the log; nobody reads those on a phone. */
function describeReason(reason: string): string {
  switch (reason) {
    case 'bench_unavailable':
      return 'no usable demo bench';
    case 'browser_unavailable':
      return 'no browser was answering';
    case 'runner_disabled':
      return 'the runner is switched off';
    case 'runner_busy':
      return 'another audit is already running';
    default:
      return reason.replace(/_/g, ' ');
  }
}

function trim(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function titleFor(event: EventRecord): string {
  if (event.level === 'error') return 'Touchstone — something needs you';
  if (event.level === 'warn') return 'Touchstone — heads up';
  return 'Touchstone';
}
