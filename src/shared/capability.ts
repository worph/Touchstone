/**
 * What a section's `requires:` can name, and the one question code asks about it.
 *
 * A capability is an opaque string: the protocol declares it, `config.yaml` says which pool
 * answers it, and nothing enumerates the set (invariant 2). There is exactly one thing the
 * code needs to decide without asking a pool — **is this a request for a demo bench?** — and
 * it has to be answerable for a capability that **no pool supplies**, which is precisely the
 * case that has to be caught rather than waved through.
 *
 * So it is a naming convention, deliberately: `bench`, and `bench.<pool>` for every pool after
 * the first. `requires: ['gpu']` is unknown and runs (property 4 in `runner/capabilities.ts`);
 * `requires: ['bench.foss']` on a box with no FOSS pool is recorded `bench_unconfigured`,
 * because the alternative is a runtime audit dispatched with nowhere to perform it, whose
 * output is then filed as a verdict about the app.
 *
 * It lives in `shared/` with no imports of its own because `runner/prompt.ts` needs it and is
 * deliberately dependency-free — it builds a string and nothing else, which is what lets its
 * tests pin the exact bytes the agent receives.
 */

/** The capability the original, and still default, pool answers to. */
export const DEFAULT_BENCH_CAPABILITY = 'bench';

/** Is this capability a request for a demo bench? See the header for why it is a convention. */
export function isBenchCapability(capability: string): boolean {
  return (
    capability === DEFAULT_BENCH_CAPABILITY ||
    capability.startsWith(`${DEFAULT_BENCH_CAPABILITY}.`)
  );
}
