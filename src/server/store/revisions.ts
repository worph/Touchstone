/**
 * The protocol's history: what changed, when, and — when anyone bothered to say — why.
 *
 * Until this existed, a protocol's identity was an integer it carried in its own frontmatter
 * and bumped on save. Two things were wrong with that, and they are the whole reason for this
 * file:
 *
 * - **The number resolved to nothing.** Every assay records the standard that judged it, and
 *   on a volume the text of that standard is gone the moment it is edited. The archive said
 *   "judged by v7" and there was no v7 anywhere to read.
 * - **It only counted the edits made through the app.** A `.sh` executor had no number at
 *   all, and a rubric edited over SSH changed its content without changing its version.
 *
 * So identity is now the **sha256 of the file**, for a rubric and a script alike, and this
 * module is what makes a hash dereferenceable: an append-only log plus a copy of the bytes.
 *
 * ## Sweep on observe, not on save
 *
 * `sweep()` hashes what is on disk and records what differs from the newest entry for that
 * file. It runs at boot, after a save, and before a run reads the protocol — so an edit made
 * by hand on the volume is captured too, as `observed`, with no reason recorded. That
 * asymmetry against `save` is deliberate: it is what makes editing outside the app visibly
 * second-class in the history, rather than invisible.
 *
 * ## What it is not
 *
 * Not a version control system, and specifically **not restorable from here**. Putting an old
 * revision back is "load it into the editor and save it forward" — a new entry with a reason —
 * because a rewind endpoint would let the admin MCP that authenticates nobody quietly revert
 * the rubric every subsequent audit is judged against.
 *
 * `seq` is a display ordinal owned by this log. It is never written into a protocol file, and
 * no assay records it: an assay records the hash, so losing this directory costs the history
 * and never the archive's ability to say what judged it.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { shortSha, type Revision, type RevisionSource } from '../../shared/standard.js';
import { isSafeExecutor } from './protocols.js';

/** Where the history lives, relative to the protocols directory. */
export const HISTORY_DIR = '.history';
const LOG_FILE = 'log.jsonl';

/** A revision plus the bytes it names. */
export interface RevisionContent {
  revision: Revision;
  text: string;
}

export interface RevisionStoreOptions {
  now?: () => Date;
  /** Called once per failure, so the composition root can log an event without this module importing one. */
  onWarn?: (message: string) => void;
  /**
   * Called for each revision recorded, wherever the sweep was called from.
   *
   * One wiring point rather than an announcement at each of the three call sites — which is
   * how an `observed` row gets into Activity no matter which sweep happened to notice it.
   */
  onRecorded?: (revision: Revision) => void;
}

/**
 * A protocol file name, as it may appear in the log.
 *
 * Names only ever arrive from `readdir` of one directory, so they cannot contain a separator
 * to begin with. This is checked anyway on the way back out, because a log line is a string
 * that a route hands to `path.join`.
 */
function isSafeFile(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*\.(md|sh)$/.test(name);
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export class RevisionStore {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly onWarn: (message: string) => void;
  private readonly onRecorded: (revision: Revision) => void;
  /** The log, oldest first. Null until first read. */
  private log: Revision[] | null = null;
  /** Serialises every write. One process, so a promise chain is the whole lock. */
  private tail: Promise<unknown> = Promise.resolve();
  /** The last failure, so a page can say the history is not being written. */
  private failure: string | null = null;

  constructor(
    private readonly protocolsDir: string,
    opts: RevisionStoreOptions = {},
  ) {
    this.dir = path.join(protocolsDir, HISTORY_DIR);
    this.now = opts.now ?? (() => new Date());
    this.onWarn = opts.onWarn ?? (() => {});
    this.onRecorded = opts.onRecorded ?? (() => {});
  }

  get directory(): string {
    return this.dir;
  }

  /** The last error, or null. A history that cannot be written must never stop an audit. */
  get failed(): string | null {
    return this.failure;
  }

  /**
   * Every revision, newest first.
   *
   * A corrupt line is skipped rather than fatal — that is the point of one JSON object per
   * line. A history with a hole in it is still a history; refusing to show any of it because
   * of one bad byte is how a diagnostic surface stops being one.
   */
  async all(): Promise<Revision[]> {
    return [...(await this.read())].reverse();
  }

  /** The revisions of these files, newest first. Used for one section's timeline. */
  async forFiles(files: readonly string[]): Promise<Revision[]> {
    const want = new Set(files);
    return (await this.all()).filter((r) => want.has(r.file));
  }

  /**
   * Resolve one recorded revision by its `seq`, and the bytes it named.
   *
   * The seq exists for exactly this: **a hash can appear in the log more than once**, because
   * a file restored to an earlier state has the identity it had before. Looking up by hash
   * then finds the wrong *event* — the right bytes with somebody else's parent, and therefore
   * a diff against the wrong thing. Content is addressed by hash; an event is addressed by
   * seq, and a diff is about an event.
   */
  async at(seq: number): Promise<RevisionContent | null> {
    const revision = (await this.read()).find((r) => r.seq === seq);
    return revision ? this.contentOf(revision) : null;
  }

  /**
   * Resolve a full or shortened hash to the bytes it names.
   *
   * Returns the *first* revision with that hash. That is the right answer for "what did the
   * standard say when it judged this", which is what an assay's `standard_sha256` asks — every
   * revision sharing a hash shares its bytes by definition. It is the wrong answer for "what
   * changed here"; use `at()` for that.
   */
  async get(sha: string): Promise<RevisionContent | null> {
    const key = sha.trim().toLowerCase();
    if (!/^[0-9a-f]{7,64}$/.test(key)) return null;
    const revision = (await this.read()).find((r) => r.sha256 === key || r.sha256.startsWith(key));
    return revision ? this.contentOf(revision) : null;
  }

  private async contentOf(revision: Revision): Promise<RevisionContent | null> {
    if (!isSafeFile(revision.file)) return null;
    try {
      return { revision, text: await fs.readFile(this.snapshotPath(revision), 'utf8') };
    } catch {
      // The log says it existed; the bytes are gone. Say nothing rather than guess.
      return null;
    }
  }

  /**
   * Record what is on disk.
   *
   * Writes a snapshot and a log line only for a file whose hash differs from its newest
   * entry, so calling this on every run costs one hash per protocol and nothing else.
   *
   * Always looks at **every** protocol file, even when a save prompted it. A save is the
   * cheapest moment to notice that somebody also hand-edited the script beside the rubric,
   * and the two are attributed differently: the saved file gets `save` and the operator's
   * reason, everything else that moved gets `observed` and none of the credit.
   *
   * Returns what it recorded, which is usually nothing.
   */
  async sweep(opts: { save?: { file: string; message: string } } = {}): Promise<Revision[]> {
    return this.serialise(async () => {
      const log = await this.read();
      let names: string[];
      try {
        const entries = await fs.readdir(this.protocolsDir, { withFileTypes: true });
        names = entries
          .filter((e) => e.isFile())
          .map((e) => e.name)
          .filter((n) => (n.endsWith('.md') || isSafeExecutor(n)) && isSafeFile(n))
          .sort();
      } catch (err) {
        return this.giveUp('the protocol directory could not be read', err);
      }
      const written: Revision[] = [];
      for (const file of names) {
        let bytes: Buffer;
        try {
          bytes = await fs.readFile(path.join(this.protocolsDir, file));
        } catch (err) {
          this.warn(`${file} could not be read for the history`, err);
          continue;
        }
        const hash = sha256(bytes);
        const previous = lastOf(log, file);
        if (previous?.sha256 === hash) continue;

        const saved = opts.save?.file === file;
        const revision: Revision = {
          seq: (log[log.length - 1]?.seq ?? 0) + 1,
          at: this.now().toISOString(),
          file,
          sha256: hash,
          parent: previous?.sha256 ?? null,
          bytes: bytes.length,
          // A first sighting nobody claims is a `seed`: a file that appeared because the
          // image seeded it was not edited by anyone, and calling that a save would put a
          // reason on a revision nobody wrote.
          source: saved ? 'save' : previous ? 'observed' : 'seed',
          message: saved ? (opts.save?.message ?? null) : null,
        };

        try {
          await this.write(revision, bytes);
        } catch (err) {
          return this.giveUp(`${file} could not be written to the history`, err);
        }
        log.push(revision);
        written.push(revision);
        this.onRecorded(revision);
      }
      if (written.length > 0) this.failure = null;
      return written;
    });
  }

  /** Everything the sweep needs on disk, in an order that leaves no log line without bytes. */
  private async write(revision: Revision, bytes: Buffer): Promise<void> {
    const target = this.snapshotPath(revision);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // The snapshot lands first: a log line pointing at a file that is not there is a broken
    // link, while bytes with no log line are merely an orphan nothing reads.
    await fs.writeFile(target, bytes, { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err;
    });
    await fs.appendFile(path.join(this.dir, LOG_FILE), `${JSON.stringify(revision)}\n`, 'utf8');
  }

  /** `<file>/<seq>-<short sha>.<ext>` — sorts by seq, and says which bytes it holds. */
  private snapshotPath(revision: Revision): string {
    const ext = path.extname(revision.file);
    const seq = String(revision.seq).padStart(4, '0');
    return path.join(this.dir, revision.file, `${seq}-${shortSha(revision.sha256)}${ext}`);
  }

  /** The log, oldest first, read once and kept — it is a few hundred lines at most. */
  private async read(): Promise<Revision[]> {
    if (this.log) return this.log;
    const out: Revision[] = [];
    try {
      const raw = await fs.readFile(path.join(this.dir, LOG_FILE), 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        try {
          const parsed = JSON.parse(line) as Revision;
          if (typeof parsed.sha256 === 'string' && isSafeFile(parsed.file)) out.push(parsed);
        } catch {
          this.warn('a line of the protocol history could not be read', null);
        }
      }
    } catch (err) {
      // No log yet is the normal first boot, and is not a failure.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn('the protocol history could not be read', err);
      }
    }
    this.log = out;
    return out;
  }

  private serialise<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => {});
    return next;
  }

  private giveUp(what: string, err: unknown): Revision[] {
    this.warn(what, err);
    return [];
  }

  private warn(what: string, err: unknown): void {
    const detail = err instanceof Error ? `${what}: ${err.message}` : what;
    if (this.failure === detail) return;
    this.failure = detail;
    this.onWarn(detail);
  }
}

function lastOf(log: readonly Revision[], file: string): Revision | undefined {
  for (let i = log.length - 1; i >= 0; i -= 1) if (log[i]!.file === file) return log[i];
  return undefined;
}

export type { Revision, RevisionSource };
