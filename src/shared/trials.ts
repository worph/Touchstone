/**
 * Trials — auditing a ref without touching what a subject carries.
 *
 * A **trial** runs the same protocol through the same runner against an arbitrary `repo@ref`,
 * and writes under `data/trials/` — a tree the report index is never handed. That is the whole
 * design: a hallmark is the verdict a subject carries until the next assay contradicts it, and
 * an unmerged branch has earned nothing. A trial therefore cannot move a hallmark, cannot enter
 * the backlog, and cannot consume a retry.
 *
 * It exists for the PR case: audit `contributor/AppStore@pr-812` and compare it against what
 * the subject currently carries, before deciding whether to merge. `AppStore PR Review` stays
 * in n8n and keeps the labels, the comment and the publishing; this is the executor it could
 * call, and nothing calls it until somebody wires it.
 *
 * **A trial is static-only unless it can serve its own subject.** A bench installs from the
 * store the box is configured with, not from the thing under trial, so a functional result
 * would be about `main` while carrying the trial's name. That is why the section is recorded
 * `blocked` with reason `store_not_installable` — invariant 4's shape: a statement about the
 * environment, never about the subject.
 *
 * Since 2026-08-22 that is **conditional rather than permanent**, which was always the named
 * follow-on. Maison takes its store as a parameter (`?store=<zip url>`), so a trial that can
 * publish its subject as a store hands the bench one and the objection disappears: the thing
 * installed and the thing audited are the same bytes. An *upload* trial can, because its files
 * are already on this disk; it needs `config.trials.public_base_url`, since the bench fetches
 * over the public internet. A *ref* trial still cannot, and still blocks.
 *
 * The per-trial URL removes a second failure the protocol records separately: Maison caches the
 * store zip in-process and re-reads it only on a refresh or a restart, which on 2026-08-20 had
 * two audits install a pre-fix compose and blame an app whose source was already fixed. A URL
 * minted per trial has never been fetched by anything, so there is nothing cached to serve.
 */

/** One recorded trial. The reports themselves live under `data/trials/<slug>/`. */
export interface TrialRecord {
  /** Filesystem- and URL-safe, and the synthetic origin its reports are filed under. */
  slug: string;
  /**
   * Where the files came from. Absent means `ref`, which is every trial written before
   * uploads existed.
   *
   * `upload` does not make `repo` and `ref` decorative — they are nominal but load-bearing,
   * because `static.md` resolves the asset rule against `<repo>@main` and reads that repo's
   * `CONTRIBUTING.md` as the definition of every checklist item. What changes is only where
   * the app's own bytes came from.
   */
  kind?: 'ref' | 'upload';
  /** The session those files were written into, for an `upload` trial. */
  upload_id?: string;
  repo: string;
  ref: string;
  apps_path: string;
  /** The bare app name audited. A trial is single-subject — see below. */
  subject: string;
  /**
   * The subject key this trial is *about*, when it names an app that exists in a real store.
   *
   * Used only to put the trial's verdict beside the one the subject currently carries. Absent
   * when the branch adds an app the store does not have yet, which is a normal PR.
   */
  compare_to?: string;
  started_at: string;
  finished_at?: string;
  outcome?: 'verdict' | 'error' | 'blocked' | 'agent_busy';
  verdict?: string | null;
  top_severity?: string;
  risk_score?: number;
  /** Paths relative to the trials root. */
  files?: string[];
  error?: string;
}

/**
 * What `POST /trials` accepts.
 *
 * **Single-subject on purpose.** A whole-store trial is N serialised jobs, which is a queue,
 * and invariant 8 says there is no queue: the backlog is re-derived every tick so it cannot
 * drift, and a second list of pending work would be the drift.
 */
export interface TrialRequest {
  repo: string;
  ref: string;
  apps_path?: string;
  subject: string;
}

/** One section's result, beside what the subject currently carries. */
export interface TrialComparison {
  section: string;
  trial: { status: string; verdict: string | null; top_severity: string; risk_score: number } | null;
  /** The subject's current hallmark for this section, or null if it has none. */
  current: { status: string; verdict: string | null; top_severity: string; risk_score: number } | null;
}

export interface TrialResponse {
  trial: TrialRecord;
  comparison: TrialComparison[];
}
