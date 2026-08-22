/**
 * Upload sessions — handing Touchstone an app's files instead of a place to fetch them from.
 *
 * A trial audits a `repo@ref`. That is right for reviewing a PR and wrong for the loop this
 * exists to serve: change a compose, see whether it passes, change it again. Going through a
 * commit and a push to ask a question about a file you have open is slow, and it is also
 * *wrong* often enough to matter — `data/protocols/functional.md` records a day lost to a bench
 * installing a cached copy of the store while the auditor read the fixed source and could not
 * see the difference. An upload has no cache to be stale: nothing else has ever seen it.
 *
 * **A session is a directory and a token, and the token is the whole credential.** There is no
 * account here and nothing to log in to; whoever holds the token may write into that one
 * directory until it lapses. That is a deliberate choice rather than an oversight — the caller
 * is an agent reached over MCP, and the surface it writes through is already the surface that
 * can start audits.
 *
 * What that is worth to somebody who should not have it was settled before this was built: the
 * files end up on a demo bench, and a bench is a shared, publicly reachable instance with
 * published credentials, so an uploaded compose grants nothing an anonymous visitor lacked.
 * What is *not* covered by that argument is the cost here — bytes on Touchstone's own disk, on
 * the box that is also running the audits. Hence the three caps in `config.uploads`, and hence
 * a session that expires on its own rather than one somebody has to remember to close.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { zipSync } from 'fflate';

import { readJson, writeJsonAtomic } from './state.js';

/**
 * One or more safe path segments — the same charset `store/trials.ts` allows in `apps_path`,
 * for the same reason. `..` is rejected twice, by the character class and again by name,
 * because the first is easy to widen by accident when somebody adds a legal character.
 */
const UPLOAD_PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** An id this module minted. Guards every `rm` and every directory lookup. */
const UPLOAD_ID_RE = /^[a-f0-9]{12}$/;

/** How many sessions are kept. Debris from a debug loop, not an archive. */
const MAX_UPLOADS = 50;

export class UploadError extends Error {}

export interface UploadSession {
  /** Directory name under the uploads root. Not secret; it appears in the trial's slug. */
  id: string;
  /**
   * The credential. Unguessable, and the only thing standing between a caller and this
   * session's directory — so it is never logged and never put in a report.
   */
  token: string;
  /** The app these files are. One session, one subject: a trial is single-subject. */
  subject: string;
  /**
   * The **nominal** repo, carried as metadata and never fetched from for app content.
   *
   * `data/protocols/static.md` does not merely read the repo, it judges against it: the
   * `assets` item requires asset URLs point at `<repo>@main`, and `CONTRIBUTING.md` is "the
   * source of truth for what each item means". Drop the repo entirely and those two stop
   * meaning anything — the first throws a false Major on every asset URL, and the second
   * takes away the definition of every item. So the name survives; only the bytes are local.
   */
  repo: string;
  created_at: string;
  expires_at: string;
  /** Set when a trial has been run from this session, so the caller can be pointed at it. */
  trial_slug?: string;
}

export interface UploadFile {
  path: string;
  bytes: number;
}

interface UploadsFile {
  uploads: UploadSession[];
}

export interface UploadLimits {
  max_file_bytes: number;
  max_total_bytes: number;
  ttl_min: number;
}

/**
 * The sessions — `state/uploads.json` — and their directories under `<uploadsRoot>/<id>/`.
 *
 * Owns both, exactly as `TrialStore` owns a trial's row and its reports together: a cap that
 * forgets the row and leaves the directory is a disk leak wearing a retention policy's clothes,
 * and that lesson is already paid for once in this codebase.
 */
export class UploadStore {
  private readonly file: string;
  private sessions: UploadSession[] = [];

  constructor(
    stateDir: string,
    private readonly uploadsRoot: string,
    private readonly limits: UploadLimits,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(stateDir, 'uploads.json');
  }

  async load(): Promise<void> {
    const stored = await readJson<UploadsFile>(this.file, { uploads: [] });
    if (Array.isArray(stored?.uploads)) this.sessions = stored.uploads;
  }

  private dirOf(id: string): string {
    return path.join(this.uploadsRoot, id);
  }

  /** Never throws: a directory already gone must not stop the row being dropped. */
  private async removeFiles(id: string): Promise<void> {
    if (!UPLOAD_ID_RE.test(id)) return; // never rm a path this module did not mint
    try {
      await fs.rm(this.dirOf(id), { recursive: true, force: true });
    } catch (err) {
      console.error(`could not remove upload files for ${id}`, err);
    }
  }

  list(): UploadSession[] {
    return [...this.sessions].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id: string): UploadSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  /**
   * The session a token names, or undefined — including when it has lapsed.
   *
   * An expired token is treated as no token at all rather than as a distinguishable state:
   * "this session expired" and "there is no such session" are the same answer to anyone who
   * should not be holding it.
   */
  byToken(token: string): UploadSession | undefined {
    if (!token) return undefined;
    const found = this.sessions.find((s) => s.token === token);
    if (!found) return undefined;
    return this.expired(found) ? undefined : found;
  }

  expired(session: UploadSession): boolean {
    return Date.parse(session.expires_at) <= this.now().getTime();
  }

  async create(input: { subject: string; repo: string }): Promise<UploadSession> {
    const at = this.now();
    const session: UploadSession = {
      id: randomBytes(6).toString('hex'),
      token: randomBytes(24).toString('base64url'),
      subject: input.subject,
      repo: input.repo,
      created_at: at.toISOString(),
      expires_at: new Date(at.getTime() + this.limits.ttl_min * 60_000).toISOString(),
    };
    const next = [session, ...this.sessions];
    for (const evicted of next.slice(MAX_UPLOADS)) await this.removeFiles(evicted.id);
    this.sessions = next.slice(0, MAX_UPLOADS);
    await fs.mkdir(this.dirOf(session.id), { recursive: true });
    await this.persist();
    return session;
  }

  /**
   * Resolve one file inside a session, refusing anything that would leave it.
   *
   * Checked twice on purpose — the pattern, then the resolved path against the root. The
   * pattern is the rule; the resolve is what catches a rule that turns out to have a hole in
   * it, which is the same belt-and-braces `store/index.ts` uses on the reports root.
   */
  private resolve(session: UploadSession, relPath: string): string {
    const rel = relPath.replace(/^\/+/, '');
    if (!UPLOAD_PATH_RE.test(rel) || rel.includes('..')) {
      throw new UploadError('path must be plain segments inside the session, with no ".."');
    }
    const root = this.dirOf(session.id);
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new UploadError('path escapes the session directory');
    }
    return abs;
  }

  async put(session: UploadSession, relPath: string, data: Buffer): Promise<UploadFile> {
    const abs = this.resolve(session, relPath);
    if (data.byteLength > this.limits.max_file_bytes) {
      throw new UploadError(
        `that file is ${data.byteLength} bytes and the limit is ${this.limits.max_file_bytes}`,
      );
    }
    // Counted against what is already there, minus whatever this call replaces — otherwise
    // re-uploading one file in a loop walks a session into its own ceiling.
    const existing = await this.manifest(session);
    const replaced = existing.find((f) => path.resolve(this.dirOf(session.id), f.path) === abs);
    const total = existing.reduce((sum, f) => sum + f.bytes, 0) - (replaced?.bytes ?? 0);
    if (total + data.byteLength > this.limits.max_total_bytes) {
      throw new UploadError(
        `that would put the session over ${this.limits.max_total_bytes} bytes in total`,
      );
    }

    await fs.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, abs);
    return { path: path.relative(this.dirOf(session.id), abs).split(path.sep).join('/'), bytes: data.byteLength };
  }

  async del(session: UploadSession, relPath: string): Promise<boolean> {
    const abs = this.resolve(session, relPath);
    try {
      await fs.unlink(abs);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  /** Every file in the session, relative paths with forward slashes, sorted. */
  async manifest(session: UploadSession): Promise<UploadFile[]> {
    const root = this.dirOf(session.id);
    const out: UploadFile[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return; // a session with nothing in it yet is the normal state
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
          continue;
        }
        if (!entry.isFile() || entry.name.includes('.tmp-')) continue;
        const stat = await fs.stat(abs);
        out.push({ path: path.relative(root, abs).split(path.sep).join('/'), bytes: stat.size });
      }
    };
    await walk(root);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /** One file as text, or null. Used to inline the compose into the prompt. */
  async readText(session: UploadSession, relPath: string): Promise<string | null> {
    try {
      return await fs.readFile(this.resolve(session, relPath), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * The session as a **store** zip a demo bench can install from.
   *
   * Maison takes the store as a parameter — `POST /api/store/<app>/install?store=<zip url>` —
   * and its default is a GitHub archive, which always wraps everything in a single
   * `<repo>-<ref>/` directory. Reproducing that shape is what makes this work without knowing
   * whether Maison strips one level or searches for `Apps/` at any depth: the only layout that
   * could fail is `Apps/` at the root, and that would break Maison's own default.
   *
   * The point of a per-session URL is not tidiness. `data/protocols/functional.md` records
   * that Maison holds the store zip *in the running process* and re-reads it only on a refresh
   * or a restart, and that this cost a day on 2026-08-20 — two audits installed a pre-fix
   * compose from cache and blamed an app whose source was already fixed. A URL nothing has
   * ever fetched cannot be served from a cache.
   */
  async zipStore(session: UploadSession): Promise<Buffer> {
    const files = await this.manifest(session);
    const root = `AppStore-trial-${session.id}`;
    const entries: Record<string, Uint8Array> = {};
    for (const file of files) {
      const bytes = await fs.readFile(this.resolve(session, file.path));
      entries[`${root}/Apps/${session.subject}/${file.path}`] = new Uint8Array(bytes);
    }
    return Buffer.from(zipSync(entries));
  }

  async setTrial(id: string, slug: string): Promise<void> {
    const found = this.get(id);
    if (!found) return;
    found.trial_slug = slug;
    await this.persist();
  }

  async remove(id: string): Promise<boolean> {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) return false;
    await this.removeFiles(id);
    await this.persist();
    return true;
  }

  /**
   * Drop lapsed sessions and their files. Called at boot and after each session is opened, so
   * nothing depends on a timer that a restart would forget.
   */
  async sweepExpired(): Promise<string[]> {
    const lapsed = this.sessions.filter((s) => this.expired(s));
    for (const session of lapsed) await this.removeFiles(session.id);
    if (lapsed.length > 0) {
      this.sessions = this.sessions.filter((s) => !this.expired(s));
      await this.persist();
    }
    return lapsed.map((s) => s.id);
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, { uploads: this.sessions });
    } catch (err) {
      console.error('could not write uploads.json', err);
    }
  }
}
