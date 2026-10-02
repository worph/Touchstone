/**
 * Who is using which bench and which browser — the reservation that single-flight used to be.
 *
 * Until 2026-10 nothing was ever reserved. `resolveCapabilities` took `benches[0]` and
 * `browsers[0]`, and that was safe only because one run existed at a time: the scheduler's
 * global busy check and the runner's own flag were the lease. Once each platform has a queue of
 * its own, two runs can be in flight, and "the first healthy one" is the same instance for both
 * — two agents installing into one demo box, or driving one Chrome, and each reading the other's
 * clicks as the app's behaviour.
 *
 * So a run now holds a **(bench, browser) pair** for its whole duration, and capacity is simply
 * how many pairs are free. Nothing is configured about concurrency: two Yundera benches and one
 * browser is one run at a time; add a browser sidecar and it is two. More resources, more runs,
 * no code change — which is the whole requirement.
 *
 * **"All in use" is not "broken", and the two are kept apart on purpose.** `Targets.leasable()`
 * stays a health answer, because the bench gate and its alert read it: a pool whose two benches
 * are both busy auditing is healthy, and an alert saying otherwise would fire every time the
 * loop did its job. `free()` is the other question — healthy *and* nobody holding it — and only
 * the allocator asks it.
 *
 * In-process and in-memory, deliberately. A lease outlives nothing: the run that holds it dies
 * with the process, so a lease that survived a restart would describe a run that does not exist
 * and hold a bench nobody is using.
 */

import { randomBytes } from 'node:crypto';

import type { BenchHealth } from '../../shared/activity.js';
import type { PortHealth } from './ports.js';

/** What one run holds. Either half may be absent — see `reserve()`. */
export interface Lease {
  id: string;
  target: string;
  bench?: BenchHealth;
  browser?: PortHealth;
  /** For the Automation page: who is holding it. */
  holder: string;
  since: string;
}

/** What a run needs, from the `requires:` of the sections it covers. */
export interface LeaseNeeds {
  bench: boolean;
  browser: boolean;
}

export type ReserveResult =
  | { ok: true; lease: Lease }
  /**
   * Healthy resources exist and every one of them is held. Waiting fixes it, so the job is put
   * back untouched (invariant 3) — not recorded blocked, which would be a statement that the
   * platform was unusable when it was merely busy.
   */
  | { ok: false; full: 'bench' | 'browser' };

export interface LeaseSource {
  /** Healthy, claimable benches of one target — `Targets.leasable(target)`. */
  benches: (target: string) => readonly BenchHealth[];
  /** Healthy browser sidecars — `PortProber.healthy('browser')`. */
  browsers: () => readonly PortHealth[];
  now?: () => Date;
}

export class Leases {
  private readonly held = new Map<string, Lease>();

  constructor(private readonly source: LeaseSource) {}

  private heldUrls(kind: 'bench' | 'browser'): Set<string> {
    const out = new Set<string>();
    for (const lease of this.held.values()) {
      const url = kind === 'bench' ? lease.bench?.url : lease.browser?.url;
      if (url) out.add(url);
    }
    return out;
  }

  /** Healthy benches of this target that nobody holds, in the prober's (name) order. */
  freeBenches(target: string): BenchHealth[] {
    const taken = this.heldUrls('bench');
    return this.source.benches(target).filter((b) => !taken.has(b.url));
  }

  /** Healthy browsers nobody holds. Shared across every target — a browser is not a platform. */
  freeBrowsers(): PortHealth[] {
    const taken = this.heldUrls('browser');
    return this.source.browsers().filter((b) => !taken.has(b.url));
  }

  /**
   * Take a pair for one run, atomically — there is no `await` between reading and holding.
   *
   * A need with **no healthy resource at all** is granted *without* that half, rather than
   * refused. That is not leniency: it is what lets `resolveCapabilities` record the sections
   * needing it as `bench_unavailable` / `browser_unavailable`, which is the honest account of
   * an outage and the behaviour every run had before leases. Only *busy* is a refusal.
   */
  reserve(target: string, needs: LeaseNeeds, holder: string): ReserveResult {
    let bench: BenchHealth | undefined;
    if (needs.bench) {
      const healthy = this.source.benches(target);
      if (healthy.length > 0) {
        bench = this.freeBenches(target)[0];
        if (!bench) return { ok: false, full: 'bench' };
      }
    }
    let browser: PortHealth | undefined;
    if (needs.browser) {
      const healthy = this.source.browsers();
      if (healthy.length > 0) {
        browser = this.freeBrowsers()[0];
        if (!browser) return { ok: false, full: 'browser' };
      }
    }
    const lease: Lease = {
      id: randomBytes(8).toString('hex'),
      target,
      ...(bench ? { bench } : {}),
      ...(browser ? { browser } : {}),
      holder,
      since: (this.source.now?.() ?? new Date()).toISOString(),
    };
    this.held.set(lease.id, lease);
    return { ok: true, lease };
  }

  /** Idempotent: releasing twice, or releasing a lease that was never held, is a no-op. */
  release(id: string | undefined): void {
    if (id) this.held.delete(id);
  }

  list(): Lease[] {
    return [...this.held.values()];
  }

  /**
   * How many runs each target could start right now, as the allocator sees it.
   *
   * Counts, not resources, so `policy.ts` stays a pure function of a plain object. Browsers
   * are one shared number because they are one shared pool: `decide()` spends them across
   * lines in priority order rather than handing each line its own.
   */
  capacity(targets: readonly string[]): { benches: Record<string, number>; browsers: number } {
    const benches: Record<string, number> = {};
    for (const t of targets) benches[t] = this.freeBenches(t).length;
    return { benches, browsers: this.freeBrowsers().length };
  }

  /** Totals beside the free counts, for a page that has to say "1 of 2 benches in use". */
  usage(targets: readonly string[]): {
    benches: Record<string, { free: number; total: number }>;
    browsers: { free: number; total: number };
  } {
    const benches: Record<string, { free: number; total: number }> = {};
    for (const t of targets) {
      benches[t] = { free: this.freeBenches(t).length, total: this.source.benches(t).length };
    }
    return {
      benches,
      browsers: { free: this.freeBrowsers().length, total: this.source.browsers().length },
    };
  }
}
