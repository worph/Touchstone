/**
 * Subject identity: which app, in which store.
 *
 * A subject used to be a bare name, because there was exactly one store and its name was a
 * constant in five files. Once the store is a configured **origin** (R10), `FileBrowser` is no
 * longer an answer — two origins may both ship one — so identity becomes the pair.
 *
 * It is carried as **one opaque string**, `<origin>~<name>`, and that is a deliberate choice
 * rather than a shortcut. The alternative, threading `(origin, name)` as a pair, would rewrite
 * `scheduler/policy.ts` and `scheduler/record.ts`: `state/schedule.json` would become
 * `Record<origin, Record<name, row>>`, and with it `decide()`'s iteration, `queue()`,
 * `lastDoneAt`, `forced` and `TickDecision.subject`. Those two files are the **pure** port of
 * n8n's `Pick next target`, and their diffability against the live loop is a stated property of
 * the design — see CLAUDE.md and the header of `scheduler/policy.ts`. A composite string leaves
 * both of them byte-unchanged: they never look inside a subject, they only compare and order.
 *
 * ## Why `~`
 *
 * `~` is in `encodeURIComponent`'s unreserved set, so it survives a URL **unchanged**. That is
 * what lets every route keep the single-segment shape it already had — `/s/:name`,
 * `/subjects/:name`, `/reports/:subject/:file` — and what keeps `isSafeSegment` correct without
 * an edit, since it rejects `/` and `~` is not one.
 *
 * `/` fails four ways and was rejected: `isSafeSegment` refuses it; a proxy in front (Caddy,
 * AppShield — ARCHITECTURE §8) may normalise `%2F` back to a real slash and break both the deep
 * links `services/notify.ts` builds and react-router's `path="/s/:name"`; and an accidental
 * `path.join(reportsRoot, key)` would become a traversal-shaped bug rather than a type error.
 * `:` survives routing but encodes to `%3A`, so every URL, log line and address bar would carry
 * the escape.
 *
 * The separator never reaches the filesystem — reports nest as real directories,
 * `<origin>/<Subject>/…` — and never reaches YAML, where the frontmatter keeps a bare
 * `subject:` beside its `origin:`.
 */

/**
 * A subject key, `<origin>~<name>`.
 *
 * Branded on purpose. Everything this identity touches is otherwise a bare `string`, so a bare
 * name passed where a key belongs type-checks perfectly and then fails at runtime as a 404 or an
 * empty page — a bug you find by clicking, not by compiling. The brand turns roughly two dozen
 * such sites into a worklist `tsc` prints for you. `asSubjectKey` is the only way in, and it is
 * called at exactly three wire boundaries: route params, `state/schedule.json` on load, and
 * `state/registry.json` on load.
 */
export type SubjectKey = string & { readonly __subjectKey: unique symbol };

/** `<origin>~<name>`. Not `/`, and not a filesystem separator — see the file header. */
export const SUBJECT_KEY_SEP = '~';

/**
 * The origin a report file belongs to when its frontmatter does not say.
 *
 * A **code** constant, not a config value, and that is load-bearing: every assay written before
 * origins existed gets this filled in on read (`store/reports.ts`, `coerceMeta`, in the same
 * shape as the older `leg` → `section` fill). Renaming it would silently re-interpret the whole
 * legacy archive. Config must therefore *contain* an origin with this id rather than *choose*
 * it — checked at boot, because `loadConfig`'s `merge()` replaces arrays wholesale and an
 * operator adding a second origin would otherwise delete this one without being told.
 */
export const DEFAULT_ORIGIN = 'yundera';

/** Compose a key. Neither part may contain the separator. */
export function subjectKey(origin: string, name: string): SubjectKey {
  return `${origin}${SUBJECT_KEY_SEP}${name}` as SubjectKey;
}

/**
 * Split a key back into its parts.
 *
 * A string with no separator is read as a bare name in the default origin, so a key that
 * predates this change — a `state/schedule.json` row, an old event, a bookmarked URL — still
 * resolves to the subject it always meant.
 */
export function splitSubjectKey(key: string): { origin: string; name: string } {
  const at = key.indexOf(SUBJECT_KEY_SEP);
  if (at < 0) return { origin: DEFAULT_ORIGIN, name: key };
  return { origin: key.slice(0, at), name: key.slice(at + 1) };
}

/** The bare app name — what every heading, cell and notification renders. */
export function subjectName(key: string): string {
  return splitSubjectKey(key).name;
}

/** The origin id — what the step-3 badge shows. */
export function subjectOrigin(key: string): string {
  return splitSubjectKey(key).origin;
}

/**
 * Adopt a string that is already a key: a route param, or a key read back off disk.
 *
 * The one cast. A value that arrives without a separator is normalised into the default
 * origin's namespace rather than being trusted as-is, so the migration of `schedule.json` and
 * of any bookmarked URL is this function and nothing else.
 */
export function asSubjectKey(raw: string): SubjectKey {
  const { origin, name } = splitSubjectKey(raw);
  return subjectKey(origin, name);
}

/** Whether a string is already in key form. */
export function isSubjectKey(raw: string): boolean {
  return raw.includes(SUBJECT_KEY_SEP);
}
