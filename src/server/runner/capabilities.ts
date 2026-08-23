/**
 * What a run would be made of — the partition of sections into "runs" and "recorded blocked".
 *
 * This was inline in `Runner.execute()` until 2026-08-23, and moved out for one reason: the
 * administrator chat's `run_assay` reply said only *"Started an audit of X"*, so an operator
 * who started a run into a dead demo pool learned what had happened only by asking a second
 * question and reading between the lines of the answer. The fix is for `run_assay` to say
 * which sections would run — and the thing that must not happen is a second copy of this
 * decision living in a chat handler, for the same reason `domain/protocoledit.ts` has exactly
 * one caller-facing save and `routes/mcp-admin.ts` has exactly one tool registry.
 *
 * So: `resolveCapabilities` is pure and is called by both `execute()` and `Runner.forecast()`,
 * and `liveWorld` is the single reader of the world they both describe.
 *
 * **Four properties are load-bearing and none of them is visible from the types.**
 *
 * 1. **Input order is preserved in both arrays.** `execute()` reads `blocked[0].reason` twice
 *    — as the run's `degraded_reason` and as the reason a fully-blocked run returns — and that
 *    means "the earliest-ordered blocked section" only because the sections arrive in the
 *    order `sectionsOf()` sorted them. Grouping or filtering here would silently change what
 *    the run strip says.
 * 2. **The same section objects come back, not copies.** Everything downstream reads `body`,
 *    `executor`, `requirements`, `phases`, `sha256` and `policy` off them.
 * 3. **`benchUnservable` is seeded before the pool is asked, and suppresses the lease.** A
 *    trial with no servable store must leave `benchHost` undefined *even when the pool is
 *    full*, or a bench host starts appearing in the frontmatter of trials that never used one.
 * 4. **A capability nothing supplies is satisfied, not blocked.** `requires: ['gpu']` runs.
 *    That is invariant 2 — nothing here enumerates sections or capabilities, so adding
 *    `data/protocols/security.md` costs no code change — and it is exactly the kind of thing
 *    that gets "fixed" into a throw by somebody who reads the `if`s and not this comment.
 */

import type { BenchHealth, BenchProber } from '../services/bench.js';
import type { PortHealth, PortProber } from '../services/ports.js';
import type { ProtocolSection } from '../store/protocols.js';

export interface CapabilityWorld {
  /** `BenchProber.leasable()`. Empty — including from an absent prober — means no bench. */
  benches: readonly BenchHealth[];
  /** `PortProber.healthy('browser')`. */
  browsers: readonly PortHealth[];
  /**
   * A reason the bench is unusable before the pool is even asked, which also suppresses the
   * lease. Today's only case is a trial Touchstone cannot serve a store zip for.
   */
  benchUnservable?: string;
}

/** The endpoints this run would use. Internal addresses — see `Runner.forecast()`. */
export interface CapabilityLease {
  benchHost?: string;
  benchBuild?: string;
  browserEndpoint?: string;
}

export interface CapabilityPlan {
  /** In input order, and the same objects that came in. */
  run: ProtocolSection[];
  /** In input order. `blocked[0].reason` is consumed as the run's headline reason. */
  blocked: { section: ProtocolSection; reason: string }[];
  lease: CapabilityLease;
}

/**
 * The one reader of the live world, so a run and a forecast of it cannot describe two.
 *
 * The shape mirrors `scheduler/index.ts`'s `buildInput()` beside the pure `policy.ts`, and for
 * the same stated reason: one reader means the tick and the queue the page renders cannot
 * disagree about who is stale.
 *
 * **An absent prober blocks.** That is deliberately the inverse of the scheduler
 * (`this.opts.prober ? leasable.length > 0 : true`, which lets a rig with no pool wired still
 * pick a subject). Here, a capability nothing can satisfy is a capability nothing can satisfy:
 * the sections needing it are recorded blocked, which costs the app nothing and is the honest
 * record. Two callers each writing their own `?? []` is how those two conventions would start
 * disagreeing inside one process.
 */
export function liveWorld(opts: {
  prober?: BenchProber;
  ports?: PortProber;
  trial?: { store_url?: string };
}): CapabilityWorld {
  // A trial that cannot be served has nothing for a bench to install, and that falls out of
  // the machinery that already exists rather than needing a branch of its own: declare the
  // bench unavailable up front and the partition records every section that wanted one as
  // blocked, with this reason, while the rest of the run proceeds.
  //
  // This is the *only* thing that makes a trial less than a full audit, and it is a fact about
  // this box rather than about trials: `trials.public_base_url` is unset, so Touchstone does
  // not know the address a bench on the public internet would fetch its store from.
  const unservable = opts.trial && !opts.trial.store_url ? 'store_url_unconfigured' : undefined;
  return {
    benches: opts.prober?.leasable() ?? [],
    browsers: opts.ports?.healthy('browser') ?? [],
    ...(unservable ? { benchUnservable: unservable } : {}),
  };
}

export function resolveCapabilities(
  sections: readonly ProtocolSection[],
  world: CapabilityWorld,
): CapabilityPlan {
  const wanted = new Set(sections.flatMap((s) => s.requires));
  const missing = new Map<string, string>();
  const lease: CapabilityLease = {};

  // Seeded before the probe below, and the `!missing.has('bench')` guard there depends on it.
  if (world.benchUnservable) missing.set('bench', world.benchUnservable);

  if (wanted.has('bench') && !missing.has('bench')) {
    if (world.benches.length === 0) missing.set('bench', 'bench_unavailable');
    else {
      // Read off the lease, not probed again here: the fingerprint has to describe the box
      // this run is about to use, and the prober already took one on the cycle that declared
      // it leasable. A second fetch would be a second answer.
      lease.benchHost = world.benches[0]!.url;
      const build = world.benches[0]!.build;
      if (build) lease.benchBuild = build;
    }
  }

  if (wanted.has('browser')) {
    // A lease is `(bench, browser)` together. There is one run at a time — the scheduler's
    // single-flight and the runner's own guard both say so — so taking the first healthy
    // sidecar *is* the lease, and no two assays can share a browser by construction.
    //
    // Note the deliberate asymmetry with the bench above: there is no `benchUnservable`
    // equivalent here, so a browser is leased whenever one is healthy, including on a run
    // whose only browser-needing section is blocked for want of a bench. That endpoint reaches
    // the assay frontmatter, so changing it would alter what a report says.
    if (world.browsers.length === 0) missing.set('browser', 'browser_unavailable');
    else lease.browserEndpoint = world.browsers[0]!.url;
  }

  const run: ProtocolSection[] = [];
  const blocked: { section: ProtocolSection; reason: string }[] = [];
  for (const section of sections) {
    const unmet = section.requires.find((c) => missing.has(c));
    if (unmet) blocked.push({ section, reason: missing.get(unmet)! });
    else run.push(section);
  }

  return { run, blocked, lease };
}
