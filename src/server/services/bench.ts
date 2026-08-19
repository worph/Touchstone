/**
 * The bench prober — the thing whose absence is the defect of record.
 *
 * A functional assay needs a live demo instance to install into. On 2026-08-05 the demo
 * pool started answering 401 and nothing checked: n8n dispatched anyway, the agent could
 * not log in, and 49 runs were recorded as *the app* erroring. Thirteen apps were parked
 * for a fault none of them had. The rule this module enforces is ARCHITECTURE.md principle
 * 5 — an infrastructure condition is never a verdict about the subject — and the way it
 * enforces it is by asking the bench first.
 *
 * The probe is a deliberately dependency-free handshake, modelled on Newsdesk's
 * `probeEndpoint`: health has to be able to report on a broken port rather than fail with
 * it, so nothing here goes through the same client the real work would use.
 *
 * It also reads the management board, and it reports the two answers separately. The board
 * said `✅ Ready` throughout the outage. Showing the disagreement is the point — trusting
 * either source silently is what cost the fortnight (UX.md §2.3).
 */

import path from 'node:path';

import { readJson, writeJsonAtomic } from '../store/state.js';
import type { BenchHealth, BenchStatus } from '../../shared/activity.js';
import type { AlertStore } from './alerts.js';
import type { EventLog } from './events.js';

export type { BenchHealth, BenchStatus };

/** One bench, as configured. Credentials stay in this object and never reach an event. */
export interface BenchConfig {
  name: string;
  /** Origin, no trailing slash — `https://demostaging1.inojob.com`. */
  url: string;
  username?: string;
  password?: string;
  /** Skip without deleting: a bench being rebuilt should not read as a bench that is down. */
  enabled?: boolean;
}

export interface ProbeResult {
  status: Exclude<BenchStatus, 'unknown'>;
  detail?: string;
  latencyMs: number;
  httpStatus?: number;
}

/**
 * Ask one bench whether our credentials still work.
 *
 * `POST /api/firstfactor` is the login endpoint the demo instances expose, and it is the
 * right probe precisely because it is the step that failed: a bench can serve its home
 * page perfectly while refusing every login, which is what "the board says Ready" means.
 */
export async function probeBench(bench: BenchConfig, timeoutMs = 8000): Promise<ProbeResult> {
  if (!bench.username || !bench.password) {
    return { status: 'unconfigured', detail: 'no credentials in config.yaml', latencyMs: 0 };
  }

  const url = `${bench.url.replace(/\/+$/, '')}/api/firstfactor`;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        username: bench.username,
        password: bench.password,
        keepMeLoggedIn: false,
        requestMethod: 'GET',
      }),
      redirect: 'manual',
    });
    const latencyMs = Date.now() - started;

    if (res.status === 401 || res.status === 403) {
      return { status: 'auth', detail: `HTTP ${res.status}`, latencyMs, httpStatus: res.status };
    }
    if (res.status >= 500) {
      return { status: 'unreachable', detail: `HTTP ${res.status}`, latencyMs, httpStatus: res.status };
    }
    if (!res.ok && res.status !== 302) {
      return { status: 'auth', detail: `HTTP ${res.status}`, latencyMs, httpStatus: res.status };
    }

    // A 200 is not automatically a pass. The IdP in front of these instances answers 200
    // with a rejection in the body (`"status":"KO"`, `auth/invalid-credential`), and a
    // prober that reads only the status line would report the 2026-08-05 outage as
    // healthy — the exact mistake the management board makes.
    const body = (await res.text()).slice(0, 2000);
    if (/"status"\s*:\s*"KO"|invalid[-_]?credential|authentication_failed/i.test(body)) {
      return { status: 'auth', detail: `HTTP ${res.status}, rejected in body`, latencyMs, httpStatus: res.status };
    }
    return { status: 'healthy', latencyMs, httpStatus: res.status };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      status: 'unreachable',
      detail: aborted ? `timed out after ${timeoutMs}ms` : String(err instanceof Error ? err.message : err),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the demo management board — the same source the n8n agent prompt picks a host from.
 *
 * Returns a map of bench name to whatever the board says about it, and `{}` if the board
 * could not be read at all. Best-effort by construction: this is a second opinion, never
 * a gate. It is scraped rather than parsed because it is someone else's HTML and any
 * structure assumed here would be a structure to be surprised by.
 */
export async function readBoard(
  boardUrl: string,
  names: string[],
  timeoutMs = 8000,
): Promise<Record<string, string>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(boardUrl, { signal: controller.signal, headers: { accept: 'text/html' } });
    if (!res.ok) return {};
    const text = await res.text();
    const out: Record<string, string> = {};
    for (const name of names) {
      // The row for a host is the line it is named on. Good enough to catch "board says
      // Ready while we cannot log in", which is the only question being asked.
      const line = text
        .split(/\r?\n|<\/tr>|<br\s*\/?>/i)
        .find((l) => l.includes(name));
      if (!line) continue;
      const stripped = line.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (stripped) out[name] = stripped.slice(0, 120);
    }
    return out;
  } catch {
    return {};
  } finally {
    clearTimeout(timer);
  }
}

/** Does the board's line for a bench read as "this is fine"? */
export function boardClaimsReady(claim: string | null | undefined): boolean {
  if (!claim) return false;
  return /✅|\bready\b|\bonline\b|\bhealthy\b/i.test(claim) && !/❌|\bdown\b|\berror\b/i.test(claim);
}

export interface BenchProberOptions {
  benches: BenchConfig[];
  stateDir: string;
  events: EventLog;
  alerts: AlertStore;
  /** Management board URL. Omitted or empty disables the second opinion entirely. */
  boardUrl?: string;
  probeTimeoutMs?: number;
}

/**
 * The pool. Probes every bench, keeps `state/benches.json`, and drives two alerts.
 *
 * Alerts are pool-level, not per-bench: `bench.auth` says *the credentials are being
 * rejected*, and its detail names the hosts. Two failing benches are one outage and must
 * be one card — a key built by interpolating the bench name would quietly restore
 * one-row-per-thing, which is what alerts exist to end.
 */
export class BenchProber {
  private readonly file: string;
  private readonly opts: BenchProberOptions;
  private health = new Map<string, BenchHealth>();
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<BenchHealth[]>;
  /** Whether the pool had a usable bench last cycle, so the loss is logged once. */
  private poolWasUp?: boolean;

  constructor(opts: BenchProberOptions) {
    this.opts = opts;
    this.file = path.join(opts.stateDir, 'benches.json');
  }

  /** Restore the last known state so `last ok` survives a restart. */
  async load(): Promise<void> {
    const rows = await readJson<BenchHealth[]>(this.file, []);
    if (!Array.isArray(rows)) return;
    for (const row of rows) if (row?.name) this.health.set(row.name, row);
    // A configured bench never probed yet is `unknown`, not missing: the environment
    // block should list what we are supposed to have, not only what has answered.
    for (const bench of this.enabled()) {
      if (!this.health.has(bench.name)) {
        this.health.set(bench.name, { name: bench.name, url: bench.url, status: 'unknown' });
      }
    }
  }

  list(): BenchHealth[] {
    return [...this.health.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Benches that answered on the last probe. The functional queue is gated on this. */
  healthy(): BenchHealth[] {
    return this.list().filter((b) => b.status === 'healthy');
  }

  get poolUp(): boolean {
    return this.healthy().length > 0;
  }

  /** Probe every enabled bench, update alerts, return the new health rows. */
  probeAll(): Promise<BenchHealth[]> {
    // Coalesce: the timer and a hand-clicked `probe all` must not double the load on a
    // pool that is already timing out.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.probeAll().catch((err) => console.error('bench probe failed', err));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private enabled(): BenchConfig[] {
    return this.opts.benches.filter((b) => b.enabled !== false);
  }

  private async run(): Promise<BenchHealth[]> {
    const benches = this.enabled();
    if (benches.length === 0) return this.list();

    const board = this.opts.boardUrl
      ? await readBoard(this.opts.boardUrl, benches.map((b) => b.name))
      : {};

    const now = new Date().toISOString();
    const results = await Promise.all(
      benches.map(async (bench) => {
        const previous = this.health.get(bench.name);
        const probe = await probeBench(bench, this.opts.probeTimeoutMs);
        const next: BenchHealth = {
          name: bench.name,
          url: bench.url,
          status: probe.status,
          detail: probe.detail,
          latency_ms: probe.latencyMs,
          probed_at: now,
          healthy_at: probe.status === 'healthy' ? now : previous?.healthy_at,
          board_says: this.opts.boardUrl ? (board[bench.name] ?? null) : undefined,
        };
        this.health.set(bench.name, next);
        this.logTransition(previous, next, probe);
        return next;
      }),
    );

    await this.persist();
    this.reconcileAlerts();

    // The pool losing its last bench is a distinct fact from any one bench failing: it is
    // the moment the functional queue stops, and P3 gates on it.
    const up = this.poolUp;
    if (this.poolWasUp === true && !up) {
      this.opts.events.log({
        level: 'error',
        code: 'BENCH_POOL_DOWN',
        message: 'No demo bench is usable, so functional assays cannot run',
        detail: { benches: benches.map((b) => b.name) },
      });
    }
    this.poolWasUp = up;
    return results;
  }

  /**
   * Log only what changed. A bench that has been down for two days is one alert and one
   * event, not one event every five minutes — the log has to stay readable across exactly
   * the outage it is there to explain.
   */
  private logTransition(previous: BenchHealth | undefined, next: BenchHealth, probe: ProbeResult): void {
    const was = previous?.status;
    if (was === next.status) {
      // Unchanged — except that the board flipping to a claim we disagree with is itself
      // news, and it is the news that matters most on this page.
      this.maybeLogDisagreement(previous, next);
      return;
    }

    if (next.status === 'healthy') {
      this.opts.events.log({
        level: 'info',
        code: was === undefined || was === 'unknown' ? 'BENCH_HEALTHY' : 'BENCH_RECOVERED',
        message:
          was === undefined || was === 'unknown'
            ? `The ${next.name} bench is answering and our login works`
            : `The ${next.name} bench is accepting our login again`,
      });
      return;
    }

    if (next.status === 'auth') {
      this.opts.events.log({
        level: 'error',
        code: 'BENCH_AUTH_FAILED',
        message: `The ${next.name} bench is refusing our credentials`,
        detail: { bench: next.name, url: next.url, status: probe.httpStatus ?? 0, body: probe.detail },
      });
      this.maybeLogDisagreement(previous, next);
      return;
    }

    if (next.status === 'unreachable') {
      this.opts.events.log({
        level: 'error',
        code: 'BENCH_UNREACHABLE',
        message: `The ${next.name} bench did not answer`,
        detail: {
          bench: next.name,
          url: next.url,
          error: probe.detail ?? 'no response',
          timedOut: probe.detail?.startsWith('timed out') === true,
        },
      });
      this.maybeLogDisagreement(previous, next);
    }
    // `unconfigured` is silent here: it is a configuration gap, said once by the seeder,
    // not an outage to alert on every five minutes.
  }

  private maybeLogDisagreement(previous: BenchHealth | undefined, next: BenchHealth): void {
    if (next.status === 'healthy' || next.status === 'unconfigured') return;
    if (!boardClaimsReady(next.board_says)) return;
    // Only when the claim is new, or the health is: otherwise this is the row that would
    // repeat every probe for the length of the outage.
    if (previous?.status === next.status && previous?.board_says === next.board_says) return;
    this.opts.events.log({
      level: 'warn',
      code: 'BENCH_BOARD_DISAGREES',
      message: `The management board still lists ${next.name} as ready, but our probe cannot log in`,
      detail: { bench: next.name, board: next.board_says ?? '', probe: next.status },
    });
  }

  /**
   * One pass over the pool, one decision per alert key.
   *
   * Called after every probe cycle. `open` and `resolve` are both idempotent, so this is
   * a plain statement of what is currently true rather than a diff — which is what keeps
   * the dedup rule in one place instead of at every call site.
   */
  private reconcileAlerts(): void {
    const rows = this.list();
    const authFailing = rows.filter((b) => b.status === 'auth');
    const unreachable = rows.filter((b) => b.status === 'unreachable');
    const impact = this.poolUp ? undefined : 'functional queue paused · no try consumed';

    if (authFailing.length > 0) {
      this.opts.alerts.open({
        key: 'bench.auth',
        title:
          authFailing.length === 1
            ? `The ${authFailing[0]!.name} bench is refusing our credentials`
            : 'The demo bench pool is refusing our credentials',
        detail: authFailing.map((b) => `${b.name} → ${b.detail ?? 'rejected'}`).join(' · '),
        impact,
      });
    } else {
      this.opts.alerts.resolve('bench.auth', 'The demo bench pool is accepting our login again');
    }

    if (unreachable.length > 0) {
      this.opts.alerts.open({
        key: 'bench.unreachable',
        title:
          unreachable.length === 1
            ? `The ${unreachable[0]!.name} bench is not answering`
            : 'No demo bench is answering',
        detail: unreachable.map((b) => `${b.name} → ${b.detail ?? 'no response'}`).join(' · '),
        impact,
      });
    } else {
      this.opts.alerts.resolve('bench.unreachable', 'The demo benches are answering again');
    }
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, this.list());
    } catch (err) {
      console.error('could not write benches.json', err);
    }
  }
}
