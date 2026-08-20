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

import type { Leg, RecordedPhase, RecordedRequirement } from './types.js';

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
  leg?: Leg;
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
  /** What the condition is currently stopping — `functional queue paused`. */
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

/**
 * The eight functional phases, in the order the protocol runs them.
 *
 * `runner/prompt.ts` interpolates this list into the sentence that asks the agent to report
 * each phase, so the ids the UI draws a track for and the ids the agent is told to record
 * are one list. Changing it changes both, which is the point — the phase track is only
 * honest if it names the phases actually asked for.
 */
export const FUNCTIONAL_PHASES = ['A', 'C', 'D', 'E8', 'E9', 'E10', 'F', 'G'] as const;

/** What each phase is, for a reader who has not memorised the protocol's letters. */
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
 * `depth` is what was *asked for* and `ran_depth` is what the agent was actually given: a
 * full run whose bench went missing is dispatched as a static one and its functional half
 * recorded blocked. Reporting only `depth` would have the UI draw a phase track for phases
 * nobody is running.
 */
export interface RunLive {
  subject: string;
  depth: 'static' | 'full';
  started_at: string;
  ran_depth?: 'static' | 'full';
  /** Why `ran_depth` is narrower than `depth` — `bench_unavailable`, `browser_unavailable`. */
  degraded_reason?: string | null;
  /** The demo instance this run leased, and the browser sidecar leased with it. */
  bench?: string | null;
  browser?: string | null;
}

export interface LastRun {
  subject: string;
  depth: 'static' | 'full';
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
  /** How many requirements the protocol listed for this depth. The denominator. */
  of_canonical: number;
  /** Functional phases recorded so far. Empty on a static run — it has none. */
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
