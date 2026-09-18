/**
 * **Targets** — the platforms an app is audited on, and how a section id names one.
 *
 * A capability (`bench`, `browser`) says *what kind of resource* a section needs. A target says
 * *which platform the verdict is about*, which is a property of the finding rather than of the
 * machine. Until 2026-09-18 one string was both — plus the pool it came from — and the code had
 * to sniff a `bench.` prefix to tell them apart.
 *
 * A rubric audited on several platforms expands into one section per target. The id of each
 * expansion is **derived** from the pair, and the target is **also recorded** on every assay, so
 * nothing downstream ever parses an id to learn what it is about. That pairing is what every
 * test-matrix system does: a CI job called `test (ubuntu, 18)` carries its axis values
 * structurally as well as in its name.
 *
 * **The default target keeps the bare id.** `functional` is the Yundera one; `functional@foss` is
 * the FOSS one. That is the `DEFAULT_ORIGIN` precedent applied again, and it is what lets the
 * whole existing archive read correctly with nothing rewritten — and what keeps the report
 * filename, the index's keying and the two-column Overview working untouched.
 *
 * It lives in `shared/` with no imports of its own because both halves of the app need it and
 * `runner/prompt.ts` — which is deliberately dependency-free — is one of them.
 */

/**
 * The default target's id.
 *
 * A **code** constant for the same reason `DEFAULT_ORIGIN` is: every assay written before targets
 * existed has its `target` filled in on read, so renaming this would silently re-interpret the
 * whole archive as being about a platform that does not exist.
 */
export const DEFAULT_TARGET = 'yundera';

/**
 * The separator between a rubric and its target in a composite section id.
 *
 * `@` reads unambiguously and round-trips: `isSafeSegment` accepts it in a filename and
 * `encodeURIComponent` percent-encodes it to `%40`, which Fastify decodes back. It is
 * deliberately **not** legal in `ProtocolStore.isSafeId`, so a composite id can never reach
 * `save()` and never put `functional@foss.md` on the volume — invariant 11 holds by the guard
 * that was already there.
 */
const SEP = '@';

/** `('functional', 'foss')` → `functional@foss`; the default target keeps the bare id. */
export function composeSectionId(rubric: string, target?: string): string {
  return !target || target === DEFAULT_TARGET ? rubric : `${rubric}${SEP}${target}`;
}

/** The rubric half of a section id — what names a file on disk. */
export function rubricOf(sectionId: string): string {
  const at = sectionId.indexOf(SEP);
  return at === -1 ? sectionId : sectionId.slice(0, at);
}

/** The target half, or the default when the id carries none. */
export function targetOf(sectionId: string): string {
  const at = sectionId.indexOf(SEP);
  return at === -1 ? DEFAULT_TARGET : sectionId.slice(at + SEP.length);
}
