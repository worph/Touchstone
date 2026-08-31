/**
 * The append-only log. This is the authoritative account of what Touchstone did.
 *
 * It is authoritative because everything else is best-effort: Beacon can be down, push can
 * be unconfigured, and an app that can only tell you what went wrong by successfully
 * sending a message goes quiet exactly when you need it (ARCHITECTURE.md principle 7,
 * UX.md §2.3). So the log is local, it is a file, and reading it needs nothing to be up.
 *
 * Two rules hold at every call site, copied from Newsdesk's `server/src/events.ts` because
 * they are the difference between a log people read and a log people scroll past:
 *
 *   `message` is one sentence a human reads — no ids, no interpolated error strings, no
 *   JSON. "The demo bench pool is refusing our credentials", not
 *   "probe demostaging1 failed: 401 {\"error\":\"auth/invalid-credential\"}".
 *
 *   `detail` is the technical payload. The UI renders it only on `warn` and `error`.
 *
 * Splicing the second into the first is the one thing that makes a log unreadable, so the
 * codes that carry a payload declare its shape below and tsc enforces the split.
 */

import path from 'node:path';

import { appendJsonl, readJsonl, trimJsonl } from '../store/state.js';
import type { EventCategory, EventLevel, EventRecord } from '../../shared/activity.js';
import type { Section } from '../../shared/types.js';

export type { EventCategory, EventLevel, EventRecord };

interface CodeSpec {
  category: EventCategory;
  /** Shown in the filter menu and the row legend. */
  label: string;
}

/**
 * Every code the app can write. A code is a stable identifier; the message beside it is
 * free to be rewritten for clarity, and the filter keeps working.
 *
 * Only P2's codes are here. P3 (scheduler) and P4 (runner) add their own rather than
 * borrowing an approximate one — a log where `TICK_COMPLETED` sometimes means a claim is a
 * log whose filters lie.
 */
export const EVENT_CODES = {
  // ── bench ─────────────────────────────────────────────────────────────────
  BENCH_HEALTHY: { category: 'bench', label: 'bench answered' },
  BENCH_AUTH_FAILED: { category: 'bench', label: 'bench rejected our credentials' },
  BENCH_UNREACHABLE: { category: 'bench', label: 'bench did not answer' },
  BENCH_RECOVERED: { category: 'bench', label: 'bench recovered' },
  /**
   * The management board reports `✅ Ready` for a bench our probe cannot log into. That
   * disagreement is the 2026-08-05 failure mode and gets its own code, because "the board
   * was believed" is the specific thing that cost 49 errored runs.
   */
  BENCH_BOARD_DISAGREES: { category: 'bench', label: 'the board disagrees with the probe' },
  BENCH_POOL_DOWN: { category: 'bench', label: 'no usable bench' },

  // ── alerts ────────────────────────────────────────────────────────────────
  ALERT_OPENED: { category: 'system', label: 'alert opened' },
  ALERT_RESOLVED: { category: 'system', label: 'alert resolved' },

  // ── importer ──────────────────────────────────────────────────────────────
  IMPORT_COMPLETED: { category: 'importer', label: 'roll-up re-read' },
  IMPORT_FAILED: { category: 'importer', label: 'roll-up could not be read' },

  // ── notification ──────────────────────────────────────────────────────────
  NOTIFY_UNCONFIGURED: { category: 'notify', label: 'no outlet configured' },
  NOTIFY_FAILED: { category: 'notify', label: 'outlet refused' },
  PUSH_UNCONFIGURED: { category: 'notify', label: 'push not configured' },
  PUSH_NO_DEVICES: { category: 'notify', label: 'no device registered' },
  PUSH_SUBSCRIBED: { category: 'notify', label: 'device registered' },
  PUSH_FAILED: { category: 'notify', label: 'push failed' },
  PUSH_REGISTRATION_DEAD: { category: 'notify', label: 'registration retired' },

  // ── system ────────────────────────────────────────────────────────────────
  // ── the scheduler (P3) ────────────────────────────────────────────────────
  SCHEDULER_ARMED: { category: 'scheduler', label: 'automated mode started' },
  SCHEDULER_DISARMED: { category: 'scheduler', label: 'automated mode stopped' },
  TICK_SELECTED: { category: 'scheduler', label: 'target picked' },
  TICK_IDLE: { category: 'scheduler', label: 'tick idled' },
  TICK_BENCH_GATED: { category: 'scheduler', label: 'tick refused for want of a bench' },
  TICK_BENCH_UNGATED: { category: 'scheduler', label: 'a demo bench is claimable again' },
  TICK_FAILED: { category: 'scheduler', label: 'tick could not run' },
  STANDARD_UNREADABLE: { category: 'scheduler', label: 'standard in force unreadable' },
  CLAIM_OPENED: { category: 'scheduler', label: 'subject claimed' },
  CLAIM_RECLAIMED: { category: 'scheduler', label: 'expired claim released' },
  CLAIM_PARKED: { category: 'scheduler', label: 'subject parked' },
  CLAIM_UNPARKED: { category: 'scheduler', label: 'subject released from parking' },
  // Somebody asked for an app to be looked at again. `scheduler`, not `assay`: nothing was
  // audited, the backlog simply gained a row — and the pair reads as one story on Activity
  // when a flag is set and then thought better of.
  SUBJECT_FLAGGED: { category: 'scheduler', label: 'app flagged for re-audit' },
  SUBJECT_UNFLAGGED: { category: 'scheduler', label: 're-audit flag removed' },
  // The store stopped offering an app we have audited. `scheduler`, because what it changes
  // is what the loop may pick — the archive is untouched and no verdict moved.
  SUBJECT_DELISTED: { category: 'scheduler', label: 'app no longer in the store' },
  // An operator threw a delisted app's reports away. `config`, the category for changes a
  // person made: this is the one place the archive loses something, and the row is the only
  // record that it ever held anything.
  SUBJECT_PURGED: { category: 'config', label: 'archive deleted for an app' },
  REGISTRY_REFRESHED: { category: 'scheduler', label: 'registry changed' },
  REGISTRY_FAILED: { category: 'scheduler', label: 'registry unreadable' },
  REGISTRY_VERSIONS_FAILED: { category: 'scheduler', label: 'app versions unreadable' },
  REGISTRY_RECOVERED: { category: 'scheduler', label: 'registry readable again' },

  // ── trials ────────────────────────────────────────────────────────────────
  // Their own codes, not the ASSAY_* ones. A trial's `subject` is a slug, so an
  // `ASSAY_FAILED` carrying it would push a deep link to `/s/<slug>` that 404s, and would
  // read on Activity as a failing audit of a real app. A failing trial is a fact about a
  // branch somebody is reviewing.
  TRIAL_STARTED: { category: 'assay', label: 'trial started' },
  TRIAL_COMPLETED: { category: 'assay', label: 'trial finished' },
  TRIAL_FAILED: { category: 'assay', label: 'trial failed' },
  TRIAL_SWEPT: { category: 'system', label: 'orphaned trial reports removed' },
  UPLOAD_WRITTEN: { category: 'assay', label: 'trial file uploaded' },

  // ── the archive ───────────────────────────────────────────────────────────
  ARCHIVE_MIGRATED: { category: 'system', label: 'report archive moved' },
  ARCHIVE_MIGRATION_FAILED: { category: 'system', label: 'report archive not moved' },

  // ── the runner (P4) ───────────────────────────────────────────────────────
  ASSAY_STARTED: { category: 'assay', label: 'audit started' },
  ASSAY_COMPLETED: { category: 'assay', label: 'audit finished' },
  ASSAY_FAILED: { category: 'assay', label: 'audit failed' },
  ASSAY_BLOCKED: { category: 'assay', label: 'audit could not start' },
  ASSAY_DEGRADED: { category: 'assay', label: 'a section could not be attempted' },
  /**
   * A section with a script executor produced no reading — the script broke, or it ran and
   * said it could not reach what it reads. Its own code rather than `ASSAY_FAILED`, because
   * neither case is a statement about the app and neither costs the run: the other sections
   * carry on and the subject keeps its place.
   */
  EXECUTOR_FAILED: { category: 'assay', label: 'a scripted check produced no reading' },

  CHAT_TOOL_FAILED: { category: 'chat', label: 'a tool call was refused' },
  ADMIN_MCP_CALL: { category: 'chat', label: 'an operator tool was called over MCP' },
  CHAT_TURN_FAILED: { category: 'chat', label: 'the assistant could not finish' },
  ASSAY_REQUIREMENT_REVISED: { category: 'assay', label: 'requirement re-recorded' },
  ASSAY_REQUIREMENT_UNLISTED: { category: 'assay', label: 'requirement not in the protocol' },
  PROTOCOL_MISSING: { category: 'assay', label: 'no protocol on disk' },
  PROTOCOL_EDITED: { category: 'config', label: 'protocol edited' },
  // A rubric or a script that changed on the volume without going through the app. `info`,
  // not `warn`: editing a protocol over SSH is legitimate, and warning on every one of them
  // is how an operator learns to ignore warns. It is here at all because a standard that
  // changed while nobody was looking is exactly what the history exists to make visible.
  PROTOCOL_REVISED: { category: 'config', label: 'protocol changed on disk' },
  PROTOCOL_HISTORY_FAILED: { category: 'config', label: 'protocol history not recorded' },
  // The knowledge base moves the same way a protocol does and is recorded the same way, but
  // it never judges — so these rows say "reference material", never "the standard changed".
  KB_REVISED: { category: 'config', label: 'knowledge base changed on disk' },
  KB_HISTORY_FAILED: { category: 'config', label: 'knowledge base history not recorded' },
  // The administrator's standing instructions. `config` rather than `chat`: it is a change
  // to how this instance is set up, not something that happened in a conversation.
  CONTEXT_EDITED: { category: 'config', label: 'administrator context edited' },
  // A control — one of the config values that can be changed while the app is running.
  // `config` for the same reason the context edit is: it is a change to how this instance is
  // set up, whoever made it and whichever surface they made it from.
  CONTROL_CHANGED: { category: 'config', label: 'a setting was changed' },
  CONTROL_RESET: { category: 'config', label: 'a setting went back to config.yaml' },
  // At boot: something in `state/controls.json` could not be applied. `warn`, because the
  // instance is now running on a value nobody chose — the file says one thing and the
  // process is doing another, and that is exactly the confusion controls exist to prevent.
  CONTROL_IGNORED: { category: 'config', label: 'a stored setting was not applied' },
  AGENT_BUSY: { category: 'agent', label: 'agent busy' },
  AGENT_UNAUTHENTICATED: { category: 'agent', label: 'agent not logged in' },

  // ── the ports (P5) ────────────────────────────────────────────────────────
  PORT_HEALTHY: { category: 'system', label: 'endpoint answering' },
  PORT_UNREACHABLE: { category: 'system', label: 'endpoint unreachable' },

  SERVER_STARTED: { category: 'system', label: 'Touchstone started' },
  CONFIG_SEEDED: { category: 'system', label: 'configuration written' },
  PROTOCOL_SEEDED: { category: 'system', label: 'rubric written into the data directory' },
  KB_SEEDED: { category: 'system', label: 'knowledge base written into the data directory' },
  LOG_TRIMMED: { category: 'system', label: 'log trimmed' },
} as const satisfies Record<string, CodeSpec>;

export type EventCode = keyof typeof EVENT_CODES;

/**
 * The payload shape per code, for the codes that have one.
 *
 * Declaring it is what stops a `401` or a stack trace from being spliced into `message`:
 * the code that needs to report a status has somewhere to put it, and tsc says so.
 */
interface EventDetails {
  BENCH_AUTH_FAILED: { bench: string; url: string; status: number; body?: string };
  BENCH_UNREACHABLE: { bench: string; url: string; error: string; timedOut?: boolean };
  BENCH_BOARD_DISAGREES: { bench: string; board: string; probe: string };
  BENCH_POOL_DOWN: { benches: string[] };
  ALERT_OPENED: { key: string; detail?: string };
  ALERT_RESOLVED: { key: string; openForMinutes: number };
  IMPORT_FAILED: { error: string };
  IMPORT_COMPLETED: { subjects: number; written: number; unchanged: number };
  NOTIFY_FAILED: { outlet: string; error: string };
  PUSH_FAILED: { endpoint: string; status?: number; error: string };
  PUSH_REGISTRATION_DEAD: { endpoint: string; status?: number };
  LOG_TRIMMED: { kept: number };
  /**
   * `dry_run` is on the tick rather than in the message because it is the difference
   * between a decision and an action, and someone reading the log after the scheduler is
   * armed needs to be able to filter the shadow period out.
   */
  /**
   * Who started or stopped the loop, and what the config file would have said. Arming is the
   * one control in the app that makes it act on its own, so it is worth a row that survives
   * the person who pressed it forgetting they did.
   */
  SCHEDULER_ARMED: { armed: boolean; by: string; config_default: boolean };
  SCHEDULER_DISARMED: { armed: boolean; by: string; config_default: boolean };
  TICK_SELECTED: { subject: string; reason: string; backlog: number; try_n: number; dry_run: boolean };
  TICK_IDLE: { reason: string; backlog: number };
  TICK_BENCH_GATED: { reason: string; backlog: number };
  TICK_BENCH_UNGATED: { reason: string; backlog: number };
  TICK_FAILED: { error: string };
  STANDARD_UNREADABLE: { error: string };
  CLAIM_OPENED: { subject: string; try_n: number; since: string };
  CLAIM_RECLAIMED: { subject: string; try_n: number; outcome: 'retry' | 'parked' };
  CLAIM_PARKED: { subject: string; try_n: number; until_days: number };
  CLAIM_UNPARKED: { subject: string };
  REGISTRY_REFRESHED: { count: number; origin?: string };
  REGISTRY_VERSIONS_FAILED: { error: string; origin?: string };
  REGISTRY_RECOVERED: { count: number; origin?: string };
  REGISTRY_FAILED: { error: string; live: boolean; origin?: string };
  TRIAL_STARTED: { slug: string; source: string; subject: string };
  TRIAL_COMPLETED: {
    slug: string;
    subject: string;
    verdict: string | null;
    risk: number;
    files: number;
  };
  TRIAL_FAILED: { slug: string; subject: string; reason: string };
  TRIAL_SWEPT: { slugs: string[] };
  UPLOAD_WRITTEN: { upload: string; path: string; bytes: number };
  ARCHIVE_MIGRATED: {
    origin: string;
    subjects: number;
    moved: number;
    deduped: number;
    conflicts: string[];
  };
  ARCHIVE_MIGRATION_FAILED: { error: string };
  PROTOCOL_SEEDED: { files: string[]; dir: string };
  KB_SEEDED: { files: string[]; dir: string };
  ASSAY_STARTED: {
    subject: string;
    /** The sections this run is attempting — those whose prerequisites were met. */
    sections: Section[];
    try_n: number;
    bench: string | null;
    browser: string | null;
  };
  ASSAY_COMPLETED: {
    subject: string;
    verdict: string;
    risk: number;
    sections: Section[];
    /** The blocked reason when a section could not run, `null` when all of them ran. */
    blocked: string | null;
  };
  ASSAY_FAILED: { subject: string; error: string; raw: string };
  ASSAY_BLOCKED: { subject: string; reason: string };
  EXECUTOR_FAILED: {
    subject: string;
    section: Section;
    /** The file named by the protocol, or `<none>` when it named one we would not run. */
    executor: string;
    reason: string;
    detail: string;
  };
  /** One section could not be attempted; the rest of the run went ahead without it. */
  ASSAY_DEGRADED: { subject: string; reason: string; section: Section };
  CHAT_TOOL_FAILED: { tool: string; error: string };
  /**
   * `read_only` travels with the row because the answer to "why was that refused?" is usually
   * the switch rather than the request, and the switch is settable per installation.
   */
  ADMIN_MCP_CALL: { tool: string; failed: boolean; read_only: boolean };
  CHAT_TURN_FAILED: { calls: number; error: string };
  ASSAY_REQUIREMENT_REVISED: { subject: string; id: string; from: string; to: string };
  ASSAY_REQUIREMENT_UNLISTED: { subject: string; id: string; section: string | undefined };
  PROTOCOL_MISSING: { dir: string };
  /** `via` is who asked — the editor, the chat, or an agent on the admin MCP. A label on the
   *  row rather than a permission: all three go through `domain/protocoledit.ts`. */
  PROTOCOL_EDITED: {
    id: string;
    sha256: string;
    seq: number;
    bytes: number;
    message: string;
    via: 'api' | 'chat' | 'mcp';
  };
  PROTOCOL_REVISED: { file: string; sha256: string; seq: number };
  PROTOCOL_HISTORY_FAILED: { dir: string };
  KB_REVISED: { file: string; sha256: string; seq: number };
  KB_HISTORY_FAILED: { dir: string };
  // No version: unlike a protocol, the context is not recorded in anything it influenced.
  CONTEXT_EDITED: { bytes: number };
  /**
   * Which control, from what to what, and who.
   *
   * `config_default` rides along for the same reason it does on `SCHEDULER_ARMED`: the row
   * has to be readable after a restart, and "cooldown is 240" means something different when
   * the file says 240 than when it says 60.
   */
  CONTROL_CHANGED: {
    key: string;
    from: number | boolean;
    to: number | boolean;
    by: string;
    config_default: number | boolean;
  };
  CONTROL_RESET: { key: string; from: number | boolean; to: number | boolean; by: string };
  CONTROL_IGNORED: { key: string; value: unknown; reason: string };
  AGENT_BUSY: { subject: string; waitMs: number; attempt: number };
  AGENT_UNAUTHENTICATED: { subject: string; error: string; raw: string };
  SUBJECT_DELISTED: { subjects: string[] };
  SUBJECT_PURGED: { subject: string; files: number; by: string };
  PORT_HEALTHY: { port: string; kind: 'agent' | 'browser'; tools: number };
  PORT_UNREACHABLE: { port: string; kind: 'agent' | 'browser'; url: string; error: string };
}

type DetailPart<C extends EventCode> = C extends keyof EventDetails
  ? { detail: EventDetails[C] }
  : { detail?: Record<string, unknown> };

/** A discriminated union over `code`, so the required detail travels with the code. */
export type EventInput = {
  [C in EventCode]: {
    level: EventLevel;
    code: C;
    /** One sentence. No ids, no error strings, no JSON. */
    message: string;
    subject?: string;
    section?: Section;
  } & DetailPart<C>;
}[EventCode];

export function categoryOf(code: string): EventCategory {
  const known = (EVENT_CODES as Record<string, CodeSpec | undefined>)[code];
  if (known) return known.category;
  // A row written by a build that has since been rolled back still belongs in the log —
  // an event nobody can find is the same as an event nobody wrote.
  if (code.startsWith('BENCH_')) return 'bench';
  if (code.startsWith('PUSH_') || code.startsWith('NOTIFY_')) return 'notify';
  if (code.startsWith('IMPORT_')) return 'importer';
  if (code.startsWith('TICK_') || code.startsWith('CLAIM_')) return 'scheduler';
  if (code.startsWith('PROTOCOL_')) return 'config';
  if (code.startsWith('ASSAY_')) return 'assay';
  if (code.startsWith('AGENT_')) return 'agent';
  return 'other';
}

export interface EventLogOptions {
  /** Rows held in memory and served without touching disk. */
  memory?: number;
  /** Lines allowed in the file before the oldest are dropped. */
  maxLines?: number;
  /** Where a write failure goes. Defaults to `console.error`. */
  onWriteError?: (err: unknown, event: EventRecord) => void;
  /** Called after every successful append — how `notify.ts` hooks in without a bus. */
  onAppend?: (event: EventRecord) => void;
}

export interface EventQuery {
  level?: EventLevel;
  category?: EventCategory;
  subject?: string;
  code?: string;
  /** Only rows strictly newer than this `seq`. Lets the UI poll for the tail. */
  since?: number;
  limit?: number;
}

const LEVEL_RANK: Record<EventLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * The log. One instance per process, created in `src/server/index.ts`.
 *
 * Reads are served from memory; the file is the durable copy and is re-read only at boot.
 * That keeps `GET /events` off the disk entirely, which matters because the Activity page
 * polls it.
 */
export class EventLog {
  private readonly file: string;
  private readonly memory: number;
  private readonly maxLines: number;
  private readonly onWriteError: (err: unknown, event: EventRecord) => void;
  private onAppend?: (event: EventRecord) => void;
  private recent: EventRecord[] = [];
  private seq = 0;
  private lines = 0;
  /** Serialises appends so `O_APPEND` ordering matches `seq` ordering. */
  private tail: Promise<void> = Promise.resolve();

  constructor(stateDir: string, opts: EventLogOptions = {}) {
    this.file = path.join(stateDir, 'events.jsonl');
    this.memory = opts.memory ?? 2000;
    this.maxLines = opts.maxLines ?? 50_000;
    this.onWriteError =
      opts.onWriteError ??
      ((err, event) => console.error('could not write an event to the log', event.code, err));
    this.onAppend = opts.onAppend;
  }

  get path(): string {
    return this.file;
  }

  /**
   * Route appended events somewhere. Set after the alert store has loaded, so restoring a
   * two-day-old outage from disk does not notify about it a second time.
   */
  subscribe(listener: (event: EventRecord) => void): void {
    this.onAppend = listener;
  }

  /** Load the tail of the file so a restart does not look like the app has no past. */
  async load(): Promise<void> {
    const rows = await readJsonl<EventRecord>(this.file, { limit: this.memory });
    this.recent = rows.filter((r) => r && typeof r.at === 'string');
    this.lines = this.recent.length;
    this.seq = this.recent.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0);
  }

  /**
   * Record an event. Never throws, and never awaits the disk.
   *
   * A log write that fails must not take down the operation it was only meant to observe —
   * an unguarded append here turns "we could not write that the bench is down" into "we
   * could not probe the bench".
   */
  log(input: EventInput): EventRecord {
    const event: EventRecord = {
      seq: ++this.seq,
      at: new Date().toISOString(),
      level: input.level,
      code: input.code,
      category: categoryOf(input.code),
      message: input.message,
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.section ? { section: input.section } : {}),
      ...(input.detail ? { detail: input.detail as Record<string, unknown> } : {}),
    };

    this.recent.push(event);
    if (this.recent.length > this.memory) this.recent.splice(0, this.recent.length - this.memory);

    this.tail = this.tail.then(async () => {
      try {
        await appendJsonl(this.file, event);
        if (++this.lines > this.maxLines) {
          this.lines = await trimJsonl(this.file, Math.floor(this.maxLines / 2));
        }
      } catch (err) {
        this.onWriteError(err, event);
      }
    });

    try {
      this.onAppend?.(event);
    } catch (err) {
      this.onWriteError(err, event);
    }
    return event;
  }

  /** Newest first. */
  query(q: EventQuery = {}): EventRecord[] {
    const min = q.level ? LEVEL_RANK[q.level] : 0;
    const subject = q.subject?.toLowerCase();
    const out = this.recent.filter((e) => {
      if (LEVEL_RANK[e.level] < min) return false;
      if (q.category && e.category !== q.category) return false;
      if (q.code && e.code !== q.code) return false;
      if (subject && e.subject?.toLowerCase() !== subject) return false;
      if (q.since !== undefined && e.seq <= q.since) return false;
      return true;
    });
    out.reverse();
    return q.limit === undefined ? out : out.slice(0, q.limit);
  }

  /** The subjects that appear in the loaded window — the log's subject filter menu. */
  subjects(): string[] {
    return [...new Set(this.recent.map((e) => e.subject).filter((s): s is string => !!s))].sort();
  }

  /** Rows at `error` newer than `seq`. The nav badge counts these and open alerts, nothing else. */
  errorsSince(seq: number): number {
    return this.recent.filter((e) => e.level === 'error' && e.seq > seq).length;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** Await every queued append. Tests and shutdown need this; nothing on a request path does. */
  async flush(): Promise<void> {
    await this.tail;
  }
}
