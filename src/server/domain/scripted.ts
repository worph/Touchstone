/**
 * One script run, one assay file — the executor-side twin of `assaysFromAgentReport`.
 *
 * The whole point of this module is that it is **generic**. It knows a section produced a
 * badge, some rows and some requirements; it does not know that a row is a container image or
 * that a badge counts releases. Everything specific to *what is being checked* lives in
 * `data/protocols/<id>.sh` and `data/protocols/<id>.md`, on the volume, where an operator can
 * change it without a rebuild. That is the property the whole design is for: the day there is
 * a second scripted check, nothing in `src/` needs to know it exists.
 *
 * Two rules it enforces on behalf of the invariants:
 *
 * - **The script does not declare a verdict.** For a scoring section the gate is computed here
 *   from the requirements the script recorded — any Critical is non-compliant, unconditionally
 *   (invariant 6). For a non-scoring one there is no verdict at all: `currency` measuring that
 *   an image is 400 days behind is a fact about the world, not a finding against the app, and
 *   a `non-compliant` in that cell would be exactly the conflation `scores: false` exists to
 *   prevent.
 * - **A failure to look is `blocked`.** Whether the script said so itself (`status: blocked`,
 *   a rate-limited registry) or died on its own (`exit 1`, a missing `jq`), nothing about the
 *   subject is asserted. Invariant 4.
 */

import { maxSeverity } from './severity.js';
import { coverageOf } from '../services/ledger.js';
import type { ExecutorRef } from '../store/protocols.js';
import type { ScriptOutput, ScriptRun } from '../runner/exec.js';
import type { AssayMeta, RecordedRequirement, Section, Severity } from '../../shared/types.js';
import type { AssaySection } from './assay.js';

export interface ScriptedAssayInput {
  subject: string;
  origin?: string;
  section: AssaySection;
  /** What ran, and what it hashed to. Recorded so a changed procedure is visible. */
  executor: ExecutorRef;
  run: ScriptRun;
  /** From the protocol. False means the section measures rather than judges. */
  scores: boolean;
  startedAt: string;
  finishedAt: string;
  subjectRef?: string;
  /**
   * The git blob sha of the app's compose at the audited ref — `AssayMeta.subject_sha`.
   * Absent when the store offered none, which reads as "no version to compare".
   */
  subjectSha?: string;
  /** Which section carries the run's score, named so a blocked record can point at it. */
  scoredOn?: Section;
}

/** Why the run produced no reading, in the words the record should carry. */
function failureDetail(run: Extract<ScriptRun, { ok: false }>, file: string): string {
  switch (run.reason) {
    case 'timeout':
      return `\`${file}\` ${run.detail}, so it was stopped. The section is re-assayed on the next run`;
    case 'oversize':
      return `\`${file}\` ${run.detail}, which is more than an assay record can carry`;
    case 'parse':
      return `\`${file}\` finished but ${run.detail}`;
    case 'spawn':
      return `\`${file}\` could not be started: ${run.detail}`;
    case 'exit':
    default:
      return `\`${file}\` failed: ${run.detail}`;
  }
}

/**
 * A markdown table from whatever columns the executor asked for. Presentation only.
 *
 * Takes the shape rather than the whole output, so the fix brief can render the same table
 * out of an assay's frontmatter months later — one definition of how a reading looks, whether
 * it is being written or quoted.
 */
export function renderRows(output: {
  columns?: ScriptOutput['columns'];
  rows?: ScriptOutput['rows'];
}): string {
  const rows = output.rows ?? [];
  if (rows.length === 0) return '';
  // Declared columns win; absent, the union of the keys present, first-seen order — so a
  // script that forgets to declare them still renders something a human can read.
  const columns =
    output.columns ??
    [...new Set(rows.flatMap((r) => Object.keys(r)))].map((key) => ({ key, label: key, align: undefined }));
  const cell = (value: unknown, kind?: string): string => {
    if (value === null || value === undefined || value === '') return '—';
    // A file is read long after it was written, so a `since` column keeps its absolute date
    // here — the age is the web's job, where it can be recomputed on every render.
    const text = kind === 'since' ? String(value).slice(0, 10) : String(value);
    return text.replace(/\|/g, '\\|');
  };
  const head = `| ${columns.map((c) => c.label ?? c.key).join(' | ')} |`;
  const rule = `| ${columns.map((c) => (c.align === 'right' ? '---:' : '---')).join(' | ')} |`;
  const body = rows.map(
    (r) => `| ${columns.map((c) => cell(r[c.key], (c as { kind?: string }).kind)).join(' | ')} |`,
  );
  return [head, rule, ...body].join('\n');
}

function repoOf(subjectRef: string | undefined): string {
  const at = (subjectRef ?? '').indexOf('@');
  return at > 0 ? subjectRef!.slice(0, at) : 'Yundera/AppStore';
}

export function assayFromScript(input: ScriptedAssayInput): { meta: AssayMeta; body: string } {
  const { subject, section, executor, run, scores } = input;
  const repo = repoOf(input.subjectRef);
  const heading = `# ${repo} — ${subject} · ${section.name}`;
  const stamp =
    `> Produced by Touchstone at ${input.finishedAt} by \`${executor.file}\`` +
    ` (sha256 ${executor.sha256.slice(0, 12)}).`;

  const common = {
    subject,
    ...(input.origin ? { origin: input.origin } : {}),
    section: section.id,
    standard: section.standard.name,
    standard_sha256: section.standard.sha256,
    // Provenance for the *procedure*, beside the standard's version for the policy. Without
    // the hash an edit to the script would change every reading with nothing in the archive
    // to say the readings either side of it were produced differently — invariant 9, applied
    // to the half of the check that has no version number of its own.
    executor: executor.file,
    executor_sha256: executor.sha256,
    // Written only when false. Absent means "counts", which is every assay before this
    // existed — the default has to be the one that leaves the archive's meaning unchanged.
    ...(scores ? {} : { scores: false }),
    subject_ref: input.subjectRef ?? `Yundera/AppStore@main:Apps/${subject}`,
    ...(input.subjectSha ? { subject_sha: input.subjectSha } : {}),
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    produced_by: 'touchstone-runner',
  };

  // ── the check could not be performed ──────────────────────────────────────────────────
  if (!run.ok) {
    const detail = failureDetail(run, executor.file);
    return {
      meta: {
        ...common,
        status: 'blocked',
        verdict: null,
        top_severity: 'none',
        risk_score: 0,
        blocked_reason: `executor_${run.reason}`,
        blocked_detail: detail,
        ...(input.scoredOn ? { combined_score_on: input.scoredOn } : {}),
      } as unknown as AssayMeta,
      body: [
        heading,
        '',
        stamp,
        '',
        '## Not run',
        '',
        `${detail}.`,
        '',
        'This is a statement about the check, not about the app. Nothing here counts for or',
        'against the subject, and the run cost it no retry.',
        '',
        ...(run.stderr ? ['```', run.stderr.slice(0, 4_000), '```', ''] : []),
      ].join('\n'),
    };
  }

  const { output } = run;

  if (output.status === 'blocked') {
    const why = output.reason ?? 'the check could not reach what it needed to read';
    return {
      meta: {
        ...common,
        status: 'blocked',
        verdict: null,
        top_severity: 'none',
        risk_score: 0,
        blocked_reason: 'executor_blocked',
        blocked_detail: why,
        ...(output.badge ? { badge: output.badge } : {}),
        badge_state: output.badge_state ?? 'unknown',
        ...(input.scoredOn ? { combined_score_on: input.scoredOn } : {}),
      } as unknown as AssayMeta,
      body: [
        heading,
        '',
        stamp,
        '',
        '## Not measured',
        '',
        `${why}.`,
        '',
        'This is a statement about the environment, not about the app. The reading is unknown,',
        'which is deliberately not the same as "current" — nothing was learned either way.',
        '',
      ].join('\n'),
    };
  }

  // ── a reading ─────────────────────────────────────────────────────────────────────────
  const requirements: RecordedRequirement[] = (output.requirements ?? []).map((r) => ({
    ...r,
    section: section.id,
    at: input.finishedAt,
  }));
  const coverage = requirements.length > 0 ? coverageOf(requirements) : null;
  const failed = requirements.filter((r) => r.verdict === 'fail');
  const tier: Severity = maxSeverity(failed.map((r) => r.severity ?? 'minor'));

  const table = renderRows(output);
  const body = [
    heading,
    '',
    stamp,
    '',
    `## ${section.name}`,
    '',
    ...(output.summary ? [output.summary, ''] : []),
    ...(output.body ? [output.body.trim(), ''] : table ? [table, ''] : []),
  ].join('\n');

  return {
    meta: {
      ...common,
      status: 'done',
      // A section that measures states no verdict. One that judges gets the gate computed
      // here from what it recorded — never from anything the script declared, because it is
      // not allowed to declare one.
      verdict: scores ? (failed.length > 0 ? 'non-compliant' : 'compliant') : null,
      top_severity: scores ? tier : 'none',
      risk_score: scores && coverage ? coverage.risk : 0,
      blocked_reason: null,
      ...(output.badge ? { badge: output.badge } : {}),
      ...(output.badge_state ? { badge_state: output.badge_state } : {}),
      ...(output.summary ? { summary: output.summary } : {}),
      ...(output.columns ? { columns: output.columns } : {}),
      ...(output.rows ? { rows: output.rows } : {}),
      ...(coverage ? { coverage } : {}),
      ...(requirements.length > 0 ? { requirements } : {}),
    } as unknown as AssayMeta,
    body,
  };
}
