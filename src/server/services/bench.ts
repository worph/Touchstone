/**
 * The bench prober — the thing whose absence is the defect of record.
 *
 * A functional assay needs a live demo instance to install into. On 2026-08-05 the demo
 * pool stopped accepting logins and nothing checked: n8n dispatched anyway, the agent could
 * not get in, and 49 runs were recorded as *the app* erroring. Thirteen apps were parked
 * for a fault none of them had. The rule this module enforces is ARCHITECTURE.md principle
 * 5 — an infrastructure condition is never a verdict about the subject — and the way it
 * enforces it is by asking the bench first.
 *
 * Two things were read off the live system on 2026-08-19 and both corrected this file.
 *
 * **The pool is discovered, not configured.** n8n's `Build prompt` orders the agent to
 * "never hardcode a host — pick a Ready one off the board at runtime", and the board is
 * backed by a JSON API (`/demo/api/demos`) carrying exactly the facts the rule needs:
 * `isProcessing`, `lastCleanupSuccess` and `hoursUntilCleanup`. So a static list in
 * config.yaml was the wrong shape; it survives only as an override for testing.
 *
 * **`POST /api/firstfactor` does not authenticate against these hosts.** It answers 302 to
 * `/nhl-auth/oidc/login`, and the old probe scored a 302 as healthy — a false green in the
 * one module that exists to prevent false greens. The gate is OIDC, so the probe is now the
 * login flow itself: follow it to the end and see whether we land on the app. It needs no
 * password (the demo IdP mints a session without one) but it does need a cookie jar, or it
 * redirects forever.
 *
 * The probe stays a deliberately dependency-free handshake, modelled on Newsdesk's
 * `probeEndpoint`: health has to be able to report on a broken port rather than fail with
 * it, so nothing here goes through the same client the real work would use.
 *
 * It also keeps the pool API's own claim about each instance and reports the two answers
 * separately. The board said `✅ Ready` throughout the outage, and on the day this was
 * written it says the same about an instance whose login returns 500. Showing the
 * disagreement is the point — trusting either source silently is what cost the fortnight
 * (UX.md §2.3).
 */

import path from 'node:path';

import { readJson, writeJsonAtomic } from '../store/state.js';
import type { BenchHealth, BenchStatus } from '../../shared/activity.js';
import type { AlertStore } from './alerts.js';
import type { EventLog } from './events.js';

export type { BenchHealth, BenchStatus };

/** How many redirects the login flow may take before we call it a loop. */
const MAX_HOPS = 12;

/** One bench. No credentials: the OIDC gate does not ask for one — see the header. */
export interface BenchConfig {
  name: string;
  /** Origin, no trailing slash — `https://demostaging1.inojob.com`. */
  url: string;
  /** Skip without deleting: a bench being rebuilt should not read as a bench that is down. */
  enabled?: boolean;
  /** What the pool API claims, when the bench came from discovery rather than config. */
  claim?: PoolClaim;
}

/** The pool API's own account of one instance. Never a gate; always shown. */
export interface PoolClaim {
  processing: boolean;
  /** Hours until the daily cleanup wipes it. The `> 1h` rule reads this. */
  remaining_h: number | null;
  last_cleanup_ok: boolean | null;
}

export interface ProbeResult {
  status: Exclude<BenchStatus, 'unknown'>;
  detail?: string;
  latencyMs: number;
  httpStatus?: number;
}

// ── the pool ────────────────────────────────────────────────────────────────────────────

/**
 * Discover the pool from the demo API — the machine-readable half of the same board the
 * n8n prompt tells the agent to read.
 *
 * `[]` means the API could not be read, which the caller must not confuse with "the pool is
 * empty": one is our blindness, the other is their outage.
 */
export async function readPool(poolUrl: string, timeoutMs = 8000): Promise<BenchConfig[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(poolUrl, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!res.ok) return [];
    const rows: unknown = await res.json();
    if (!Array.isArray(rows)) return [];
    const out: BenchConfig[] = [];
    for (const row of rows as Record<string, unknown>[]) {
      const id = typeof row.id === 'string' ? row.id : undefined;
      const url = typeof row.url === 'string' ? row.url : undefined;
      if (!id || !url) continue;
      const hours = typeof row.hoursUntilCleanup === 'number' ? row.hoursUntilCleanup : null;
      out.push({
        // `demostaging1.inojob.com` is a hostname, not a name a person reads in a log line.
        name: id.split('.')[0] || id,
        url: url.replace(/\/+$/, ''),
        claim: {
          processing: row.isProcessing === true,
          remaining_h: hours,
          last_cleanup_ok: typeof row.lastCleanupSuccess === 'boolean' ? row.lastCleanupSuccess : null,
        },
      });
    }
    return out;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/** The claim rendered as the one line the Activity page shows next to our own verdict. */
export function describeClaim(claim: PoolClaim | undefined): string | null {
  if (!claim) return null;
  const parts: string[] = [];
  parts.push(claim.processing ? '🔄 Processing' : claim.last_cleanup_ok === false ? '❌ Error' : '✅ Ready');
  if (claim.remaining_h !== null) parts.push(`${claim.remaining_h.toFixed(1)}h remaining`);
  return parts.join(' · ');
}

/** Does the board's line for a bench read as "this is fine"? */
export function boardClaimsReady(claim: string | null | undefined): boolean {
  if (!claim) return false;
  return /✅|\bready\b|\bonline\b|\bhealthy\b/i.test(claim) && !/❌|\bdown\b|\berror\b/i.test(claim);
}

// ── the probe ───────────────────────────────────────────────────────────────────────────

/** A cookie jar just large enough for one login flow. Discarded when the probe returns. */
class Jar {
  private readonly byHost = new Map<string, Map<string, string>>();

  absorb(url: URL, res: Response): void {
    const raw =
      typeof (res.headers as { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (res.headers as { getSetCookie: () => string[] }).getSetCookie()
        : [res.headers.get('set-cookie')].filter((v): v is string => typeof v === 'string');
    for (const line of raw) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq <= 0) continue;
      const domain = attrs
        .map((a) => a.trim())
        .find((a) => /^domain=/i.test(a))
        ?.slice(7)
        .replace(/^\./, '')
        .toLowerCase();
      const host = domain || url.hostname.toLowerCase();
      const jar = this.byHost.get(host) ?? new Map<string, string>();
      jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      this.byHost.set(host, jar);
    }
  }

  header(url: URL): string | undefined {
    const host = url.hostname.toLowerCase();
    const pairs: string[] = [];
    for (const [scope, jar] of this.byHost) {
      if (host !== scope && !host.endsWith(`.${scope}`)) continue;
      for (const [k, v] of jar) pairs.push(`${k}=${v}`);
    }
    return pairs.length > 0 ? pairs.join('; ') : undefined;
  }
}

/**
 * Ask one bench whether we can actually get in.
 *
 * The probe is the OIDC login flow, started at the app's own entry point and followed by
 * hand so every hop is inspectable. Landing on a 200 is the only outcome that counts as
 * healthy — and it is the outcome the whole functional leg depends on, which is the reason
 * this is the right thing to spend one request on before claiming a target.
 */
export async function probeBench(bench: BenchConfig, timeoutMs = 8000): Promise<ProbeResult> {
  const origin = bench.url.replace(/\/+$/, '');
  if (!origin) return { status: 'unconfigured', detail: 'no url in config.yaml', latencyMs: 0 };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const jar = new Jar();
  const since = () => Date.now() - started;

  try {
    let url = new URL(`${origin}/nhl-auth/oidc/login?redirect=/`);
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
      const cookie = jar.header(url);
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          accept: 'text/html,application/json',
          ...(cookie ? { cookie } : {}),
        },
      });
      jar.absorb(url, res);

      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url);
        continue;
      }

      // Terminal. Classify by what the gate finally said.
      if (res.status === 200) return { status: 'healthy', latencyMs: since(), httpStatus: 200 };
      if (res.status >= 500) {
        return {
          // The box answers, but its login is broken — demostaging2 on 2026-08-19. That is
          // not a verdict about any app, so it must not become one.
          status: 'unreachable',
          detail: `HTTP ${res.status} from the login gate`,
          latencyMs: since(),
          httpStatus: res.status,
        };
      }
      return {
        status: 'auth',
        detail: `HTTP ${res.status} at the end of the login flow`,
        latencyMs: since(),
        httpStatus: res.status,
      };
    }
    // A flow that never terminates is a gate that never establishes a session.
    return {
      status: 'auth',
      detail: `still redirecting after ${MAX_HOPS} hops — the login never completes`,
      latencyMs: since(),
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      status: 'unreachable',
      detail: aborted ? `timed out after ${timeoutMs}ms` : String(err instanceof Error ? err.message : err),
      latencyMs: since(),
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── the pool prober ─────────────────────────────────────────────────────────────────────

export interface BenchProberOptions {
  /** A hand-written pool. Non-empty disables discovery — an override for testing. */
  benches: BenchConfig[];
  stateDir: string;
  events: EventLog;
  alerts: AlertStore;
  /** The pool API. Empty disables discovery, leaving only `benches`. */
  poolUrl?: string;
  /** Minutes of runway a bench needs before a functional assay may claim it. */
  minRemainingMin?: number;
  probeTimeoutMs?: number;
}

/**
 * The pool. Probes every bench, keeps `state/benches.json`, and drives two alerts.
 *
 * Alerts are pool-level, not per-bench: `bench.auth` says *we cannot log in*, and its detail
 * names the hosts. Two failing benches are one outage and must be one card — a key built by
 * interpolating the bench name would quietly restore one-row-per-thing, which is what alerts
 * exist to end.
 */
export class BenchProber {
  private readonly file: string;
  private readonly opts: BenchProberOptions;
  private health = new Map<string, BenchHealth>();
  private discovered: BenchConfig[] = [];
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
    for (const bench of this.opts.benches.filter((b) => b.enabled !== false)) {
      if (!this.health.has(bench.name)) {
        this.health.set(bench.name, { name: bench.name, url: bench.url, status: 'unknown' });
      }
    }
  }

  list(): BenchHealth[] {
    return [...this.health.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Benches whose login flow completed on the last probe. */
  healthy(): BenchHealth[] {
    return this.list().filter((b) => b.status === 'healthy');
  }

  /**
   * Benches a functional assay may actually claim — row D7's other half.
   *
   * Healthy is not enough. n8n's prompt requires an instance that is not mid-cleanup and has
   * **more than an hour** of runway, "so the daily cleanup cannot wipe the run mid-audit (a
   * full run includes the Phase G uninstall-then-reinstall)". That rule lived only inside the
   * prompt, so it never reached the parity matrix; it belongs here, next to the probe.
   *
   * An unknown remaining time does not qualify while the pool API is the source, because
   * "we could not read the countdown" is not "there is time". A hand-configured bench, which
   * has no countdown to read, is exempt.
   */
  leasable(): BenchHealth[] {
    const min = this.opts.minRemainingMin ?? 60;
    return this.healthy().filter((b) => {
      if (b.processing === true) return false;
      if (b.remaining_min === undefined) return true; // hand-configured, no board to ask
      return b.remaining_min !== null && b.remaining_min > min;
    });
  }

  /** Is the pool answering at all? Distinct from having a bench worth claiming. */
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

  /**
   * The pool for this cycle: the configured list if there is one, otherwise discovery.
   *
   * A discovery that comes back empty keeps the previous pool rather than emptying it. The
   * API being unreadable for one cycle is our blindness, and forgetting every bench we know
   * about would report it as their outage.
   */
  private async pool(): Promise<BenchConfig[]> {
    const configured = this.opts.benches.filter((b) => b.enabled !== false);
    if (configured.length > 0) return configured;
    if (!this.opts.poolUrl) return [];
    const found = await readPool(this.opts.poolUrl, this.opts.probeTimeoutMs);
    if (found.length > 0) this.discovered = found;
    return this.discovered;
  }

  private async run(): Promise<BenchHealth[]> {
    const benches = await this.pool();
    if (benches.length === 0) return this.list();

    const now = new Date().toISOString();
    const results = await Promise.all(
      benches.map(async (bench) => {
        const previous = this.health.get(bench.name);
        const probe = await probeBench(bench, this.opts.probeTimeoutMs);
        const remaining =
          bench.claim === undefined
            ? undefined
            : bench.claim.remaining_h === null
              ? null
              : Math.round(bench.claim.remaining_h * 60);
        const next: BenchHealth = {
          name: bench.name,
          url: bench.url,
          status: probe.status,
          detail: probe.detail,
          latency_ms: probe.latencyMs,
          probed_at: now,
          healthy_at: probe.status === 'healthy' ? now : previous?.healthy_at,
          board_says: bench.claim ? describeClaim(bench.claim) : undefined,
          remaining_min: remaining,
          processing: bench.claim?.processing,
        };
        this.health.set(bench.name, next);
        this.logTransition(previous, next, probe);
        return next;
      }),
    );

    // Discovery owns the roster: an instance the API stopped listing is gone, not silent.
    if (this.opts.benches.length === 0) {
      const live = new Set(benches.map((b) => b.name));
      for (const name of [...this.health.keys()]) if (!live.has(name)) this.health.delete(name);
    }

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
            ? `The ${next.name} bench is answering and we can log in`
            : `The ${next.name} bench is letting us log in again`,
      });
      return;
    }

    if (next.status === 'auth') {
      this.opts.events.log({
        level: 'error',
        code: 'BENCH_AUTH_FAILED',
        message: `We cannot log in to the ${next.name} bench`,
        detail: { bench: next.name, url: next.url, status: probe.httpStatus ?? 0, body: probe.detail },
      });
      this.maybeLogDisagreement(previous, next);
      return;
    }

    if (next.status === 'unreachable') {
      this.opts.events.log({
        level: 'error',
        code: 'BENCH_UNREACHABLE',
        // Found by running it: a bench whose gate answers 500 *did* answer, and saying
        // otherwise sends whoever reads this row looking for a network fault.
        message:
          probe.httpStatus === undefined
            ? `The ${next.name} bench did not answer`
            : `The ${next.name} bench answered but is not usable`,
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
      message: `The management board still lists ${next.name} as ready, but we cannot log in to it`,
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
    const impact = this.leasable().length === 0 ? 'functional queue paused · no try consumed' : undefined;

    if (authFailing.length > 0) {
      this.opts.alerts.open({
        key: 'bench.auth',
        title:
          authFailing.length === 1
            ? `We cannot log in to the ${authFailing[0]!.name} bench`
            : 'We cannot log in to any demo bench',
        detail: authFailing.map((b) => `${b.name} → ${b.detail ?? 'rejected'}`).join(' · '),
        impact,
      });
    } else {
      this.opts.alerts.resolve('bench.auth', 'The demo bench pool is letting us log in again');
    }

    if (unreachable.length > 0) {
      this.opts.alerts.open({
        key: 'bench.unreachable',
        title:
          unreachable.length === 1
            ? `The ${unreachable[0]!.name} bench is not usable`
            : 'No demo bench is usable',
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
