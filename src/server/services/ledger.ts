/**
 * The run ledger — what an audit has established *so far*.
 *
 * Until now the whole result of a six-minute run rode home in one JSON blob at the end, and
 * that had two failure modes we hit for real on 2026-08-19:
 *
 * - **A complete, correct report was scored `parse-failed` twice.** 30 KB of JSON with fenced
 *   markdown inside it, lost to a brace scan. Six minutes of real work, discarded.
 * - **A run that dies at requirement 12 of 16 leaves nothing.** Not "twelve results and four
 *   unknowns" — `agent-error`, and no record that anything was ever checked.
 *
 * So the agent records each requirement as it settles it, through the MCP surface in
 * `routes/mcp.ts`, and this holds them. Each call is validated where the agent can still be
 * told it got the shape wrong; a crash degrades to `unverified` for what was never reached
 * instead of erasing what was.
 *
 * **What this deliberately cannot record is a verdict.** There is no `record_result`. The
 * moment an agent can post its own outcome, the protocol's gate — *any Critical is
 * non-compliant unconditionally* — becomes advisory. The agent judges each requirement;
 * Touchstone computes the gate.
 */

import { randomBytes } from 'node:crypto';

import type { Severity } from '../../shared/types.js';
import type { EventLog } from './events.js';

export type RequirementVerdict = 'pass' | 'fail' | 'n-a' | 'unverified';
export type PhaseResult = 'pass' | 'fail' | 'errored' | 'n-a';

/** A requirement the protocol names, handed to the agent so it maps rather than invents. */
export interface CanonicalRequirement {
  id: string;
  text: string;
  /**
   * The section that lists this id — the leaf protocol it came from.
   *
   * This is what makes section attribution free: Touchstone builds the canonical list by
   * walking the protocol files, so it already knows which section owns every id and never has
   * to ask the agent, or guess from a heading in the prose.
   */
  section: string;
  /** A capability the check needs. `bench` means it cannot run without a live instance. */
  requires?: string;
}

/** One section of the protocol, as the run sees it. */
export interface RunSection {
  id: string;
  name: string;
  /** The ids this section's phase plan names. Empty for a section that has no phases. */
  phases: string[];
}

export interface RecordedRequirement {
  id: string;
  /** Which section this belongs to. Resolved here, never taken on trust — see `sectionFor`. */
  section?: string;
  /** The wording the agent used. Kept even when the id is canonical — it is the evidence. */
  requirement?: string;
  verdict: RequirementVerdict;
  severity?: Severity;
  note?: string;
  /** True when the id was not in the protocol's list. Recorded, never dropped. */
  unlisted?: boolean;
  at: string;
  /** How many times this id was re-recorded. A revision is normal; losing it silently is not. */
  revisions?: number;
}

export interface RecordedPhase {
  phase: string;
  /** The section whose phase plan names this phase. */
  section?: string;
  result: PhaseResult;
  note?: string;
  at: string;
}

export interface RunTicket {
  token: string;
  subject: string;
  /** The sections this run is actually attempting, in protocol order. */
  sections: RunSection[];
  started_at: string;
  expires_at: string;
}

export interface RunState extends RunTicket {
  requirements: RecordedRequirement[];
  phases: RecordedPhase[];
  canonical: CanonicalRequirement[];
  closed_at?: string;
}

export interface LedgerOptions {
  events: EventLog;
  /** How long a token stays good. A run that outlives it was abandoned. */
  ttlMs?: number;
  now?: () => Date;
}

const DEFAULT_TTL_MS = 5 * 60 * 60_000;

export type RecordOutcome =
  | { ok: true; recorded: RecordedRequirement }
  | { ok: false; error: string };

export class RunLedger {
  private readonly opts: LedgerOptions;
  private runs = new Map<string, RunState>();
  /** The most recent closed run, so a UI polling a beat late still sees the result. */
  private lastClosed?: RunState;

  constructor(opts: LedgerOptions) {
    this.opts = opts;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  /**
   * Mint a ticket for one run.
   *
   * The token is **run-scoped and single-use**, not a shared secret: an inbound "record an
   * audit result" surface with a static credential is a way to forge audit results, and a
   * token that dies with its run is also how we notice an agent still writing after we gave
   * up on it.
   */
  open(input: {
    subject: string;
    sections: RunSection[];
    canonical: CanonicalRequirement[];
  }): RunTicket {
    const now = this.now();
    const ticket: RunTicket = {
      token: randomBytes(24).toString('base64url'),
      subject: input.subject,
      sections: input.sections,
      started_at: now.toISOString(),
      expires_at: new Date(now.getTime() + (this.opts.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    };
    this.runs.set(ticket.token, { ...ticket, requirements: [], phases: [], canonical: input.canonical });
    return ticket;
  }

  close(token: string): RunState | null {
    const run = this.runs.get(token);
    if (!run) return null;
    run.closed_at = this.now().toISOString();
    this.runs.delete(token);
    this.lastClosed = run;
    return run;
  }

  /** The run in flight, for the page that shows progress. */
  live(): RunState | null {
    for (const run of this.runs.values()) return run;
    return null;
  }

  last(): RunState | null {
    return this.lastClosed ?? null;
  }

  private resolve(token: string): { run: RunState } | { error: string } {
    const run = this.runs.get(String(token ?? ''));
    if (!run) return { error: 'unknown or expired run_token' };
    if (Date.parse(run.expires_at) < this.now().getTime()) {
      this.runs.delete(run.token);
      return { error: 'this run_token has expired' };
    }
    return { run };
  }

  requirementsFor(token: string): CanonicalRequirement[] | { error: string } {
    const found = this.resolve(token);
    return 'error' in found ? found : found.run.canonical;
  }

  /**
   * What this run is made of: its sections and their canonical ids.
   *
   * The sections go out with the requirements because they are the run's actual shape — a
   * section whose prerequisites were missing was never attempted and is not in this list, so
   * an agent asking what to do is told what is being asked of it and nothing else.
   */
  planFor(token: string): { sections: RunSection[]; requirements: CanonicalRequirement[] } | { error: string } {
    const found = this.resolve(token);
    if ('error' in found) return found;
    return { sections: found.run.sections, requirements: found.run.canonical };
  }

  /**
   * Record one requirement.
   *
   * Validation happens here rather than after the run, which is the point of the whole
   * arrangement: the agent is still working and can be told what it got wrong.
   */
  recordRequirement(
    token: string,
    input: {
      id?: string;
      section?: string;
      requirement?: string;
      verdict?: string;
      severity?: string;
      note?: string;
    },
  ): RecordOutcome {
    const found = this.resolve(token);
    if ('error' in found) return { ok: false, error: found.error };
    const run = found.run;

    const id = String(input.id ?? '').trim();
    if (!id) return { ok: false, error: 'id is required — call list_requirements for the canonical ids' };

    const verdict = String(input.verdict ?? '').trim() as RequirementVerdict;
    if (!['pass', 'fail', 'n-a', 'unverified'].includes(verdict)) {
      return { ok: false, error: `verdict must be one of pass, fail, n-a, unverified (got "${input.verdict}")` };
    }

    const severity = normaliseSeverity(input.severity);
    if (verdict === 'fail' && !severity) {
      // The protocol gates on severity, not on counts. A fail without one cannot be scored,
      // and guessing a tier here would be Touchstone judging.
      return { ok: false, error: 'a fail must carry severity: Critical, Major or Minor' };
    }

    const unlisted = !run.canonical.some((c) => c.id === id);
    const section = sectionFor(run, id, input.section);
    const at = this.now().toISOString();
    const existing = run.requirements.find((r) => r.id === id);
    const recorded: RecordedRequirement = {
      id,
      ...(section ? { section } : {}),
      ...(input.requirement ? { requirement: String(input.requirement) } : {}),
      verdict,
      ...(severity ? { severity } : {}),
      ...(input.note ? { note: String(input.note).slice(0, 4000) } : {}),
      ...(unlisted ? { unlisted: true } : {}),
      at,
      ...(existing ? { revisions: (existing.revisions ?? 0) + 1 } : {}),
    };

    if (existing) {
      // Last write wins — an agent revising item 6 after seeing item 11 is normal work. The
      // supersession is logged rather than silently overwritten.
      run.requirements[run.requirements.indexOf(existing)] = recorded;
      this.opts.events.log({
        level: 'debug',
        code: 'ASSAY_REQUIREMENT_REVISED',
        message: 'The audit changed its mind about one requirement',
        subject: run.subject,
        detail: { subject: run.subject, id, from: existing.verdict, to: verdict },
      });
    } else {
      run.requirements.push(recorded);
    }

    if (unlisted) {
      this.opts.events.log({
        level: 'debug',
        code: 'ASSAY_REQUIREMENT_UNLISTED',
        message: 'The audit reported a requirement the protocol does not list',
        subject: run.subject,
        detail: { subject: run.subject, id, section },
      });
    }

    return { ok: true, recorded };
  }

  recordPhase(
    token: string,
    input: { phase?: string; section?: string; result?: string; note?: string },
  ): { ok: true; recorded: RecordedPhase } | { ok: false; error: string } {
    const found = this.resolve(token);
    if ('error' in found) return { ok: false, error: found.error };

    const phase = String(input.phase ?? '').trim();
    if (!phase) return { ok: false, error: 'phase is required' };
    const result = String(input.result ?? '').trim() as PhaseResult;
    if (!['pass', 'fail', 'errored', 'n-a'].includes(result)) {
      // The 2026-07-07 amendment removed `skipped` from the vocabulary on purpose: a phase
      // that could not run is `errored` and the audit retries. There is no way to say "I
      // chose not to".
      return { ok: false, error: `result must be one of pass, fail, errored, n-a (got "${input.result}")` };
    }

    const section = phaseSectionFor(found.run, phase, input.section);
    const recorded: RecordedPhase = {
      phase,
      ...(section ? { section } : {}),
      result,
      ...(input.note ? { note: String(input.note).slice(0, 4000) } : {}),
      at: this.now().toISOString(),
    };
    const run = found.run;
    const existing = run.phases.findIndex((p) => p.phase === phase);
    if (existing >= 0) run.phases[existing] = recorded;
    else run.phases.push(recorded);
    return { ok: true, recorded };
  }
}

/** `Critical` from the agent, `critical` in the archive. One mapping, one place. */
export function normaliseSeverity(value: unknown): Severity | undefined {
  const v = String(value ?? '').trim().toLowerCase();
  if (v === 'critical' || v === 'major' || v === 'minor' || v === 'none') return v;
  return undefined;
}

/**
 * Coverage, which is **not** compliance.
 *
 * `verified / applicable` answers "how much of the checklist actually got checked". The
 * verdict is gated on severity — one Critical outranks fifteen passes — and a count cannot
 * express that. Keeping them apart is the whole reason this is reported separately.
 */
/**
 * Which section a recorded requirement belongs to.
 *
 * The canonical list decides it: an id the protocol named is owned by the protocol that
 * named it, whatever the agent says. Only an id nobody listed can take the agent's word, and
 * only when it names a section this run is actually running — an invented section id would
 * be a partition Touchstone's gate does not know to read, which is the hole invariant 6
 * exists to close. Anything else falls back to the run's primary section.
 */
function sectionFor(run: RunState, id: string, declared: string | undefined): string | undefined {
  const canonical = run.canonical.find((c) => c.id === id);
  if (canonical?.section) return canonical.section;
  const asked = String(declared ?? '').trim();
  if (asked && run.sections.some((s) => s.id === asked)) return asked;
  return run.sections[0]?.id;
}

/**
 * Which section owns a phase: the one whose plan names it. A phase nobody planned is
 * attributed to the only section that has phases at all, and to nothing when several do —
 * an unattributed phase is recorded, never dropped.
 */
function phaseSectionFor(run: RunState, phase: string, declared: string | undefined): string | undefined {
  const owner = run.sections.find((s) => s.phases.includes(phase));
  if (owner) return owner.id;
  const asked = String(declared ?? '').trim();
  if (asked && run.sections.some((s) => s.id === asked)) return asked;
  const withPhases = run.sections.filter((s) => s.phases.length > 0);
  return withPhases.length === 1 ? withPhases[0]!.id : undefined;
}

export function coverageOf(requirements: readonly RecordedRequirement[]): {
  verified: number;
  applicable: number;
  passed: number;
  failed: number;
  unverified: number;
  not_applicable: number;
  risk: number;
} {
  let passed = 0, failed = 0, unverified = 0, na = 0, risk = 0;
  for (const r of requirements) {
    if (r.verdict === 'pass') passed++;
    else if (r.verdict === 'n-a') na++;
    else if (r.verdict === 'unverified') unverified++;
    else {
      failed++;
      risk += r.severity === 'critical' ? 100 : r.severity === 'major' ? 10 : 1;
    }
  }
  return {
    verified: passed + failed,
    applicable: passed + failed + unverified,
    passed,
    failed,
    unverified,
    not_applicable: na,
    risk,
  };
}
