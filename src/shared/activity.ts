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
  | 'assay'
  | 'bench'
  | 'agent'
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
}

export interface BenchesResponse {
  benches: BenchHealth[];
  pool_up: boolean;
  board_url: string | null;
}

// ── push ───────────────────────────────────────────────────────────────────────────────

export interface PushStatus {
  configured: boolean;
  public_key: string | null;
  devices: number;
}
