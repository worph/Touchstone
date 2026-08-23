/**
 * How an assay says what judged it.
 *
 * One helper, because the rule has two branches and they must not drift: an assay written
 * from 2026-08-23 carries `standard_sha256`, and everything older carries the integer the
 * protocol file used to keep in its own frontmatter. Both have to render — the archive is not
 * rewritten, and an app author looking at a verdict from July is entitled to see what it says
 * about itself, even though that number can no longer be turned back into text.
 *
 * The hash is shown at **twelve characters**, the same length `domain/scripted.ts` has always
 * printed an executor's hash at and the same length the snapshot filenames use. Two lengths
 * for one identity would be a bug waiting to be filed.
 */

/** Twelve characters of a sha256 — enough to be unique here, short enough to read aloud. */
export const SHORT_SHA = 12;

export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA);
}

/** The subset of an assay record this needs. Kept structural so both frames can pass theirs. */
export interface StandardRef {
  standard?: string;
  standard_sha256?: string;
  /** @deprecated Pre-2026-08-23 archive only. */
  standard_version?: number;
}

/**
 * `Static Review Protocol @9c1b3f2a4d55`, or `Static Review Protocol v7` for a legacy record.
 *
 * The `@` is doing work: it reads as "at this revision" rather than as a version number, which
 * is exactly the distinction — a hash has no order, and pretending otherwise by printing it as
 * `v9c1b3f2a` would invite an operator to think one is newer than another.
 */
export function standardLabel(ref: StandardRef): string {
  const name = ref.standard ?? 'the standard';
  if (ref.standard_sha256) return `${name} @${shortSha(ref.standard_sha256)}`;
  if (typeof ref.standard_version === 'number') return `${name} v${ref.standard_version}`;
  return name;
}

// ── the history a hash resolves in ─────────────────────────────────────────────────────
// The row shape lives here rather than in `server/store/revisions.ts` because the page that
// renders a history needs it, and the web may not import server code.

/**
 * How a revision came to be recorded.
 *
 * `seed` is a file's first sighting — a fresh install, or the boot that introduced the log to
 * a directory that already had protocols in it. `save` came through the editor and carries a
 * reason. `observed` is an edit the sweep found on the volume, with nothing to say for itself.
 */
export type RevisionSource = 'seed' | 'save' | 'observed';

export interface Revision {
  /** A display ordinal owned by the log. Never written into a protocol file. */
  seq: number;
  at: string;
  /** `static.md`, `currency.sh` — which file this is a revision of. */
  file: string;
  sha256: string;
  /** The hash this replaced, or null for a file's first revision. */
  parent: string | null;
  bytes: number;
  source: RevisionSource;
  /** Why. Present on `save`, null on everything the sweep merely noticed. */
  message: string | null;
}
