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
 * `repo`, `ref` and `apps_path` arrive in an HTTP body and are interpolated into a prompt the
 * agent runs `gh` against, so they are validated here rather than trusted downstream.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { TrialRecord } from '../../shared/trials.js';
import { readJson, writeJsonAtomic } from './state.js';

/** `owner/name`. GitHub's own charset, and nothing that could leave the path. */
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A branch, tag or SHA. Slashes are legal in refs (`release/1.2`); `..` never is. */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/;
/** One or more safe path segments. */
const PATH_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
/** An app directory name. */
const SUBJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class TrialInputError extends Error {}

export interface ValidatedTrial {
  repo: string;
  ref: string;
  apps_path: string;
  subject: string;
}

/**
 * Check what arrived on the wire.
 *
 * Rejecting `..` twice — once by the character class, once explicitly — is deliberate: the
 * first is easy to widen by accident when somebody adds a legal character to a ref.
 */
export function validateTrial(input: {
  repo?: unknown;
  ref?: unknown;
  apps_path?: unknown;
  subject?: unknown;
}): ValidatedTrial {
  const repo = String(input.repo ?? '').trim();
  const ref = String(input.ref ?? '').trim();
  const appsPath = String(input.apps_path ?? 'Apps').trim().replace(/^\/+|\/+$/g, '') || 'Apps';
  const subject = String(input.subject ?? '').trim();

  if (!REPO_RE.test(repo)) throw new TrialInputError('repo must be owner/name');
  if (!REF_RE.test(ref) || ref.includes('..')) throw new TrialInputError('ref is not a valid git ref');
  if (!PATH_RE.test(appsPath) || appsPath.includes('..')) {
    throw new TrialInputError('apps_path must be a plain path inside the repo');
  }
  if (!SUBJECT_RE.test(subject)) throw new TrialInputError('subject must be an app directory name');

  return { repo, ref, apps_path: appsPath, subject };
}

/**
 * `Acme-AppStore@pr-812-2026-08-20T19-00-00Z`.
 *
 * Doubles as the synthetic origin id, so it must contain neither `/` (it is one path segment
 * and one URL segment) nor `~` (that separates an origin from a subject). The timestamp is
 * what makes re-running the same ref a second trial rather than an overwrite — two runs of one
 * branch are two results, and which one is current is a question about *this* PR, not about a
 * subject, so nothing here needs the archive's "latest wins" rule.
 */
export function trialSlug(v: ValidatedTrial, at: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${safe(v.repo)}@${safe(v.ref)}-${at.replace(/[:.]/g, '-')}`;
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

  /** Newest first — a trial is looked at immediately after it is run, or not at all. */
  list(): TrialRecord[] {
    return [...this.trials].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  get(slug: string): TrialRecord | undefined {
    return this.trials.find((t) => t.slug === slug);
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
