/**
 * Runtime state on disk: `state/alerts.json`, `state/benches.json`, `state/events.jsonl`.
 *
 * Everything here is regenerable (ARCHITECTURE.md § Where each part lives) — losing the
 * whole directory costs a reindex and a re-probe, never a report. That is what licences
 * the deliberate crudeness: no database, no locking, no schema migrations. Two shapes:
 *
 *   small and mutable  → JSON, rewritten atomically (tmp + rename), so a crash mid-write
 *                        leaves the previous version rather than half of the next one
 *   append-only        → JSONL with `O_APPEND`, so concurrent writers interleave whole
 *                        lines and a torn tail costs the last line, not the file
 *
 * The read side tolerates every corruption either can produce, because a log that refuses
 * to load after a hard kill is a log you cannot read at the one moment you need it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Read and parse a JSON file. Any failure — absent, truncated, garbage — is `fallback`. */
export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/** Distinguishes concurrent writes *within* this process. See `writeJsonAtomic`. */
let writeSeq = 0;

/**
 * Write JSON so a reader never sees a partial file.
 *
 * `rename` within a directory is atomic on both POSIX and NTFS, so the file is either the
 * old contents or the new ones.
 *
 * **The temp name has to be unique per call, not per process.** It carried only the pid,
 * which is enough to keep the API and a hand-run tool apart but nothing at all inside one
 * process — and two writes to the same file overlap routinely here: a bench probe persists
 * while the alert transition it caused persists, a tick persists while a result is recorded.
 * Both wrote the same temp path, the first `rename` consumed it, and the second failed
 * `ENOENT` with its write silently lost. It showed up as a test that failed roughly one run
 * in three; in production it is a state file that quietly does not survive a restart.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${++writeSeq}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fs.rename(tmp, file);
  } catch (err) {
    // Do not leave the scratch file behind on a failure; a directory of `.tmp-*` files is
    // how a reader finds out about this the hard way.
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Append one object as a line. `O_APPEND` makes each write atomic up to a pipe buffer. */
export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}

export interface ReadJsonlOptions {
  /** Return at most this many entries, taken from the end — the log reads newest-first. */
  limit?: number;
  /** Called per unusable line. Absent means skip silently, which is the normal case. */
  onSkip?: (line: string, index: number) => void;
}

/**
 * Read a JSONL file, skipping anything that will not parse.
 *
 * A process killed mid-append leaves a trailing line with no newline and, sometimes, no
 * closing brace. That line is *the* expected corruption, and the file is otherwise
 * perfectly good — so it is dropped rather than thrown. The same tolerance covers a line
 * hand-edited by someone grepping the log, which is a thing this format invites.
 */
export async function readJsonl<T>(file: string, opts: ReadJsonlOptions = {}): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const lines = raw.split('\n');
  const out: T[] = [];
  // Walk backwards when a limit is set: the tail is what the log screen wants, and a
  // year-old file should not be fully parsed to render twenty rows.
  const start = opts.limit !== undefined ? Math.max(0, lines.length - opts.limit * 2) : 0;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      opts.onSkip?.(line, i);
    }
  }
  return opts.limit !== undefined ? out.slice(-opts.limit) : out;
}

/** Truncate a JSONL file to its last `keep` valid entries. Called when it outgrows a cap. */
export async function trimJsonl(file: string, keep: number): Promise<number> {
  const entries = await readJsonl<unknown>(file);
  if (entries.length <= keep) return entries.length;
  const kept = entries.slice(-keep);
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  await fs.rename(tmp, file);
  return kept.length;
}
