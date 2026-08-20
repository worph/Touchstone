/**
 * Turning what somebody typed into a subject key.
 *
 * A subject is `<origin>~<name>` now, but four inputs still arrive bare and always will: a URL
 * somebody bookmarked before the rename, `POST /assays {subject}`, the `forced` list a person
 * types on the Automation page, and the app name the administrator chat's `run_assay` is given.
 * All four go through here so they cannot disagree — the alternative is four slightly different
 * fuzzy matchers, which is how `Filebrowser` ends up auditing nothing on one path and something
 * on another.
 *
 * **Ambiguity is an error, never a guess.** With one origin configured it cannot happen; with
 * two, a bare `FileBrowser` may mean either store's, and picking one silently would attribute a
 * verdict to the wrong app. The caller is expected to turn `{ ambiguous }` into a 400 that lists
 * the candidates, so the person can say which they meant.
 */

import { asSubjectKey, isSubjectKey, splitSubjectKey, type SubjectKey } from '../../shared/subject.js';

export type SubjectResolution =
  | { kind: 'ok'; key: SubjectKey }
  | { kind: 'ambiguous'; candidates: SubjectKey[] }
  | { kind: 'unknown' };

/**
 * Resolve `input` against `known`, in four passes, most specific first:
 *
 * 1. an exact key
 * 2. an exact bare name, unique across origins
 * 3. a case-insensitive key
 * 4. a case-insensitive bare name, unique across origins
 *
 * A bare name matching in several origins returns `ambiguous` rather than the first hit.
 */
export function resolveSubjectKey(input: string, known: readonly string[]): SubjectResolution {
  const raw = input.trim();
  if (!raw) return { kind: 'unknown' };

  const keys = known.map((k) => asSubjectKey(k));

  // 1 — an exact key.
  const exact = keys.find((k) => k === raw);
  if (exact) return { kind: 'ok', key: exact };

  // 2 — an exact bare name. `isSubjectKey` guards the case where somebody typed a key whose
  // origin does not exist: that is unknown, not a bare name that happens to contain a `~`.
  if (!isSubjectKey(raw)) {
    const byName = keys.filter((k) => splitSubjectKey(k).name === raw);
    if (byName.length === 1) return { kind: 'ok', key: byName[0]! };
    if (byName.length > 1) return { kind: 'ambiguous', candidates: byName };
  }

  const lower = raw.toLowerCase();

  // 3 — a key, ignoring case.
  const ciKey = keys.find((k) => k.toLowerCase() === lower);
  if (ciKey) return { kind: 'ok', key: ciKey };

  // 4 — a bare name, ignoring case. This is the pass that keeps `filebrowser` working, which
  // the chat's tool description has taught the model to rely on.
  if (!isSubjectKey(raw)) {
    const ciName = keys.filter((k) => splitSubjectKey(k).name.toLowerCase() === lower);
    if (ciName.length === 1) return { kind: 'ok', key: ciName[0]! };
    if (ciName.length > 1) return { kind: 'ambiguous', candidates: ciName };
  }

  return { kind: 'unknown' };
}

/** The message a 400 carries when a bare name matched more than one store. */
export function ambiguousMessage(input: string, candidates: readonly string[]): string {
  return (
    `\`${input}\` exists in more than one store — say which: ` + candidates.map((c) => `\`${c}\``).join(', ')
  );
}
