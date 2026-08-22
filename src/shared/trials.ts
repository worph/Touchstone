/**
 * Trials — auditing a candidate store without touching what a subject carries.
 *
 * A **trial** runs the same protocol through the same runner against **one store zip and one
 * app inside it**, and writes under `data/trials/` — a tree the report index is never handed.
 * That is the whole design: a hallmark is the verdict a subject carries until the next assay
 * contradicts it, and an unmerged branch has earned nothing. A trial therefore cannot move a
 * hallmark, cannot enter the backlog, and cannot consume a retry.
 *
 * It exists for the PR case and for the fix loop: audit a branch's own store, or a working copy
 * that is on no branch at all, and compare the result against what the subject currently
 * carries. `AppStore PR Review` stays in n8n and keeps the labels, the comment and the
 * publishing; this is the executor it could call, and nothing calls it until somebody wires it.
 *
 * ## One input, because a store zip is already both halves of an audit
 *
 * Until 2026-08-22 a trial had two shapes: a `repo@ref` the static section fetched with `gh`,
 * and an upload session whose bytes were inlined. They needed different spec builders, slugs,
 * prompt branches and a `kind` discriminator, and — worse — a ref trial read its bytes from a
 * place the bench never installed from, which is exactly the disagreement `functional.md` v6
 * had to add a hand-written compose assertion to catch.
 *
 * A store zip removes the fork, because it is *both* halves at once: the files the static
 * section reads and the bytes the bench installs. Touchstone fetches it once, extracts
 * `<apps_path>/<subject>/` for the prompt, and hands the bench the very same archive. Whatever
 * produced the URL — a GitHub branch archive, an upload session — stops mattering past the
 * route, so there is one pipeline and one record.
 *
 * ## Every trial serves its own store, so nothing can be stale
 *
 * The archive is copied to the trial's own directory and re-served at an unguessable per-trial
 * URL, rather than the bench being pointed at wherever the caller got it. That is not tidiness.
 * `data/protocols/functional.md` records that Maison holds the store zip **in the running
 * process** and re-reads it only on a refresh or a restart, and that this cost a day on
 * 2026-08-20 — two audits installed a pre-fix compose from cache and blamed an app whose source
 * was already fixed. A URL minted per trial has never been fetched by anything, so there is
 * nothing cached to serve. Pointing the bench straight at a branch archive would reintroduce
 * that failure in a narrower form: the URL of a branch is stable across pushes.
 *
 * It also means `store_not_installable` is gone. A trial always has a store to install, so the
 * functional section is gated by the ordinary bench/browser capability probes and nothing else.
 * The one thing it needs is `config.trials.public_base_url` — the bench fetches over the public
 * internet and Touchstone cannot infer its own external address from an internal request.
 */

import type { AssayStatus, Severity, Verdict } from './types.js';

/** One recorded trial. The reports themselves live under `data/trials/<slug>/`. */
export interface TrialRecord {
  /** Filesystem- and URL-safe, and the synthetic origin its reports are filed under. */
  slug: string;
  /**
   * Where the archive came from, recorded so a result can be traced back to its source.
   *
   * **Not** what the bench installed from — that is always this trial's own copy. For an
   * upload trial there was no remote archive at all, and this reads `upload:<id>`.
   */
  source_url: string;
  /** The session the files came from, when they were uploaded rather than fetched. */
  upload_id?: string;
  /**
   * The unguessable name this trial's own copy of the archive is served under, at
   * `/api/v1/trialstore/<store_token>.zip`.
   *
   * A credential in the same sense an upload session's token is one: there is no account here,
   * and whoever holds it may fetch this trial's store. It grants only the app files the
   * operator already chose to audit, and the bench that must fetch them holds nothing else of
   * ours — the same trade `store/uploads.ts` documents. Absent when the trial could not be
   * given a store at all.
   */
  store_token?: string;
  /**
   * The **rubric anchor**, not a place any byte came from.
   *
   * `data/protocols/static.md` does not merely read a repo, it judges against one: the `assets`
   * item requires asset URLs point at `<repo>@main`, and that repo's `CONTRIBUTING.md` is "the
   * source of truth for what each item means". A trial with no repo at all would throw a false
   * Major on every asset URL and apply a rubric whose terms it could not look up. It is
   * resolved from the configured origins rather than supplied, because contribution rules
   * belong to the store, not to the branch under trial.
   */
  repo: string;
  /** Where the apps live inside the archive — `Apps` in the Yundera store. */
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
 *
 * Exactly one of `store_url` and `upload` is required. They are not two kinds of trial — an
 * upload session is a way of *producing* a store zip, and past the route the two are identical.
 */
export interface TrialRequest {
  /** A store zip a bench could install from — e.g. a GitHub branch or tag archive. */
  store_url?: string;
  /** An upload session id, whose files are zipped into a store instead. */
  upload?: string;
  /** Required with `store_url`; taken from the session for an upload. */
  subject?: string;
  apps_path?: string;
}

/**
 * One section's result, in the terms the status vocabulary is derived from.
 *
 * Deliberately the *same* facts `AssayMeta` carries rather than a summary of them, and typed
 * with the same unions rather than bare strings. A trial cell and an Overview cell are then
 * drawn by one function from one input, which is the only way the "Currently" column can be
 * trusted: it quotes a hallmark, so it has to render identically to the place that hallmark
 * is normally read.
 *
 * `blocked_reason` is the load-bearing addition. Since 2026-08-22 a section can block for four
 * different reasons -- a missing `trials.public_base_url`, an empty bench pool, a dead browser
 * sidecar, an unreadable store -- and `domain/assay.ts` writes a different sentence for each.
 * Dropping the reason here left the page guessing, and it guessed the same one every time.
 */
export interface TrialCell {
  status: AssayStatus;
  verdict: Verdict | null;
  top_severity: Severity;
  risk_score: number;
  /** Why infra prevented it. Only meaningful when `status` is `blocked`. */
  blocked_reason?: string | null;
  /** Invariant 9's record, and what the `compliant` hint cites. */
  standard?: string;
  standard_version?: number;
  started_at?: string;
}

/** One section's result, beside what the subject carries today. */
export interface TrialComparison {
  section: string;
  trial: TrialCell | null;
  /** The subject's current hallmark for this section, or null if it has none. */
  current: TrialCell | null;
}

export interface TrialResponse {
  trial: TrialRecord;
  comparison: TrialComparison[];
}
