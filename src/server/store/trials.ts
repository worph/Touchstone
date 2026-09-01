/**
 * The trial store: `data/trials/<slug>/<subject>/<ISO>-<section>.md`, plus an index of what
 * was run.
 *
 * Two things make this safe, and both are structural rather than a rule somebody must remember:
 *
 * 1. **A separate root, and a separate `ReportIndex` over it.** The scheduler and the subject
 *    registry are never handed that index, so "a trial cannot move a hallmark" holds by
 *    construction rather than by a predicate somebody can later forget. `server/index.ts:97`
 *    turns anything in the *main* index into a schedulable subject, which is precisely the
 *    door this closes.
 * 2. **The slug is the synthetic origin.** `reportRelPathFor` is unchanged and yields
 *    `<slug>/<Subject>/<ISO>-<section>.md`, so a trial's tree mirrors the archive's exactly —
 *    the viewer, the renderer and the frontmatter contract all work on it untouched.
 *
 * `store_url`, `subject` and `apps_path` arrive in an HTTP body. The URL is the one input this
 * process itself dereferences, so it is validated here and again against a host allowlist in
 * `services/trialstore.ts` before anything fetches it.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { TrialRecord } from '../../shared/trials.js';
import { readJson, writeJsonAtomic } from './state.js';

/** One or more safe path segments. */
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
/** An app directory name. */
const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class TrialInputError extends Error {}

export interface ValidatedTrial {
  store_url: string;
  apps_path: string;
  subject: string;
}

/**
 * Check what arrived on the wire.
 *
 * The URL is checked for *shape* only — that it parses and is `https:`. **Whether it may be
 * fetched is a separate question**, answered by the allowlist in `services/trialstore.ts`,
 * because this process dereferences it: a caller who can name a URL Touchstone will GET can
 * otherwise reach anything on the internal network. Two checks in two places because they are
 * two different questions, and collapsing them would make the second easy to lose.
 *
 * Rejecting `..` twice — once by the character class, once explicitly — is deliberate: the
 * first is easy to widen by accident when somebody adds a legal character.
 */
export function validateTrial(input: {
  store_url?: unknown;
  apps_path?: unknown;
  subject?: unknown;
}): ValidatedTrial {
  const storeUrl = String(input.store_url ?? '').trim();
  const appsPath = String(input.apps_path ?? 'Apps').trim().replace(/^\/+|\/+$/g, '') || 'Apps';
  const subject = String(input.subject ?? '').trim();

  let parsed: URL;
  try {
    parsed = new URL(storeUrl);
  } catch {
    throw new TrialInputError('store_url must be an absolute URL to a store zip');
  }
  if (parsed.protocol !== 'https:') {
    throw new TrialInputError('store_url must be https');
  }
  if (!PATH_RE.test(appsPath) || appsPath.includes('..')) {
    throw new TrialInputError('apps_path must be a plain path inside the store');
  }
  if (!SUBJECT_RE.test(subject)) throw new TrialInputError('subject must be an app directory name');

  return { store_url: parsed.toString(), apps_path: appsPath, subject };
}

/**
 * `FileBrowser@a1b2c3d4-2026-08-22T19-00-00-000Z`.
 *
 * Doubles as the synthetic origin id, so it must contain neither `/` (it is one path segment
 * and one URL segment) nor `~` (that separates an origin from a subject). The random half is
 * what makes two trials of the same app at the same instant two results rather than one
 * overwriting the other, and the timestamp is what makes the list readable in run order.
 *
 * It deliberately does **not** name where the archive came from. It used to — `repo@ref` for
 * one kind of trial and `upload@id` for the other — and that was the discriminator leaking
 * into the identity: two shapes of slug for what is now one shape of trial. The source is
 * recorded in `source_url`, which is where a fact about provenance belongs.
 */
export function trialSlug(subject: string, at: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe(subject) || 'trial'}@${randomBytes(4).toString('hex')}-${at.replace(/[:.]/g, '-')}`;
}

/** Rejects anything that is not a slug this module produced. */
export function isTrialSlug(value: string): boolean {
  return /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$/.test(value) && !value.includes('..');
}

interface TrialsFile {
  trials: TrialRecord[];
}

/** How many trials are kept. They are debris from reviewing a PR, not an archive. */
const MAX_TRIALS = 100;

/**
 * The list of trials — `state/trials.json` — and the reports under `<trialsRoot>/<slug>/`.
 *
 * The list is small, mutable and disposable like every other `state/` file. **The report
 * directories are not**, so this class owns both: a row and its directory are created together
 * and destroyed together. They were not, once — the row was capped at `MAX_TRIALS` and the
 * directory was left behind, so past a hundred trials the oldest directories became orphaned:
 * invisible in the UI, undeletable through it, and carried in every backup and uninstall
 * archive for good. Trials are debris from reviewing a PR; debris that cannot be swept is worse
 * than debris.
 */
export class TrialStore {
  private readonly file: string;
  private trials: TrialRecord[] = [];

  constructor(
    private readonly stateDir: string,
    /** Where the report directories live. One per slug, deleted with its row. */
    private readonly trialsRoot: string,
  ) {
    this.file = path.join(stateDir, 'trials.json');
  }

  async load(): Promise<void> {
    const stored = await readJson<TrialsFile>(this.file, { trials: [] });
    if (Array.isArray(stored?.trials)) this.trials = stored.trials;
  }

  /**
   * Delete one trial's reports. Never throws — a directory that is already gone, or that
   * cannot be removed, must not stop the row being dropped.
   */
  private async removeFiles(slug: string): Promise<void> {
    if (!isTrialSlug(slug)) return; // never rm a path this module did not mint
    try {
      await fs.rm(path.join(this.trialsRoot, slug), { recursive: true, force: true });
    } catch (err) {
      console.error(`could not remove trial reports for ${slug}`, err);
    }
  }

  /**
   * Remove report directories with no row — the orphans the old eviction left behind, plus
   * anything a crash between `rm` and `persist` stranded. Called once at boot.
   *
   * Deliberately conservative: it only removes directories whose names are slugs this module
   * would itself have minted, so an operator's own folder under `trials/` is never touched.
   */
  async sweepOrphans(): Promise<string[]> {
    const known = new Set(this.trials.map((t) => t.slug));
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(this.trialsRoot, { withFileTypes: true });
    } catch {
      return []; // no trials directory yet is the normal state
    }
    const removed: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || known.has(e.name) || !isTrialSlug(e.name)) continue;
      await this.removeFiles(e.name);
      removed.push(e.name);
    }
    return removed;
  }

  /**
   * Trials waiting for the agent, **oldest ask first** — the trial half of the request queue.
   *
   * The opposite order to `list()`, and both are right: a list is read newest-first because
   * the trial you just ran is the one you care about, and a queue is worked oldest-first
   * because that is what a queue is.
   *
   * This is the one part of the request queue that is genuinely stored rather than derived.
   * A subject request is a timestamp spent by comparison against an attempt record; a trial
   * has neither a subject row nor an attempt record to spend one against, so its place in the
   * line has to be a fact on disk. Invariant 8 is reframed rather than broken — see CLAUDE.md.
   */
  queued(): TrialRecord[] {
    return this.trials
      .filter((t) => t.queued_at && !t.began_at && !t.finished_at)
      .sort((a, b) => a.started_at.localeCompare(b.started_at));
  }

  /**
   * The trial the agent is working on, if any.
   *
   * At most one, because there is one agent. Returns the oldest if a bug ever produced two, so
   * that the queue view names something real rather than picking arbitrarily.
   */
  running(): TrialRecord | undefined {
    return this.trials
      .filter((t) => t.began_at && !t.finished_at)
      .sort((a, b) => a.started_at.localeCompare(b.started_at))[0];
  }

  /**
   * Close out trials that were running when the process stopped. Called once at boot.
   *
   * Nothing re-attaches to an in-flight `runner.run()` across a restart — the promise went with
   * the process — so before this existed such a row kept `started_at`, no `finished_at`, and
   * `get_trial` answered "it has not finished; ask again shortly" for ever. Under the request
   * queue that row would also have been indistinguishable from a *queued* one had `began_at`
   * not been added, which is the other half of why it exists.
   *
   * A **queued** row is deliberately left alone: it was never started, so a restart costs it
   * nothing and it should simply still be in the line when the scheduler looks.
   */
  async reconcile(at = new Date().toISOString()): Promise<string[]> {
    const stranded = this.trials.filter((t) => t.began_at && !t.finished_at);
    for (const t of stranded) {
      t.finished_at = at;
      t.outcome = 'error';
      t.error = 'Touchstone restarted while this trial was running';
    }
    // Rows written before trials were queued at all: `started_at`, no `began_at`, and no
    // `queued_at` to say they ever entered a queue. They are indistinguishable from a waiting
    // trial by shape alone, which is precisely why `queued_at` exists — without this pass the
    // first tick after the upgrade would dispatch every trial the old code ever stranded.
    // Closed once, at the first boot on the new version, and never seen again.
    const legacy = this.trials.filter((t) => !t.queued_at && !t.began_at && !t.finished_at);
    for (const t of legacy) {
      t.finished_at = at;
      t.outcome = 'error';
      t.error = 'This trial never finished, and predates the request queue';
    }
    if (stranded.length + legacy.length > 0) await this.persist();
    return [...stranded, ...legacy].map((t) => t.slug);
  }

  /** Newest first — a trial is looked at immediately after it is run, or not at all. */
  list(): TrialRecord[] {
    return [...this.trials].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  get(slug: string): TrialRecord | undefined {
    return this.trials.find((t) => t.slug === slug);
  }

  /**
   * The trial a store token names — how `GET /trialstore/:token.zip` finds what to serve.
   *
   * An unknown token and a lapsed trial are the same answer to whoever should not be holding
   * it, exactly as `UploadStore.byToken` treats an expired session.
   */
  byStoreToken(token: string): TrialRecord | undefined {
    if (!token) return undefined;
    return this.trials.find((t) => t.store_token === token);
  }

  /**
   * Where a trial's own copy of the archive lives.
   *
   * Inside the trial's directory on purpose, unlike `data/uploads/`: the report index only ever
   * picks up `*.md`, so a zip here is invisible to it, and `removeFiles` already deletes the
   * whole directory — so the store dies with the trial with no second thing to remember.
   */
  storeZipPath(slug: string): string {
    return path.join(this.trialsRoot, slug, 'store.zip');
  }

  async add(record: TrialRecord): Promise<void> {
    const next = [record, ...this.trials.filter((t) => t.slug !== record.slug)];
    // Whatever falls off the end loses its reports too. The cap is what makes trials debris
    // rather than an archive, and a cap that only forgets the row is a disk leak wearing a
    // retention policy's clothes.
    for (const evicted of next.slice(MAX_TRIALS)) await this.removeFiles(evicted.slug);
    this.trials = next.slice(0, MAX_TRIALS);
    await this.persist();
  }

  async update(slug: string, patch: Partial<TrialRecord>): Promise<TrialRecord | undefined> {
    const found = this.trials.find((t) => t.slug === slug);
    if (!found) return undefined;
    Object.assign(found, patch);
    await this.persist();
    return found;
  }

  async remove(slug: string): Promise<boolean> {
    const before = this.trials.length;
    this.trials = this.trials.filter((t) => t.slug !== slug);
    if (this.trials.length === before) return false;
    // Files first: a crash between the two leaves an orphan `sweepOrphans` collects at the next
    // boot, whereas dropping the row first and failing here leaves a directory nothing knows
    // about. Delete is the whole trial, not just its row — a trial is about a branch, and when
    // you are done with the branch you are done with the evidence.
    await this.removeFiles(slug);
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, { trials: this.trials });
    } catch (err) {
      console.error('could not write trials.json', err);
    }
  }
}
