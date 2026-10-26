/**
 * Settle with `onLate()` if `work` has not settled within `ms`.
 *
 * For the probers, which coalesce on one in-flight cycle so a timer tick and a hand-clicked
 * probe do not double the load. That guard turns a cycle that never settles into a prober that
 * never runs again: on 2026-10-26 a bench cycle hung after a network blip on yunderalabs, every
 * tick for four hours was handed the same pending promise, and the pool read `unreachable`
 * while both benches answered in half a second. Each request inside a cycle carries its own
 * abort timer; this is the bound on the cycle as a whole, for whatever awaits ignored theirs.
 *
 * `work` is abandoned, not cancelled — if it settles late its result is simply not waited for.
 */
export function withDeadline<T>(work: Promise<T>, ms: number, onLate: () => T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      try {
        resolve(onLate());
      } catch (err) {
        reject(err);
      }
    }, ms);
    timer.unref?.();
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
