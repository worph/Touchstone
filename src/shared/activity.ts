/**
 * The wire shapes for the Activity page: events, alerts, benches, push.
 *
 * They live in `shared/` for the same reason `types.ts` does — the server writes them and
 * the web reads them, and a second copy of a shape is a shape that drifts. The services in
 * `src/server/services/` import these rather than declaring their own, so a field added
 * here is a field the compiler makes both sides account for.
 *
 * `types.ts` is the frozen MVP-0 archive contract and is not touched by any of this.
 */

import type { RecordedPhase, RecordedRequirement, Section } from './types.js';

// ── events ─────────────────────────────────────────────────────────────────────────────

export type EventLevel = 'debug' | 'info' | 'warn' | 'error';

/** How the log groups a row. Derived from `code` by the server, never authored. */
export type EventCategory =
  | 'scheduler'
  /** Changes an operator made — the protocol, and whatever else becomes editable. */
  | 'config'
  | 'assay'
  | 'bench'
  | 'agent'
  /** The administrator chat: what it was asked, and what it could not do. */
  | 'chat'
  | 'importer'
  | 'notify'
  | 'system'
  | 'other';

export interface EventRecord {
  /** Monotonic per process. The page polls with `?since=` and appends what comes back. */
  seq: number;
  at: string;
  level: EventLevel;
  code: string;
  category: EventCategory;
  subject?: string;
  section?: Section;
  /** One human sentence. Never carries an id, an error string or JSON — see events.ts. */
  message: string;
  /** The technical payload. Rendered only on `warn` and `error`. */
  detail?: Record<string, unknown>;
}

export interface EventsResponse {
  events: EventRecord[];
  subjects: string[];
  last_seq: number;
  /** Code → label, so the filter menu does not ship a second copy of the code table. */
  codes: Record<string, string>;
}

// ── alerts ─────────────────────────────────────────────────────────────────────────────

/** Closed set: dedup is by key, so an interpolated key would mean one row per occurrence. */
export type AlertKey = 'bench.auth' | 'bench.unreachable' | 'agent.unavailable' | 'browser.unavailable';

export interface Alert {
  key: AlertKey;
  state: 'open' | 'resolved';
  title: string;
  detail?: string;
  /** What the condition is currently stopping — the Overview banner's second line. */
  impact?: string;
  opened_at: string;
  last_seen_at: string;
  resolved_at?: string;
}

export interface AlertsResponse {
  open: Alert[];
  resolved: Alert[];
}

// ── benches ────────────────────────────────────────────────────────────────────────────

export type BenchStatus = 'healthy' | 'auth' | 'unreachable' | 'unconfigured' | 'unknown';

export interface BenchHealth {
  name: string;
  url: string;
  status: BenchStatus;
  detail?: string;
  latency_ms?: number;
  probed_at?: string;
  healthy_at?: string;
  /**
   * What the management board claims. `null` means the board could not be read, which is
   * deliberately distinct from the board saying nothing — the UI shows the difference.
   */
  board_says?: string | null;
  /**
   * Minutes until the daily cleanup wipes this instance, from the pool API.
   *
   * Three states, all distinct: a number is a countdown, `null` is "the pool API listed it
   * but gave no countdown", and `undefined` is "this bench was hand-configured and has no
   * board to ask". Only the first can satisfy the `> 1h` rule the functional claim gates on.
   */
  remaining_min?: number | null;
  /** Mid-cleanup. Serves a login page and then silently fails to install — never claimable. */
  processing?: boolean;
}

export type PortKind = 'agent' | 'browser';

/** An external endpoint Touchstone needs — the agent, or a browser sidecar. */
export interface PortHealth {
  name: string;
  kind: PortKind;
  url: string;
  status: 'healthy' | 'unreachable' | 'unconfigured' | 'unknown';
  detail?: string;
  /** How many tools the MCP surface offers. Zero is reachable and useless. */
  tools?: number;
  has_expected?: boolean;
  latency_ms?: number;
  probed_at?: string;
  healthy_at?: string;
}

export interface BenchesResponse {
  benches: BenchHealth[];
  pool_up: boolean;
  /**
   * How many benches a functional assay may actually claim — healthy, not mid-cleanup, and
   * with more than an hour of runway. Distinct from `pool_up` on purpose: a pool that is
   * answering but all expiring is up and unusable at the same time.
   */
  leasable: number;
  board_url: string | null;
  /** The agent and the browser sidecars, reported beside the benches — one picture. */
  ports: PortHealth[];
}

// ── push ───────────────────────────────────────────────────────────────────────────────

export interface PushStatus {
  configured: boolean;
  public_key: string | null;
  devices: number;
}

/** One row of the administrator chat. Written by the server, rendered by the page. */
export type ChatRole = 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  id: string;
  thread_id: string;
  role: ChatRole;
  content: string;
  /** Set on `tool` rows: which tool, and what it was called with. */
  tool_name?: string;
  tool_input?: unknown;
  /** Whether the call did what was asked. Absent on user and assistant rows. */
  ok?: boolean;
  at: string;
}

export interface ChatState {
  thread_id: string | null;
  messages: ChatMessage[];
  running: boolean;
  /** False when no agent is answering — the composer says so instead of failing on send. */
  available: boolean;
}

// ── the run in flight ──────────────────────────────────────────────────────────────────

/** One step of a section's phase plan: the id the agent records, and what it means. */
export interface PhasePlanStep {
  id: string;
  label: string;
}

/**
 * Labels for phases recorded before the plan moved into the protocol file.
 *
 * A live run gets its labels from `RunProgress.phase_plan`, which comes from
 * `protocols/<section>.md`. This table is the fallback for reading an assay off disk, where
 * all that was stored is the letter.
 */
export const PHASE_LABEL: Record<string, string> = {
  A: 'session',
  C: 'fresh install',
  D: 'discover URL',
  E8: 'works immediately',
  E9: 'auth gate',
  E10: 'clean boot',
  F: 'zero-config usability',
  G: 'data persistence',
};

/** How a run ended. Mirrors `RunOutcome` in `runner/index.ts`, which imports it from here. */
export type RunOutcome =
  | { kind: 'verdict'; verdict: string; risk: number; files: string[] }
  | { kind: 'error'; reason: string }
  | { kind: 'agent_busy' }
  | { kind: 'blocked'; reason: string };

/**
 * The audit currently in flight.
 *
 * There is no depth any more: a run attempts **every** section of the protocol, and the ones
 * whose prerequisites are missing are recorded as blocked rather than narrowing the job.
 * `sections` is therefore what is actually being audited right now, and `blocked` is what is
 * not and why — the UI needs both, or it draws a phase track for a section nobody is running.
 */
export interface RunLive {
  subject: string;
  started_at: string;
  /** The sections being attempted, in protocol order. Filled in once the run has probed. */
  sections?: Section[];
  /** Sections skipped this run — `bench_unavailable`, `browser_unavailable`. */
  blocked?: { section: Section; reason: string }[];
  /** Why any section was skipped, in one word, for the strip's one-line summary. */
  degraded_reason?: string | null;
  /** The demo instance this run leased, and the browser sidecar leased with it. */
  bench?: string | null;
  browser?: string | null;
}

export interface LastRun {
  subject: string;
  sections?: Section[];
  started_at: string;
  finished_at: string;
  outcome: RunOutcome;
}

/**
 * What the running audit has established so far, from the ledger.
 *
 * Counts *and* the rows behind them. A bar that only moves is a bar that cannot distinguish
 * a run doing careful work from one repeating itself; `phases` and `recent` are what let a
 * six-minute wait say what it is doing rather than only how far along it is.
 */
export interface RunProgress {
  verified: number;
  applicable: number;
  passed: number;
  failed: number;
  unverified: number;
  not_applicable: number;
  risk: number;
  /** How many requirements the sections of this run list between them. The denominator. */
  of_canonical: number;
  /**
   * The phase plan of every section in this run that has one, in order — the track the UI
   * draws before anything has been reported. Empty when no running section has phases.
   */
  phase_plan: PhasePlanStep[];
  /** Phases recorded so far. Empty for a run whose sections have no phase plan. */
  phases: RecordedPhase[];
  /** The last few requirements settled, newest first. */
  recent: RecordedRequirement[];
}

/** `GET /api/v1/assays/current`. */
export interface RunStatus {
  enabled: boolean;
  running: RunLive | null;
  last: LastRun | null;
  /** Null when nothing is running, or when the run predates the ledger. */
  progress: RunProgress | null;
}
