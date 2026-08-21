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
 * **Trials are static-only.** `data/protocols/functional.md` installs from the bench's own
 * catalogue at `https://<DEMO>/store`, which serves whatever store that Maison box is
 * configured with — not the ref under trial. A functional result would be about `main` while
 * carrying the branch's name, so the functional section is recorded `blocked` with reason
 * `store_not_installable`. That is invariant 4's shape: a statement about the environment,
 * never about the subject. Repointing a bench's catalogue at a custom store URL is the
 * follow-on that would lift it.
 */

/** One recorded trial. The reports themselves live under `data/trials/<slug>/`. */
export interface TrialRecord {
  /** Filesystem- and URL-safe, and the synthetic origin its reports are filed under. */
  slug: string;
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
