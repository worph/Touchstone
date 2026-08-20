/**
 * One agent report, two assay files.
 *
 * The migration and the runner both turn a single `depth=full` report — one document
 * covering both legs — into one file per leg. They differ only in where the verdict comes
 * from, so the splitting, the phase reading and the body composition live here and the two
 * callers share them.
 *
 * The rule that survives both, ARCHITECTURE principle 3: **the assay's own declaration is
 * authoritative.** The importer reads it off the published headline; the runner takes it
 * from the JSON the agent returned under contract, which is what the headline was generated
 * from. Neither derives a verdict from prose. An earlier importer did, and read eight of
 * twenty non-compliant subjects milder than their own headline.
 */

import type { AssayMeta, Leg, Severity, Verdict } from '../../shared/types.js';
import { coverageOf, type RecordedPhase, type RecordedRequirement } from '../services/ledger.js';
import { MANDATORY_PHASES, parsePhases, shapeReport } from './extract.js';

/**
 * Scope a combined `errored` verdict to the leg that actually caused it.
 *
 * This is the migration's half of ARCHITECTURE.md §2.5. A report reads `errored` whenever a
 * mandatory phase could not run, and in this corpus that phase is almost always functional
 * — the bench was down. DocmostMCP says so in as many words: *"`non-compliant` would
 * wrongly attribute an infra outage to DocmostMCP, even though the static half
 * independently found a Major fail"*, and its own headline still carries `Major · risk 12`
 * from the static findings that did complete.
 *
 * So when the functional leg never ran, `errored` is not a statement about the static leg
 * and must not be copied onto it: the static leg stands on its own tier. When the
 * functional leg *did* run, an `errored` headline means something else failed and is left
 * alone.
 */
export function scopeVerdict(
  verdict: Verdict | null,
  tier: Severity,
  functionalRan: boolean,
): Verdict | null {
  if (verdict !== 'errored' || functionalRan) return verdict;
  return tier === 'none' ? 'compliant' : 'non-compliant';
}

export function blockedReasonDetail(section: string): string | null {
  const patterns: [RegExp, string][] = [
    [/401/, 'demo pool rejected every published credential (HTTP 401 on both identity providers)'],
    [/no-demo-available|both hosts have been in .{0,10}Error|demo pool.{0,30}(down|outage)/i, 'no demo instance in a Ready state'],
    [/AppShield .{0,10}SSO failure|HTTP 500/i, 'demo host SSO returned 500'],
    [/browser|CDP/i, 'browser session could not be established'],
  ];
  for (const [re, text] of patterns) if (re.test(section)) return text;
  return null;
}

/**
 * The body of an imported report. The source page is one document covering both legs, so
 * each file carries a provenance header, the shared preamble, its own leg verbatim, and the
 * shared closing sections. Nothing from the source is rewritten — a reader comparing this
 * against Docmost should see the same words.
 */
export function composeBody(
  subject: string,
  leg: Leg,
  shape: ReturnType<typeof shapeReport> | null,
  sourceUrl: string | null,
  page: string | null,
  /** Overrides the import provenance line — the runner is not importing anything. */
  provenance?: string,
): string {
  const parts: string[] = [];
  parts.push(`# Yundera/AppStore — ${subject} · ${leg} leg\n`);
  parts.push(
    provenance ??
    (sourceUrl
      ? `> Imported from the combined audit report at ${sourceUrl}, which covers both legs.\n> The ${leg} section is reproduced below verbatim.\n`
      : `> No per-app report page exists for ${subject}; this assay is reconstructed from the\n> roll-up index row alone.\n`),
  );
  if (shape?.preamble) parts.push(shape.preamble);
  const section = leg === 'static' ? shape?.staticSection : shape?.functionalSection;
  if (section) parts.push(section.text.trim());
  else if (page) parts.push(`## ${leg === 'static' ? 'Tech & Documentation' : 'Functionality'}\n\n_The source report has no ${leg} section._`);
  if (shape?.tail) parts.push(shape.tail);
  return `\n${parts.join('\n\n')}\n`;
}

// ── the runner's path ──────────────────────────────────────────────────────────────────

export interface Standard {
  name: string;
  version: number;
}

/** The agent's declaration, already parsed. Capitalised severity, as the contract states. */
export interface DeclaredResult {
  verdict: 'compliant' | 'non-compliant' | 'errored';
  severity: string;
  risk_score: number;
  report_markdown: string;
}

/**
 * The functional leg of a run that never got a bench — recorded rather than dropped.
 *
 * ARCHITECTURE principle 4: **legs are independent, and one unavailable resource degrades
 * one leg.** Until now a `depth=full` job with nothing leasable returned `blocked` before
 * the agent was even called, so a dead demo pool cost the *static* verdict too — the exact
 * conflation §2.2 exists to complain about, reintroduced one layer down.
 *
 * So the runner degrades to a static run and calls this for the half it could not do. The
 * result is the same pair of files any full run produces: a static assay standing on its own
 * merits, and a functional assay that says plainly why there is no verdict in it. `verdict`
 * is null and the severity is `none` because **nothing was learned about the subject** — a
 * blocked leg is a statement about the bench.
 */
export function blockedFunctionalAssay(input: {
  subject: string;
  standard: Standard;
  reason: string;
  startedAt: string;
  finishedAt: string;
  subjectRef?: string;
}): { meta: AssayMeta; body: string } {
  const { subject, standard, reason } = input;
  const why =
    reason === 'browser_unavailable'
      ? 'no browser sidecar was answering, so there was nothing to drive the install with'
      : 'no demo instance was usable — the pool was unreachable, mid-cleanup, or too close to its daily wipe';

  return {
    meta: {
      subject,
      leg: 'functional',
      standard: standard.name,
      standard_version: standard.version,
      status: 'blocked',
      verdict: null,
      top_severity: 'none',
      risk_score: 0,
      blocked_reason: reason,
      blocked_detail: why,
      combined_score_on: 'static',
      subject_ref: input.subjectRef ?? `Yundera/AppStore@main:Apps/${subject}`,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
      produced_by: 'touchstone-runner',
    } as AssayMeta,
    body: [
      `# Yundera/AppStore — ${subject} · functional leg`,
      '',
      `> Produced by Touchstone at ${input.finishedAt}.`,
      '',
      '## Not run',
      '',
      `The functional leaf could not be attempted: ${why}.`,
      '',
      'This is a statement about the environment, not about the app. No functional check was',
      'made, so nothing here counts for or against the subject, and the run cost it no retry.',
      'The static leg of this same run was completed and carries its own verdict.',
      '',
      'The leg is re-assayed when a bench is available again.',
      '',
    ].join('\n'),
  };
}

export interface AgentAssayInput {
  subject: string;
  declared: DeclaredResult;
  standards: { staticStd: Standard; functionalStd: Standard };
  startedAt: string;
  finishedAt: string;
  depth: 'static' | 'full';
  /** The bench the functional leg ran against, recorded so a result can be traced to a box. */
  benchHost?: string;
  /** The browser it drove. Same reason: a functional result is only as good as the pair. */
  browserEndpoint?: string;
  /**
   * What the agent recorded requirement by requirement while it worked.
   *
   * These are the record; the narrative body is the evidence for them. Coverage — how much of
   * the checklist actually got checked — is computed from these and stored beside the verdict,
   * because they answer different questions: one Critical outranks fifteen passes, and no
   * count can express that.
   */
  requirements?: RecordedRequirement[];
  phases?: RecordedPhase[];
  subjectRef?: string;
}

const TIERS: Record<string, Severity> = {
  critical: 'critical',
  major: 'major',
  minor: 'minor',
  none: 'none',
};

/**
 * Build the assay files for one completed run.
 *
 * `depth: 'static'` produces one file. `full` produces two, and the functional one is
 * `blocked` rather than `done` whenever no mandatory phase produced a real result — reading
 * `H — Cleanup | pass | nothing was installed` as a completed run is exactly the mistake
 * that turns a bench outage into a verdict about the app.
 */
export function assaysFromAgentReport(
  input: AgentAssayInput,
): { meta: AssayMeta; body: string }[] {
  const { subject, declared, standards, depth } = input;
  const shape = shapeReport(declared.report_markdown);
  const tier = TIERS[String(declared.severity).toLowerCase()] ?? 'none';

  const phases = shape.functionalSection ? parsePhases(shape.functionalSection.text) : [];
  const ran =
    depth === 'full' &&
    phases.some((p) => MANDATORY_PHASES.has(p.code) && (p.result === 'pass' || p.result === 'fail'));
  const failedPhase = phases.some((p) => MANDATORY_PHASES.has(p.code) && p.result === 'fail');

  const provenance =
    `> Produced by Touchstone at ${input.finishedAt}` +
    (input.benchHost ? ` against ${input.benchHost}` : '') +
    `.\n> The report covers both legs; the ${'{leg}'} section is reproduced below verbatim.\n`;

  const recorded = input.requirements ?? [];
  const coverage = recorded.length > 0 ? coverageOf(recorded) : null;

  const common = {
    subject_ref: input.subjectRef ?? `Yundera/AppStore@main:Apps/${subject}`,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    ...(input.benchHost ? { bench_host: input.benchHost } : {}),
    ...(input.browserEndpoint ? { browser: input.browserEndpoint } : {}),
    produced_by: 'touchstone-runner',
  };

  const out: { meta: AssayMeta; body: string }[] = [];

  out.push({
    meta: {
      subject,
      leg: 'static',
      standard: standards.staticStd.name,
      standard_version: standards.staticStd.version,
      status: 'done',
      // `errored` on a report whose functional half never ran is a statement about the
      // bench, not about the static checklist — the same scoping the importer applies.
      verdict: scopeVerdict(declared.verdict as Verdict, tier, ran),
      top_severity: tier,
      risk_score: declared.risk_score,
      blocked_reason: null,
      ...common,
      ...(coverage ? { coverage } : {}),
      ...(recorded.length > 0 ? { requirements: recorded } : {}),
      // The declared score and the sum of the declared items should agree. When they do not,
      // the agent's arithmetic and its item list came apart — worth recording, not smoothing.
      ...(coverage && coverage.risk !== declared.risk_score ? { risk_score_declared: declared.risk_score } : {}),
    } as AssayMeta,
    body: composeBody(subject, 'static', shape, null, declared.report_markdown, provenance.replace('{leg}', 'static')),
  });

  if (depth !== 'full') return out;

  const blockedDetail = shape.functionalSection
    ? blockedReasonDetail(shape.functionalSection.text)
    : null;

  out.push({
    meta: {
      subject,
      leg: 'functional',
      standard: standards.functionalStd.name,
      standard_version: standards.functionalStd.version,
      status: ran ? 'done' : 'blocked',
      verdict: ran ? (failedPhase ? 'non-compliant' : 'compliant') : null,
      // The headline scores the report as a whole and the whole is dominated by the
      // checklist, so it lands on the static leg. Attributing it twice would double the
      // store's risk.
      top_severity: 'none',
      risk_score: 0,
      blocked_reason: ran ? null : 'bench_unavailable',
      ...(ran ? {} : { combined_score_on: 'static' }),
      ...(ran || !blockedDetail ? {} : { blocked_detail: blockedDetail }),
      ...(input.phases && input.phases.length > 0 ? { phases: input.phases } : {}),
      ...common,
    } as AssayMeta,
    body: composeBody(subject, 'functional', shape, null, declared.report_markdown, provenance.replace('{leg}', 'functional')),
  });

  return out;
}
