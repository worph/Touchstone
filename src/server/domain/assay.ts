/**
 * One agent report, one assay file per section.
 *
 * The migration and the runner both turn a single report — one document covering the whole
 * audit — into one file per section of the protocol. They differ only in where the verdict
 * comes from, so the splitting, the phase reading and the body composition live here and the
 * two callers share them.
 *
 * The rule that survives both, ARCHITECTURE principle 3: **the assay's own declaration is
 * authoritative.** The importer reads it off the published headline; the runner takes it
 * from the JSON the agent returned under contract, which is what the headline was generated
 * from. Neither derives a verdict from prose. An earlier importer did, and read eight of
 * twenty non-compliant subjects milder than their own headline.
 */

import type { AssayMeta, Section, Severity, Verdict } from '../../shared/types.js';
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
  section: Section,
  shape: ReturnType<typeof shapeReport> | null,
  sourceUrl: string | null,
  page: string | null,
  /** Overrides the import provenance line — the runner is not importing anything. */
  provenance?: string,
  /** How to name the section in the heading. Defaults to the id. */
  sectionName?: string,
  /** The store this subject came from. The heading names it, as the agent's `title` does. */
  repo = 'Yundera/AppStore',
): string {
  const label = sectionName ?? section;
  const parts: string[] = [];
  parts.push(`# ${repo} — ${subject} · ${label}\n`);
  parts.push(
    provenance ??
    (sourceUrl
      ? `> Imported from the combined audit report at ${sourceUrl}, which covers every section.\n> The ${section} section is reproduced below verbatim.\n`
      : `> No per-app report page exists for ${subject}; this assay is reconstructed from the\n> roll-up index row alone.\n`),
  );
  if (shape?.preamble) parts.push(shape.preamble);
  const body = shape?.sections[section] ?? null;
  if (body) parts.push(body.text.trim());
  else if (page) parts.push(`## ${label}\n\n_The source report has no ${section} section._`);
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
 * A section of one run: its rubric's identity, its phase plan, and how to find it in the
 * agent's narrative. Assembled by the runner from the leaf protocol files.
 */
export interface AssaySection {
  id: string;
  /** Human name, for the report heading. */
  name: string;
  /** What judged it, and at which version — principle 6, recorded on every assay. */
  standard: Standard;
  /** The ids of its phase plan, in order. Empty for a section that has no phases. */
  phases: string[];
  /** Heading patterns that mark this section in the narrative report. */
  headings: string[];
}

/**
 * A section the run could not attempt — recorded rather than dropped.
 *
 * ARCHITECTURE principle 4: **sections are independent, and one unavailable resource costs
 * one section.** Until 2026-08-20 a `depth=full` job with nothing leasable returned `blocked`
 * before the agent was even called, so a dead demo pool cost the *static* verdict too — the
 * exact conflation §2.2 exists to complain about, reintroduced one layer down.
 *
 * So the runner attempts the sections whose prerequisites it can satisfy and calls this for
 * each one it cannot. The result is the same set of files any complete run produces: the
 * sections that ran standing on their own merits, and one that says plainly why there is no
 * verdict in it. `verdict` is null and the severity is `none` because **nothing was learned
 * about the subject** — a blocked section is a statement about the environment.
 */
export function blockedSectionAssay(input: {
  subject: string;
  /** Which store the subject came from — decides the folder the report lands in. */
  origin?: string;
  section: AssaySection;
  reason: string;
  startedAt: string;
  finishedAt: string;
  subjectRef?: string;
  /** Which section carries the run's score, so this one can say where it went. */
  scoredOn?: Section;
}): { meta: AssayMeta; body: string } {
  const { subject, section, reason } = input;
  const why =
    reason === 'browser_unavailable'
      ? 'no browser sidecar was answering, so there was nothing to drive the install with'
      : reason === 'bench_unavailable'
        ? 'no demo instance was usable — the pool was unreachable, mid-cleanup, or too close to its daily wipe'
        : reason === 'store_unreachable'
          ? 'the store this app comes from could not be read, so there was nothing to audit against'
          : reason === 'store_url_unconfigured'
            ? // The whole justification lives here rather than in a code comment, because the
              // blocked report IS where somebody reading a trial result asks the question.
              'a demo instance installs from a store it fetches over the public internet, and ' +
              'Touchstone has not been told its own external address — set `trials.public_base_url` ' +
              'in config.yaml and this section will run. It is not a statement about the app, and ' +
              'not a limitation of trials: with that one setting a trial serves the exact archive ' +
              'it audited, so the bytes installed and the bytes judged are the same'
            : `a prerequisite of this section was unavailable (${reason})`;

  return {
    meta: {
      subject,
      ...(input.origin ? { origin: input.origin } : {}),
      section: section.id,
      standard: section.standard.name,
      standard_version: section.standard.version,
      status: 'blocked',
      verdict: null,
      top_severity: 'none',
      risk_score: 0,
      blocked_reason: reason,
      blocked_detail: why,
      ...(input.scoredOn ? { combined_score_on: input.scoredOn } : {}),
      subject_ref: input.subjectRef ?? `Yundera/AppStore@main:Apps/${subject}`,
      started_at: input.startedAt,
      finished_at: input.finishedAt,
      produced_by: 'touchstone-runner',
    } as unknown as AssayMeta,
    body: [
      `# ${repoOf(input.subjectRef)} — ${subject} · ${section.name}`,
      '',
      `> Produced by Touchstone at ${input.finishedAt}.`,
      '',
      '## Not run',
      '',
      `The ${section.id} section could not be attempted: ${why}.`,
      '',
      'This is a statement about the environment, not about the app. No check in this section',
      'was made, so nothing here counts for or against the subject, and the run cost it no',
      'retry. The other sections of this run completed and carry their own verdicts.',
      '',
      'The section is re-assayed when its prerequisites are available again.',
      '',
    ].join('\n'),
  };
}

export interface AgentAssayInput {
  subject: string;
  declared: DeclaredResult;
  /**
   * The sections that ran, in protocol order.
   *
   * The **first** carries the run's headline: the agent declares one verdict, one tier and
   * one score for the audit as a whole, and attributing them to every section would multiply
   * the archive's risk by the number of sections. The others carry `combined_score_on`.
   */
  sections: AssaySection[];
  /** Sections that were not attempted, and why. Each becomes a `blocked` assay. */
  blocked?: { section: AssaySection; reason: string }[];
  startedAt: string;
  finishedAt: string;
  /** The bench a section ran against, recorded so a result can be traced to a box. */
  benchHost?: string;
  /**
   * *Which build of the platform* that box was running — a fingerprint, not a version.
   *
   * `benchHost` traces a result to a box; this traces it to a moment in that box's life. Two
   * runs of unchanged app bytes that disagree are either an agent inconsistency or an
   * environment change, and without this the archive cannot tell them apart — which is how a
   * platform change came to be recorded as two apps regressing on 2026-08-22.
   */
  benchBuild?: string;
  /** The browser it drove. Same reason: a live result is only as good as the pair. */
  browserEndpoint?: string;
  /**
   * What the agent recorded requirement by requirement while it worked.
   *
   * These are the record; the narrative body is the evidence for them. Each one knows its
   * section — the ledger resolved that from the protocol that listed the id — so coverage is
   * computed per section rather than heaped onto the first one.
   */
  requirements?: RecordedRequirement[];
  phases?: RecordedPhase[];
  subjectRef?: string;
  /** Which store the subject came from — decides the folder every report lands in. */
  origin?: string;
}

/**
 * The repo half of a `repo@ref:path/subject` reference.
 *
 * The heading names the store the report is about, matching the `title` the agent is asked to
 * return. Absent or malformed, it falls back to the store there was when every report came
 * from one — which is what every assay in the archive says.
 */
function repoOf(subjectRef: string | undefined): string {
  const at = (subjectRef ?? '').indexOf('@');
  return at > 0 ? subjectRef!.slice(0, at) : 'Yundera/AppStore';
}

const TIERS: Record<string, Severity> = {
  critical: 'critical',
  major: 'major',
  minor: 'minor',
  none: 'none',
};

/**
 * Did this section actually happen?
 *
 * A section with a phase plan has to have produced a real result for at least one planned
 * phase; otherwise reading `H — Cleanup | pass | nothing was installed` as a completed run is
 * exactly the mistake that turns a bench outage into a verdict about the app. A section with
 * no phase plan — the static checklist — has nothing to gate on and always counts as run.
 *
 * Recorded phases are preferred over phases parsed out of the prose: one is the agent saying
 * so through the ledger, the other is a table in a document.
 */
function sectionRan(
  section: AssaySection,
  recorded: RecordedPhase[],
  narrative: string | null,
): { ran: boolean; failed: boolean } {
  // A section that declares no plan has nothing to gate on: it is done when the agent
  // answered at all.
  if (section.phases.length === 0) return { ran: true, failed: false };
  const plan = section.phases;
  const mine: { id: string; result: string }[] =
    recorded.length > 0
      ? recorded.map((p) => ({ id: p.phase, result: p.result }))
      : narrative
        ? parsePhases(narrative).map((p) => ({ id: p.code, result: p.result }))
        : [];
  const planned = mine.filter((p) => plan.includes(p.id));
  return {
    ran: planned.some((p) => p.result === 'pass' || p.result === 'fail'),
    failed: planned.some((p) => p.result === 'fail'),
  };
}

/**
 * Build the assay files for one completed run: one per section that ran, plus one per section
 * that could not be attempted.
 *
 * The verdict of the run is the agent's, under contract, and lands on the first section. A
 * later section states its own outcome from what it recorded — a fail in any of its
 * requirements or planned phases is non-compliant — and a section whose phases never produced
 * a real result is `blocked` rather than `done`.
 */
export function assaysFromAgentReport(input: AgentAssayInput): { meta: AssayMeta; body: string }[] {
  const { subject, declared, sections } = input;
  const shape = shapeReport(
    declared.report_markdown,
    sections.map((s) => ({ id: s.id, headings: s.headings })),
  );
  const tier = TIERS[String(declared.severity).toLowerCase()] ?? 'none';
  const primary = sections[0];
  const recorded = input.requirements ?? [];
  const recordedPhases = input.phases ?? [];

  const provenance =
    `> Produced by Touchstone at ${input.finishedAt}` +
    (input.benchHost ? ` against ${input.benchHost}` : '') +
    `.\n> The report covers the whole audit; the {leg} section is reproduced below verbatim.\n`;

  const common = {
    ...(input.origin ? { origin: input.origin } : {}),
    subject_ref: input.subjectRef ?? `Yundera/AppStore@main:Apps/${subject}`,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    ...(input.benchHost ? { bench_host: input.benchHost } : {}),
    ...(input.benchBuild ? { bench_build: input.benchBuild } : {}),
    ...(input.browserEndpoint ? { browser: input.browserEndpoint } : {}),
    produced_by: 'touchstone-runner',
  };

  /** Requirements belong to their own section; anything unattributed falls to the first. */
  const mineOf = (section: AssaySection): RecordedRequirement[] =>
    recorded.filter((r) => (r.section ?? primary?.id) === section.id);

  const out: { meta: AssayMeta; body: string }[] = [];
  const state = new Map<string, { ran: boolean; failed: boolean }>();

  for (const section of sections) {
    const narrative = shape.sections[section.id]?.text ?? null;
    const phases = recordedPhases.filter((p) => (p.section ?? primary?.id) === section.id);
    const status = sectionRan(section, phases, narrative);
    state.set(section.id, status);
  }

  // Whether every *other* section ran, which is what scopes an `errored` headline: an audit
  // reads errored when a mandatory phase could not run, and that is not a statement about the
  // section that completed on its own.
  const othersRan =
    (input.blocked ?? []).length === 0 &&
    sections.slice(1).every((s) => state.get(s.id)?.ran !== false);

  for (const [i, section] of sections.entries()) {
    const isPrimary = i === 0;
    const status = state.get(section.id) ?? { ran: true, failed: false };
    const mine = mineOf(section);
    const coverage = mine.length > 0 ? coverageOf(mine) : null;
    const phases = recordedPhases.filter((p) => (p.section ?? primary?.id) === section.id);
    const narrative = shape.sections[section.id]?.text ?? null;
    const blockedDetail = status.ran || !narrative ? null : blockedReasonDetail(narrative);
    const failedHere = status.failed || mine.some((r) => r.verdict === 'fail');

    out.push({
      meta: {
        subject,
        section: section.id,
        standard: section.standard.name,
        standard_version: section.standard.version,
        status: status.ran ? 'done' : 'blocked',
        verdict: status.ran
          ? isPrimary
            ? scopeVerdict(declared.verdict as Verdict, tier, othersRan)
            : failedHere
              ? 'non-compliant'
              : 'compliant'
          : null,
        // The headline scores the audit as a whole, so it lands on one section. Attributing
        // it to each would multiply the store's risk by the number of sections.
        top_severity: isPrimary ? tier : 'none',
        risk_score: isPrimary ? declared.risk_score : 0,
        blocked_reason: status.ran ? null : 'bench_unavailable',
        ...(isPrimary || !primary ? {} : { combined_score_on: primary.id }),
        // The other half of `combined_score_on`, and the reason it exists: on the primary,
        // `risk_score` covers the whole run while the `coverage` block a few lines down
        // covers only this section's own items. Two different scopes, one document, and
        // until this field they looked like an arithmetic error — a reader comparing
        // `risk_score: 30` against `coverage.risk: 20` had nothing on the record telling
        // them the missing 10 was the functional section's, counted here by design.
        ...(isPrimary && sections.length > 1 ? { combined_score_of: sections.map((s) => s.id) } : {}),
        ...(status.ran || !blockedDetail ? {} : { blocked_detail: blockedDetail }),
        ...common,
        ...(coverage ? { coverage } : {}),
        ...(mine.length > 0 ? { requirements: mine } : {}),
        ...(phases.length > 0 ? { phases } : {}),
        // The declared score and the sum of the declared items should agree. When they do
        // not, the agent's arithmetic and its item list came apart — worth recording, not
        // smoothing. Checked against the whole run's items, which is what it was declared for.
        //
        // What gets recorded is the **computed** number. The declared one is already on this
        // record as `risk_score` — invariant 1 keeps it authoritative — so writing it a second
        // time under a second name (which is what this did until 2026-08-23) emitted two
        // identical values and left the disagreement invisible, in the one field whose entire
        // purpose was to make it visible.
        ...(isPrimary && recorded.length > 0 && coverageOf(recorded).risk !== declared.risk_score
          ? { risk_score_computed: coverageOf(recorded).risk }
          : {}),
      } as unknown as AssayMeta,
      body: composeBody(
        subject,
        section.id,
        shape,
        null,
        declared.report_markdown,
        provenance.replace('{leg}', section.id),
        section.name,
        repoOf(input.subjectRef),
      ),
    });
  }

  for (const skipped of input.blocked ?? []) {
    out.push(
      blockedSectionAssay({
        subject,
        ...(input.origin ? { origin: input.origin } : {}),
        section: skipped.section,
        reason: skipped.reason,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        ...(input.subjectRef ? { subjectRef: input.subjectRef } : {}),
        ...(primary ? { scoredOn: primary.id } : {}),
      }),
    );
  }

  return out;
}
