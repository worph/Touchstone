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
 * **A bench rests between jobs** (requirements §26). For `scheduler.cooldown_min` after a lease
 * holding it is released, a bench is healthy but not free — whatever ran on it, an audit, a
 * trial or a workshop session, foreground or not. It is the blank between two songs: the next
 * job does not start on a box the last one is still settling. It lives here rather than in the
 * policy because only this file knows *which* bench a job had, and a per-platform anchor would
 * idle the second bench of a pool every time the first one finished.
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
  /**
   * Cleanup for a released lease — the one place every run, trial and workshop session passes
   * through on its way out, however it ended. `services/browsertabs.ts` uses it to close the
   * run's tabs.
   *
   * While it runs the lease **stays held**, so the next run cannot be handed the same browser
   * and have its fresh tabs mistaken for the old run's. It must settle on its own (the tab
   * cleanup's requests carry timeouts); a rejection is swallowed — a release always releases.
   */
  onRelease?: (lease: Lease) => Promise<void> | void;
  /**
   * A lease that waited on `onRelease` is free now — the cue to look for queued work. Also
   * called when a bench's rest ends, for the same reason.
   */
  onFreed?: () => void;
  /** Minutes a bench rests after every job. Read at each release, so a control change applies to the next one. */
  gapMin?: () => number;
}

export class Leases {
  private readonly held = new Map<string, Lease>();
  /** Released and cleaning up: still held, not releasable twice. */
  private readonly releasing = new Set<string>();

  /** Bench URL → epoch ms its rest ends. Entries in the past are simply ignored. */
  private readonly restUntil = new Map<string, number>();

  constructor(private readonly source: LeaseSource) {}

  private nowMs(): number {
    return (this.source.now?.() ?? new Date()).getTime();
  }

  private isResting(url: string): boolean {
    const until = this.restUntil.get(url);
    return until !== undefined && until > this.nowMs();
  }

  /** Start a bench's rest, and wake the scheduler when it ends. */
  private rest(lease: Lease): void {
    const url = lease.bench?.url;
    if (!url) return;
    const gapMs = Math.max(0, (this.source.gapMin?.() ?? 0) * 60_000);
    if (gapMs === 0) return;
    this.restUntil.set(url, this.nowMs() + gapMs);
    const timer = setTimeout(() => this.source.onFreed?.(), gapMs + 50);
    timer.unref?.();
  }

  /** Healthy benches of this target in their rest, and when the first comes back. */
  resting(target: string): { count: number; until?: string } {
    const taken = this.heldUrls('bench');
    let count = 0;
    let first: number | undefined;
    for (const b of this.source.benches(target)) {
      if (taken.has(b.url) || !this.isResting(b.url)) continue;
      count += 1;
      const until = this.restUntil.get(b.url)!;
      if (first === undefined || until < first) first = until;
    }
    return { count, ...(first !== undefined ? { until: new Date(first).toISOString() } : {}) };
  }

  private heldUrls(kind: 'bench' | 'browser'): Set<string> {
    const out = new Set<string>();
    for (const lease of this.held.values()) {
      const url = kind === 'bench' ? lease.bench?.url : lease.browser?.url;
      if (url) out.add(url);
    }
    return out;
  }

  /** Healthy benches of this target that nobody holds and that are not resting, in the prober's (name) order. */
  freeBenches(target: string): BenchHealth[] {
    const taken = this.heldUrls('bench');
    return this.source.benches(target).filter((b) => !taken.has(b.url) && !this.isResting(b.url));
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
    if (!id || this.releasing.has(id)) return;
    const lease = this.held.get(id);
    if (!lease) return;
    let pending: Promise<void> | void;
    try {
      pending = this.source.onRelease?.(lease);
    } catch {
      pending = undefined;
    }
    if (!pending) {
      this.held.delete(id);
      this.rest(lease);
      return;
    }
    this.releasing.add(id);
    void pending
      .catch(() => undefined)
      .then(() => {
        this.releasing.delete(id);
        this.held.delete(id);
        this.rest(lease);
        this.source.onFreed?.();
      });
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
  capacity(targets: readonly string[]): {
    benches: Record<string, number>;
    browsers: number;
    /** Only targets with a resting bench; absent when none is. */
    resting?: Record<string, { count: number; until?: string }>;
  } {
    const benches: Record<string, number> = {};
    const resting: Record<string, { count: number; until?: string }> = {};
    for (const t of targets) {
      benches[t] = this.freeBenches(t).length;
      const r = this.resting(t);
      if (r.count > 0) resting[t] = r;
    }
    return {
      benches,
      browsers: this.freeBrowsers().length,
      ...(Object.keys(resting).length > 0 ? { resting } : {}),
    };
  }

  /** Totals beside the free counts, for a page that has to say "1 of 2 benches in use". */
  usage(targets: readonly string[]): {
    benches: Record<string, { free: number; total: number; resting?: number }>;
    browsers: { free: number; total: number };
  } {
    const benches: Record<string, { free: number; total: number; resting?: number }> = {};
    for (const t of targets) {
      const r = this.resting(t).count;
      benches[t] = {
        free: this.freeBenches(t).length,
        total: this.source.benches(t).length,
        ...(r > 0 ? { resting: r } : {}),
      };
    }
    return {
      benches,
      browsers: { free: this.freeBrowsers().length, total: this.source.browsers().length },
    };
  }
}
