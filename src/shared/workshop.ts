/**
 * The workshop — proposals to fix, update or add an app, opened as pull requests.
 *
 * docs/auto-app-pr.md is the design. The one rule every type here serves: **the workshop
 * never judges its own work.** A proposal's verdicts are trials (written where the report
 * index never looks), so nothing on this page can move a hallmark; a hallmark moves when a
 * person merges the PR and the ordinary loop audits what the store then offers.
 */

import type { SubjectKey } from './subject.js';

/** What a proposal is for. One app per proposal, one proposal per PR. */
export type ProposalKind = 'fix' | 'currency' | 'wish';

/**
 * Where a proposal is.
 *
 * `queued` → `authoring` → `validating` → `ready` → `submitted` → `merged` | `closed`, with
 * `revising` looping a failed validation back to `authoring`. `failed`, `cannot` and
 * `discarded` are ends: `cannot` is the agent's honest "this cannot be done in a listing",
 * `discarded` means the store moved under it (or the operator threw it away) and costs the task
 * nothing.
 */
export type ProposalState =
  | 'queued'
  | 'authoring'
  | 'validating'
  | 'revising'
  | 'ready'
  | 'submitted'
  | 'merged'
  | 'closed'
  | 'failed'
  | 'cannot'
  | 'discarded';

/** `operator` — somebody pressed Propose; `idle` — the workshop picked it for itself. */
export type ProposalClass = 'operator' | 'idle';

/** One validation trial a proposal enqueued. */
export interface ProposalTrial {
  round: number;
  target: string;
  slug: string;
  /** Free re-enqueues after an infra outcome; capped. */
  retry?: number;
}

/** One scoring section's result, as validation read it back. Quoted into the PR body. */
export interface SectionResult {
  section: string;
  target?: string;
  status: 'done' | 'blocked' | 'running' | 'missing';
  verdict: string | null;
  risk_score: number | null;
  blocked_reason?: string;
  standard_sha256?: string;
  trial: string;
  /** Evidence copy of the report under the proposal's own directory. */
  evidence?: string;
}

/** A failing requirement, for the "before / after" table of a fix PR. */
export interface FindingRow {
  section: string;
  id: string;
  severity: string | null;
  requirement?: string;
}

export interface ProposalPr {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  opened_at: string;
  closed_at?: string;
}

export interface Proposal {
  id: string;
  kind: ProposalKind;
  /** `fix:<subject key>`, `currency:<subject key>`, `wish:<file>`. What memory is keyed by. */
  task_key: string;
  /** The `Apps/<app>/` directory name. */
  app: string;
  /** The subject it is about — absent for a wish, which is not a subject yet. */
  subject?: SubjectKey;
  wish_file?: string;
  origin: string;
  class: ProposalClass;
  asked_at: string;
  by?: string;
  /** What the task was about when it was tried — see `TaskMemory`. */
  input_sha: string;
  /** The commit the working copy was built on, and the app's tree sha there (null for a wish). */
  base_sha?: string;
  app_tree_sha?: string | null;
  round: number;
  max_rounds: number;
  state: ProposalState;
  reason?: string;
  /** The author's own account of what it changed — the first section of the PR body. */
  summary?: string;
  trials: ProposalTrial[];
  validation?: SectionResult[];
  before_findings?: FindingRow[];
  /** `major` when a currency proposal crosses a major version (best effort). */
  major?: boolean;
  /** For a currency proposal: the version it moves to, when one could be named. */
  to_version?: string;
  ref?: string;
  pr?: ProposalPr;
  /** Times an infra condition sent it back with no charge. */
  infra_retries: number;
  /** Times a restart interrupted an authoring session. */
  interrupted: number;
  /** An infra outcome holds the proposal until this time, so a kick cannot spin. */
  backoff_until?: string;
  started_at?: string;
  created_at: string;
  updated_at: string;
}

/** What `memory` remembers about a task. **Infra is never stored** — invariant 3. */
export type TaskOutcome = 'pr_opened' | 'pr_closed' | 'cannot' | 'failed_validation';

export interface TaskMemory {
  input_sha: string;
  attempts: number;
  last_attempt_at: string;
  outcome: TaskOutcome;
  reason?: string;
  proposal_id?: string;
  pr_url?: string;
}

/** The GitHub identity, as the probe last saw it. */
export interface GitHubStatus {
  state: 'unconfigured' | 'ok' | 'failing' | 'unknown';
  repo?: string;
  login?: string;
  expected_login?: string;
  push?: boolean;
  label?: boolean;
  problems: string[];
  checked_at?: string;
}

/** One thing the workshop could work on, and why it is or is not eligible. */
export interface CandidateRow {
  task_key: string;
  kind: ProposalKind;
  label: string;
  app: string;
  subject?: SubjectKey;
  wish_file?: string;
  input_sha: string;
  eligible: boolean;
  reasons: string[];
  rank: number;
}

/** One wishlist file. */
export interface Wish {
  file: string;
  name: string;
  image: string;
  order?: number;
  body: string;
  sha256: string;
  /** Why this file cannot be used as written. */
  problem?: string;
}

export interface WishRow extends Wish {
  memory?: TaskMemory;
  offered: boolean;
}

/** The proposal in flight, for the shell strip and the queue. */
export interface WorkshopLive {
  id: string;
  app: string;
  kind: ProposalKind;
  state: ProposalState;
  round: number;
  started_at?: string;
}

export interface ProposalSummary extends Proposal {
  diff?: { added: number; modified: number; deleted: number };
}

export interface WorkshopView {
  configured: boolean;
  /** Why not, when not. */
  unconfigured_reason?: string;
  github: GitHubStatus;
  /**
   * Where the token in use came from: `page` (set on the Workshop page, `data/github-token`),
   * `boot` (`github.token` / `TOUCHSTONE_GITHUB_TOKEN`), or null for none. Never the token.
   */
  github_token: {
    source: 'page' | 'boot' | null;
    set_at?: string;
    /** Whether the page may set one at all. */
    settable: boolean;
    /** Whether clearing the page's token falls back to a config/env one. */
    boot_token: boolean;
  };
  origin: string;
  armed: boolean;
  prs_per_day: number;
  quota: { allowed: boolean; next_slot_at?: string; opened_last_24h: number };
  live?: WorkshopLive;
  proposals: ProposalSummary[];
  candidates: CandidateRow[];
  memory: Record<string, TaskMemory>;
  wishlist: WishRow[];
  /** Apps with an open PR by anybody, or null when that could not be read. */
  open_pr_apps: string[] | null;
}

export interface DiffFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  bytes: number;
  /** Text of both sides when both are small UTF-8; absent for binary. */
  before?: string;
  after?: string;
}

export interface ProposalDetail {
  proposal: ProposalSummary;
  files: DiffFile[];
  feedback?: string;
}
