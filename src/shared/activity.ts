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

import type { Leg } from './types.js';

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
