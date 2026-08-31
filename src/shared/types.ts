/**
 * The MVP-0 contract. Frozen — streams A, B and C all code against this file.
 * See MVP.md § Contracts.
 */

import type { SubjectKey } from './subject.js';

export type { SubjectKey };

/**
 * A **section** of the protocol — one leaf rubric, and one assay file.
 *
 * The id is the leaf protocol's own `id` (`data/protocols/<id>.md`), so the set of sections
 * is whatever the protocol directory declares. It used to be a two-value union called `Leg`
 * (`static | functional`) hard-coded here, which meant a third rubric could not exist and a
 * rename was a code change. Nothing in the server enumerates sections any more: they come
 * from the protocol files, and everything downstream carries the id it was given.
 *
 * The one rule that does not relax: **only a protocol file may define a section.** An id an
 * agent invents is recorded against the run's primary section and marked `unlisted` — it
 * never mints a new one, or a run could route a Critical into a section the gate ignores.
 */
export type Section = string;

/**
 * @deprecated The old name for {@link Section}, still used by the two-column Overview and by
 * report files written before the rename. New code says `section`.
 */
export type Leg = 'static' | 'functional';

/** Ordered: comparisons rely on SEVERITY_RANK, never on string order. */
export type Severity = 'none' | 'minor' | 'major' | 'critical';

export type Verdict = 'compliant' | 'non-compliant' | 'errored' | 'deferred';

/** `blocked` means infra prevented the assay. It is never a statement about the subject. */
export type AssayStatus = 'done' | 'blocked' | 'running';

export const SEVERITY_RANK: Record<Severity, number> = {
  none: 0,
  minor: 1,
  major: 2,
  critical: 3,
};

export type RequirementVerdict = 'pass' | 'fail' | 'n-a' | 'unverified';

/** One requirement the agent settled and recorded while it worked. */
export interface RecordedRequirement {
  id: string;
  /**
   * The section that owns this requirement — the leaf protocol that listed the id.
   *
   * Resolved by the ledger from the canonical list, so a canonical id needs no help from the
   * agent. Only an `unlisted` id can carry a section the agent supplied, and only when that
   * section already exists.
   */
  section?: Section;
  /** The agent's own wording, kept as the evidence for the id it chose. */
  requirement?: string;
  verdict: RequirementVerdict;
  severity?: Severity;
  note?: string;
  /** The protocol does not list this id. Recorded anyway — that is how the list is corrected. */
  unlisted?: boolean;
  at: string;
  revisions?: number;
}

export interface RecordedPhase {
  phase: string;
  /** The section whose phase plan names this phase. */
  section?: Section;
  result: 'pass' | 'fail' | 'errored' | 'n-a';
  note?: string;
  at: string;
}

/**
 * How much of the checklist was actually checked — **not** whether the subject complies.
 *
 * The verdict is gated on severity: one Critical outranks fifteen passes, and no count can
 * express that. Reporting them as one number would be the mistake this type exists to avoid.
 */
export interface Coverage {
  /** pass + fail — the questions that got an answer. */
  verified: number;
  /** pass + fail + unverified — the questions that applied. */
  applicable: number;
  passed: number;
  failed: number;
  unverified: number;
  not_applicable: number;
  /** Summed from the declared items with the protocol's weights: 100·C + 10·M + 1·m. */
  risk: number;
}

/** Exactly the YAML frontmatter of a report file. */
export interface AssayMeta {
  /**
   * The **bare** app name, as it has always been. Not the key — `AssayRecord.subject` is that.
   *
   * The pair `(origin, subject)` is the identity; keeping this half bare means the frontmatter
   * contract barely moved and no report file had to be rewritten.
   */
  subject: string;
  /**
   * Which store the subject came from — `store/config.ts`'s `origins[].id`.
   *
   * Filled in by `coerceMeta` when absent, exactly as `leg` → `section` is, so every assay
   * written before origins existed reads as belonging to `DEFAULT_ORIGIN`. Deriving it from the
   * directory instead would make a moved file a different assay and contradict the rule that
   * the record *is* the frontmatter.
   */
  origin?: string;
  /** Which section of the protocol this assay is. `parseReportMeta` guarantees it. */
  section: Section;
  /** The pre-rename spelling of `section`, still on every file written before 2026-08-20. */
  leg?: Section;
  standard: string;
  /**
   * **The revision of the standard that judged this** — the sha256 of the protocol file, as
   * it was when the run read it. Invariant 9.
   *
   * A hash rather than a number because the number could not be dereferenced: the archive
   * said `v7` and no v7 survived an edit. `store/revisions.ts` keeps the bytes, so this
   * resolves. Absent on anything written before 2026-08-23.
   */
  standard_sha256?: string;
  /**
   * @deprecated The integer the protocol carried in its own frontmatter until 2026-08-23.
   *
   * Read, never written. Every assay in the archive from before the cutover has one, and an
   * app author looking at an older verdict is entitled to see what it says — it just cannot
   * be turned back into the text it named.
   */
  standard_version?: number;
  /**
   * **The knowledge base the agent was reading**, as a digest over the pages it was given.
   *
   * Not a standard, and deliberately not treated as one: the KB never judges, so this puts no
   * `older standard` chip on a row and never makes a subject eligible for re-audit — an edit
   * to a reference page must not spend three days of agent time re-running full audits, which
   * is the same argument invariant 12 makes for a `scores: false` reading.
   *
   * It is recorded because it can still change what an audit *concludes*. The digest answers
   * "was it the same material as today"; `data/kb/.history/`, which is time-ordered, answers
   * "what did it say when this ran". Absent when the volume has no KB, and on everything
   * written before 2026-08-28. A scripted section never has one: a script reads no prose.
   */
  kb_sha256?: string;
  status: AssayStatus;
  verdict: Verdict | null;
  top_severity: Severity;
  risk_score: number;
  blocked_reason?: string | null;
  subject_ref?: string;
  /**
   * **Which version of the subject this judged** — the git blob sha of the app's
   * `docker-compose.yml` in its origin, at the ref the audit read.
   *
   * The counterpart of `standard_sha256`: that one says which *rubric* reached the verdict,
   * this one says which *app* it was reached about. Without it the archive records the ref an
   * app came from (`subject_ref`) but not the version, so a verdict about a compose that has
   * since been rewritten is indistinguishable from a current one.
   *
   * A git blob **sha1**, GitHub's own identity for those bytes, and only ever compared
   * against another of the same kind — hence not `_sha256`, which would be a lie about what
   * it is. Absent on anything written before 2026-08-25, and on an app whose store offers no
   * compose at that path.
   */
  subject_sha?: string;
  commit?: string;
  images?: string[];
  /**
   * Who performed this assay, when it was not the agent — the `*.sh` the protocol named, and
   * the hash of what that file contained at the time.
   *
   * The hash is the procedure's version, exactly as `standard_sha256` is the rubric's. Both
   * resolve to bytes in the protocol history, so an operator who changes what a check does
   * cannot leave the archive claiming that two readings came from one procedure.
   */
  executor?: string;
  executor_sha256?: string;
  /**
   * **False when this section measures rather than judges.** Absent means it counts, which is
   * every assay written before scripted sections existed.
   *
   * A non-scoring assay is invisible to the hallmark: its risk is not summed and its finish
   * time does not age the subject. See `domain/hallmark.ts`.
   */
  scores?: boolean;
  /**
   * What a scripted section measured, in the shape it asked to be drawn in.
   *
   * Deliberately opaque to everything in `src/`: `badge` is a dozen characters for a table
   * cell, `rows` are whatever the check found and `columns` is how it wants them laid out.
   * Touchstone renders them; it does not interpret them, which is what lets a new check ship
   * as two files on the volume rather than as a release.
   */
  badge?: string;
  badge_state?: 'ok' | 'warn' | 'bad' | 'unknown';
  summary?: string;
  columns?: { key: string; label?: string; align?: 'left' | 'right'; kind?: 'since' }[];
  rows?: Record<string, string | number | boolean | null>[];
  started_at: string;
  finished_at: string;
  /** Present from 2026-08-19; absent on every assay imported before the runner existed. */
  coverage?: Coverage;
  requirements?: RecordedRequirement[];
  phases?: RecordedPhase[];
  /**
   * The sum of this run's recorded items, present **only when it disagreed** with the agent's
   * own `risk_score`.
   *
   * The declared number stays authoritative and stays in `risk_score` (invariant 1); this is
   * the other half of the disagreement, so both are legible on one record. Recording the
   * declared value here instead — which is what happened until 2026-08-23 — wrote the same
   * number twice and said nothing.
   */
  risk_score_computed?: number;
  /**
   * On the primary section, the sections whose risk `risk_score` includes. Absent on a
   * single-section run, and absent on every other section, which carries `combined_score_on`
   * pointing back here instead.
   *
   * `risk_score` is the whole run's; the sibling `coverage.risk` is this section's own. This
   * field is what says so on the record, rather than leaving the two to read as a
   * contradiction.
   */
  combined_score_of?: string[];
  /** On a non-primary section: which section carries this run's combined `risk_score`. */
  combined_score_on?: string;
  /** Unrecognised frontmatter keys, preserved verbatim across a read/write cycle. */
  [key: string]: unknown;
}

export interface AssayRecord {
  meta: AssayMeta;
  /**
   * Path relative to the reports root, e.g.
   * `yundera/OpenClaw/2026-08-05T09-14-22Z-static.md`.
   */
  path: string;
  /**
   * **Identity**, `<origin>~<name>` — what every lookup, map key and link uses.
   *
   * Note this is deliberately *not* `meta.subject`, which stays the bare name: `rec.subject` is
   * `yundera~OpenClaw` where `rec.meta.subject` is `OpenClaw`. Use `name` to render.
   */
  subject: SubjectKey;
  /** The origin half of the key, split out so callers do not re-parse. */
  origin: string;
  /** The bare app name — **the one to display**. Equal to `meta.subject`. */
  name: string;
  file: string;
}

/** One row of the Overview table. */
export interface SubjectState {
  /** Identity, `<origin>~<name>`. Links and lookups use this; nothing renders it. */
  name: SubjectKey;
  /** The origin id, for the badge the Overview draws once more than one is configured. */
  origin: string;
  /** The bare app name — every heading, cell, page title and notification renders this. */
  label: string;
  /**
   * The current assay per section — every section the archive knows about, not a fixed two.
   * `static` and `functional` below are the same records under their old names, kept while
   * the Overview still draws exactly two columns.
   */
  sections: Record<Section, AssayRecord | null>;
  static: AssayRecord | null;
  functional: AssayRecord | null;
  /** Sum of every section's latest risk score. Overview sorts by this, descending. */
  risk: number;
  /** Age in days of the most recent assay of any section; null if never assayed. */
  age_days: number | null;
  /**
   * Whether the standard that reached this row's verdicts is the one in force now.
   *
   * Absent on a subject with no verdict to qualify — a never-run row has nothing to be
   * out of date. See {@link StandardState}.
   */
  standard?: StandardState;
  /**
   * Whether the app this row judged is the app the store offers now.
   *
   * Deliberately a **second** field rather than a widened `standard`. The two say different
   * things to the person reading the board: `older` means *we will look at this again*, and
   * `changed` means *you changed this since we looked*. Collapsing them into one warning
   * would lose exactly the distinction an app author cares about.
   */
  subject_version?: SubjectVersionState;
  /**
   * The store no longer offers this app, and we know that because we could read the store.
   *
   * A third caveat, and a different kind from the two above: those qualify a verdict, this
   * one qualifies the *subject*. The verdicts stay true — they were reached about an app
   * that existed — but nobody can act on them and nothing will re-audit it, so a reader who
   * is not told will go on counting it among the apps that are failing.
   *
   * Absent rather than `false` when the app is on offer, and absent when the store could not
   * be read at all: "the store does not list it" and "we could not ask" are different claims,
   * and only the first is safe to draw a chip for. Set from
   * `SubjectRegistry.delisted()` — the archive on its own cannot know.
   */
  delisted?: boolean;
}

/**
 * How the app a verdict was reached about relates to the app the store offers now.
 *
 * - `current` — the compose is byte-for-byte what was judged.
 * - `changed` — it has been edited since. Unlike `older`, this is not a caveat about the
 *   wording of the question: the thing judged is not the thing shipping, so the verdict may
 *   be about a problem already fixed, or miss one just introduced.
 * - `unknown` — the assay predates version recording (2026-08-25), or the store offers no
 *   compose at that path, so there is nothing to compare. Never a trigger.
 */
export type SubjectVersionState = 'current' | 'changed' | 'unknown';

/**
 * How a verdict on display relates to the standard in force.
 *
 * - `current` — judged by the revision that would judge it again today.
 * - `older` — the rubric (or the script performing it) has changed since. The verdict is
 *   not wrong; it answers a question that has since been re-worded, which is a caveat and
 *   not a finding. The subject becomes eligible for re-audit without waiting out
 *   `fresh_days`, at its usual place in the backlog.
 * - `unknown` — the assay predates `standard_sha256` (2026-08-23) and names no revision, so
 *   there is nothing to compare. Deliberately not folded into `older`: "judged by something
 *   else" and "we cannot tell what judged this" are different claims, and the archive is
 *   entitled to say which one it is making.
 */
export type StandardState = 'current' | 'older' | 'unknown';

export interface ReportResponse {
  meta: AssayMeta;
  html: string;
  raw: string;
}
