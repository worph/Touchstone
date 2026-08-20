/**
 * One-shot archive layout migration: `reports/<Subject>/` → `reports/<origin>/<Subject>/`.
 *
 * **This is cosmetic, not correctness-bearing, and that is the point.** `coerceMeta` fills a
 * missing `origin` with `DEFAULT_ORIGIN` when it reads a file, so an archive that never gets
 * migrated — a read-only data dir, a crash halfway through, a restored backup — still indexes,
 * resolves and renders correctly. Everything here is tidying, so every failure path is "log it
 * and carry on" rather than "refuse to boot".
 *
 * Three decisions worth keeping:
 *
 * - **Which directories are legacy is a structural test, not a config lookup.** A directory at
 *   depth 1 holding `*.md` files directly *is* a subject; one holding only directories is
 *   already an origin. That stays right even if a subject is one day named like an origin, and
 *   it needs nothing passed in.
 * - **Move file by file, never `rename` a whole directory.** Renaming the directory fails
 *   `ENOTEMPTY` the instant a target partially exists from a previous crashed run, which is
 *   precisely the state a resumable migration has to survive.
 * - **Never destroy a divergent file.** A target that already exists and differs leaves both
 *   copies and a warning. Reports are the archive of record; losing one to tidying would be a
 *   worse outcome than an untidy tree.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { DEFAULT_ORIGIN } from '../../shared/subject.js';
import type { EventLog } from '../services/events.js';

export interface MigrateResult {
  /** The origin everything was moved under. */
  origin: string;
  /** Legacy subject directories found at depth 1. Zero means there was nothing to do. */
  subjects: number;
  moved: number;
  /** Identical file already at the target: the source was removed. */
  deduped: number;
  /** Target exists and differs: both were left in place. Needs a human. */
  conflicts: string[];
  failed?: string;
}

/** A directory holding `*.md` directly is a legacy subject; one holding only dirs is an origin. */
async function isLegacySubjectDir(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.some((e) => e.isFile() && e.name.endsWith('.md'));
}

async function sameBytes(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
  return x.equals(y);
}

/**
 * Move any legacy subject directory under `reportsRoot` into `reportsRoot/<origin>/`.
 *
 * Returns what it did. Safe to call on every boot: with nothing to migrate it reads one
 * directory and returns, logging nothing — a marker file in `state/` would have been the
 * obvious alternative and is worse, because it would suppress the retry after a partial failure.
 */
export async function migrateArchiveLayout(
  reportsRoot: string,
  opts: { origin?: string } = {},
): Promise<MigrateResult> {
  const origin = opts.origin ?? DEFAULT_ORIGIN;
  const out: MigrateResult = { origin, subjects: 0, moved: 0, deduped: 0, conflicts: [] };

  let top: import('node:fs').Dirent[];
  try {
    top = await fs.readdir(reportsRoot, { withFileTypes: true });
  } catch (err) {
    // No archive yet is the normal first-boot state, not a problem.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    return fail(out, err);
  }

  const legacy: string[] = [];
  for (const entry of top) {
    if (!entry.isDirectory()) continue;
    if (entry.name === origin) continue;
    try {
      if (await isLegacySubjectDir(path.join(reportsRoot, entry.name))) legacy.push(entry.name);
    } catch (err) {
      return fail(out, err);
    }
  }

  out.subjects = legacy.length;
  if (legacy.length === 0) return out;

  for (const subject of legacy) {
    const from = path.join(reportsRoot, subject);
    const to = path.join(reportsRoot, origin, subject);
    try {
      await fs.mkdir(to, { recursive: true });
      for (const entry of await fs.readdir(from, { withFileTypes: true })) {
        // Skip anything that is not a report — in particular `*.tmp-<pid>` left behind by a
        // write that crashed between `writeFile` and `rename`.
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const src = path.join(from, entry.name);
        const dst = path.join(to, entry.name);
        let exists = true;
        try {
          await fs.access(dst);
        } catch {
          exists = false;
        }
        if (!exists) {
          await fs.rename(src, dst);
          out.moved += 1;
        } else if (await sameBytes(src, dst)) {
          await fs.unlink(src);
          out.deduped += 1;
        } else {
          out.conflicts.push(`${subject}/${entry.name}`);
        }
      }
      // Only when nothing is left — a conflict, or a non-report file, keeps the directory.
      await fs.rmdir(from).catch(() => undefined);
    } catch (err) {
      return fail(out, err);
    }
  }

  return out;
}

function fail(out: MigrateResult, err: unknown): MigrateResult {
  out.failed = err instanceof Error ? err.message : String(err);
  return out;
}

/**
 * Report what the migration did, once there is somewhere to report it.
 *
 * Split from the move itself because the move has to happen *before* the index is built and the
 * `EventLog` is constructed *after* it. Silent when there was nothing to do — a boot that had no
 * legacy archive should say nothing at all.
 */
export function logArchiveMigration(result: MigrateResult, events: EventLog): void {
  if (result.failed) {
    // A read-only data dir is a real deployment (`ensureConfigFile` says so). Reports still read
    // correctly from the old layout, so this is a warning about tidiness, not about the archive.
    events.log({
      level: 'warn',
      code: 'ARCHIVE_MIGRATION_FAILED',
      message:
        'Could not move the report archive under its store folder, so it stays where it is — ' +
        'reports still read correctly',
      detail: { error: result.failed },
    });
    return;
  }
  if (result.subjects === 0) return;
  events.log({
    level: result.conflicts.length > 0 ? 'warn' : 'info',
    code: 'ARCHIVE_MIGRATED',
    message:
      `The report archive moved under \`${result.origin}/\` — ${result.moved} file(s) from ` +
      `${result.subjects} subject(s)` +
      (result.deduped > 0 ? `, ${result.deduped} already there` : '') +
      (result.conflicts.length > 0
        ? `. ${result.conflicts.length} file(s) differ from a copy already at the target and were left in both places`
        : ''),
    detail: {
      origin: result.origin,
      subjects: result.subjects,
      moved: result.moved,
      deduped: result.deduped,
      conflicts: result.conflicts,
    },
  });
}
