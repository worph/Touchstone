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

/**
 * Write JSON so a reader never sees a partial file.
 *
 * `rename` within a directory is atomic on both POSIX and NTFS, so the file is either the
 * old contents or the new ones. The temp name carries the pid to keep two processes — the
 * API and a hand-run tool — from colliding on it.
 */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
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
