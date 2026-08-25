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
  /** The bench's UI build, when the login flow reached a page we could read one from. */
  build?: string;
}

/** At most this much of the landing page is read to find the build. It is a 400-byte shell. */
const BUILD_SNIFF_BYTES = 64 * 1024;

/**
 * The bench's platform build, as a fingerprint rather than a version.
 *
 * **Why a fingerprint.** Maison ships from `go build -trimpath -ldflags="-s -w"` with no
 * version variable and exposes no `/version`; every one of its API routes is behind the OIDC
 * gate. There is no number to ask for. What it does serve is a Vite bundle whose filename is a
 * content hash — `/assets/index-C_5OE2_1.js` — which changes exactly when the UI is rebuilt
 * and is stable across restarts. That is not a semantic version and this must never be
 * rendered as one, but it answers the question the archive could not: *did the platform under
 * these two runs differ?*
 *
 * **Why it is here at all.** On 2026-08-22 AnnasTorrents went from compliant to Critical on
 * bytes that had not changed, and SegmentPlayer newly failed `cpu-shares` the same way. With
 * only `bench_host` on the record there was nothing to separate an app regression from
 * environment drift, and the drift was attributed to the apps. A `blocked` assay is already
 * "infra, not the subject" (invariant 4); this is the same idea for a *silent* environment
 * change, which produces a verdict rather than a block and so is far more dangerous.
 *
 * It is deliberately best-effort: a bench that answers 200 without a recognisable bundle
 * yields `undefined`, and nothing anywhere gates on it. A fingerprint we could not take is
 * not a bench fault, and a probe that failed to read one must still report the bench healthy.
 */
export function buildFrom(html: string): string | undefined {
  const match = /<script[^>]+src=["'](\/assets\/[^"']+\.js)["']/i.exec(html);
  const asset = match?.[1] ?? /["'](\/assets\/index-[^"']+\.js)["']/i.exec(html)?.[1];
  if (!asset) return undefined;
  // The hash alone, not the path: `index-C_5OE2_1` reads as an identity in a frontmatter
  // field, where `/assets/index-C_5OE2_1.js` reads as a URL somebody might try to fetch.
  return asset.replace(/^\/assets\//, '').replace(/\.js$/, '');
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

// ── when, not just what ─────────────────────────────────────────────────────────────────

/**
 * Whether a functional assay may claim this bench — the rule, as a predicate.
 *
 * Extracted from `BenchProber.leasable()` so `describeWindow` below cannot drift from the
 * gate it is describing. A sentence that said "usable" about a bench the runner then refused
 * would be worse than no sentence at all.
 */
export function isLeasable(bench: BenchHealth, minRemainingMin: number): boolean {
  if (bench.status !== 'healthy') return false;
  if (bench.processing === true) return false;
  if (bench.remaining_min === undefined) return true; // hand-configured, no board to ask
  return bench.remaining_min !== null && bench.remaining_min > minRemainingMin;
}

/** `13:42 UTC`, from a moment. The log and the pool API are both UTC; so is this. */
function clockOf(at: Date): string {
  return `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/** When a bench was last seen healthy, as something a person can act on. */
function lastSeen(iso: string | undefined, now: Date): string {
  if (!iso) return 'never';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'never';
  return at.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)
    ? `not since ${clockOf(at)}`
    : `not since ${at.toISOString().slice(0, 10)}`;
}

/**
 * The pool in one sentence — and, crucially, **when the answer changes**.
 *
 * On 2026-08-23 an operator started an audit into a dead pool, was told `functional` would be
 * recorded blocked, and had nowhere to go from there. Every surface named the condition and
 * none named the recovery: the bench became claimable again ninety seconds later and nothing
 * said so. Everything needed to answer "when" was already on these rows — `remaining_min`,
 * `processing`, `healthy_at` — and nothing turned it into a sentence.
 *
 * So this is that sentence, in one place, rendered by the re-assay button, the Store banner
 * (through the alert's `impact`), the Activity page and the chat alike. It is deliberately
 * about the pool rather than about a bench: the question it answers is "can a functional
 * section run, and if not, when" — `claimNote()` on the Activity page still says what each
 * individual row's runway is, which is a different question.
 *
 * `now` is a parameter so the prose is testable.
 */
export function describeWindow(
  rows: readonly BenchHealth[],
  minRemainingMin: number,
  now: Date = new Date(),
): string {
  if (rows.length === 0) return 'no demo bench is configured';

  // The bench the runner would actually take. `list()` is name-sorted and `execute()` reads
  // `leasable()[0]`, so describing any other row would be describing a box nothing will use.
  const claimable = rows.filter((b) => isLeasable(b, minRemainingMin));
  const taking = claimable[0];
  if (taking) {
    const left = taking.remaining_min;
    return typeof left === 'number'
      ? `${taking.name} is usable for another ${left} min, until its wipe at ~${clockOf(new Date(now.getTime() + left * 60_000))}`
      : `${taking.name} is usable (the board gives no countdown)`;
  }

  const healthy = rows.filter((b) => b.status === 'healthy');
  if (healthy.length > 0) {
    // Mid-cleanup first: it is the only one of these that resolves by itself, and quickly.
    const busy = healthy.find((b) => b.processing === true);
    if (busy) return `${busy.name} is mid-cleanup — usually back within minutes`;

    // Healthy and inside the guard. The one with the *most* runway is the one whose wipe —
    // and therefore whose next usable window — comes soonest.
    const soonest = [...healthy].sort((a, b) => (b.remaining_min ?? 0) - (a.remaining_min ?? 0))[0]!;
    const left = soonest.remaining_min;
    if (typeof left === 'number') {
      return (
        `${soonest.name} is ${left} min from its wipe at ~${clockOf(new Date(now.getTime() + left * 60_000))}` +
        ` and inside the ${minRemainingMin} min guard — usable again shortly after it`
      );
    }
    return `${soonest.name} answers but the board gives no countdown, so it cannot be claimed`;
  }

  // Nothing answering at all. Name each box and when it was last seen, because "the pool is
  // down" sends whoever reads it straight off to look up the thing we already know.
  return `no demo bench is answering — ${rows.map((b) => `${b.name} ${lastSeen(b.healthy_at, now)}`).join(', ')}`;
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
      if (res.status === 200) {
        // Read the landing page only to fingerprint the build. Capped, and every failure
        // path here is swallowed: this module's job is to say whether the bench is usable,
        // and it must not start reporting a healthy bench as down because a body was odd.
        let build: string | undefined;
        try {
          const body = (await res.text()).slice(0, BUILD_SNIFF_BYTES);
          build = buildFrom(body);
        } catch {
          build = undefined;
        }
        return { status: 'healthy', latencyMs: since(), httpStatus: 200, ...(build ? { build } : {}) };
      }
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
  /** Set when someone changed the runway guard at runtime — `domain/controls.ts`. */
  private minRemainingOverride?: number;

  constructor(opts: BenchProberOptions) {
    this.opts = opts;
    this.file = path.join(opts.stateDir, 'benches.json');
  }

  /**
   * Minutes of runway a bench needs before a functional assay may claim it — the D8 rule.
   *
   * Read through a getter rather than from `opts` at each site because it is settable at
   * runtime: a pool whose instances are wiped on a different schedule needs a different
   * guard, and that is a number an operator should be able to change without a restart.
   */
  get minRemainingMin(): number {
    return this.minRemainingOverride ?? this.opts.minRemainingMin ?? 60;
  }

  get minRemainingMinDefault(): number {
    return this.opts.minRemainingMin ?? 60;
  }

  setMinRemainingMin(minutes: number): void {
    this.minRemainingOverride = minutes;
  }

  clearMinRemainingMin(): void {
    this.minRemainingOverride = undefined;
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
    return this.list().filter((b) => isLeasable(b, this.minRemainingMin));
  }

  /**
   * Whether a functional assay can start, and when that changes — see `describeWindow`.
   *
   * A method rather than a call at each site because `minRemainingMin` is this object's, and
   * a caller that guessed 60 would describe a gate it does not control.
   */
  window(now = new Date()): string {
    return describeWindow(this.list(), this.minRemainingMin, now);
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
          // Keep the last fingerprint when this probe could not take one, so a single odd
          // response does not read as "the platform changed to nothing".
          build: probe.build ?? previous?.build,
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

    this.pendingWrite = this.persist();
    await this.pendingWrite;
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
    // What this is currently stopping, in the operator's terms. Not "the functional queue":
    // there is no queue (invariant 8), and which sections need a bench is the protocol's to
    // say — an audit still runs, it is simply narrower while this holds.
    // Always set, and always carrying the window.
    //
    // It used to be `undefined` whenever anything was still leasable, so a half-broken pool —
    // one box down, one working, which is the ordinary case — gave the operator a card naming
    // a fault and saying nothing about whether work could proceed. And even when it was set it
    // said only what would go wrong, never when it would stop. The second clause is the whole
    // point: an alert whose remedy is "wait ninety seconds" should say so.
    const impact =
      (this.leasable().length === 0
        ? 'sections that need a bench will be recorded blocked · no try consumed · '
        : 'audits still run · ') + this.window();

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

  /** Await the in-flight state write. Same reason as `AlertStore.flush`. */
  async flush(): Promise<void> {
    await this.inFlight;
    await this.pendingWrite;
  }

  private pendingWrite?: Promise<void>;

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, this.list());
    } catch (err) {
      console.error('could not write benches.json', err);
    }
  }
}
