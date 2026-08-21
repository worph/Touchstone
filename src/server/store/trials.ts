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
 * The list of trials — `state/trials.json`.
 *
 * Small and mutable, like every other `state/` file, and equally disposable: losing it costs
 * the list, not the reports, which are on disk under their slugs and still render.
 */
export class TrialStore {
  private readonly file: string;
  private trials: TrialRecord[] = [];

  constructor(private readonly stateDir: string) {
    this.file = path.join(stateDir, 'trials.json');
  }

  async load(): Promise<void> {
    const stored = await readJson<TrialsFile>(this.file, { trials: [] });
    if (Array.isArray(stored?.trials)) this.trials = stored.trials;
  }

  /** Newest first — a trial is looked at immediately after it is run, or not at all. */
  list(): TrialRecord[] {
    return [...this.trials].sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  get(slug: string): TrialRecord | undefined {
    return this.trials.find((t) => t.slug === slug);
  }

  async add(record: TrialRecord): Promise<void> {
    this.trials = [record, ...this.trials.filter((t) => t.slug !== record.slug)].slice(0, MAX_TRIALS);
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
