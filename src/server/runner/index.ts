/**
 * The runner — rows D1–D5 and E1, and the thing that makes Touchstone able to audit an app
 * rather than only decide which one to audit.
 *
 * One job in, one assay file per section of the protocol out, and a `SchedulerOutcome` back
 * so the scheduler knows what it cost. The shape is n8n's, node for node:
 *
 *   Build prompt → Call Claude Code → Extract → busy? → Wait → retry once → record
 *
 * **Three rules it exists to keep, all of them the reason the old system hurt:**
 *
 * 1. **A busy agent costs nothing.** `AppStore PR Review` stays in n8n on the same endpoint,
 *    so a 409 is routine and is never the subject's fault. It retries once after a wait, and
 *    if it is still busy the subject goes back to the queue untouched — no try, no last-run.
 * 2. **A dead bench is not a verdict.** A section whose prerequisites are missing is not
 *    attempted and is written `blocked`, never `errored`, and never narrows the rest of the
 *    run. What each section needs is declared by its protocol file (`requires:`), which is
 *    what replaced the old `depth: static | full` — there is no such thing as a partial run
 *    any more, only sections that could run and sections that could not.
 * 3. **The agent's declaration is authoritative.** The runner consumes the JSON contract and
 *    parses no markdown for its verdict, tier or score — principle 3.
 *
 * It ships **disabled** (`runner.enabled: false`). Validation is a single hand-run assay via
 * `POST /assays`, never a loop: two systems auditing the same app contend for one agent.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import { splitSubjectKey, type SubjectKey } from '../../shared/subject.js';
import type { Section } from '../../shared/types.js';
import type { LastRun, RunLive, RunOutcome } from '../../shared/activity.js';
import { assaysFromAgentReport, type AssaySection } from '../domain/assay.js';
import type { ReportIndex } from '../store/index.js';
import { recordFor, writeReport } from '../store/reports.js';
import type { BenchProber } from '../services/bench.js';
import type { PortProber } from '../services/ports.js';
import { sectionsOf, type ProtocolSection, type ProtocolStore } from '../store/protocols.js';
import { coverageOf, type CanonicalRequirement, type RunLedger, type RunState } from '../services/ledger.js';
import type { EventLog } from '../services/events.js';
import { callAgent, type AgentOptions, type AgentOutcome } from './agent.js';
import { buildPrompt } from './prompt.js';

export { buildPrompt } from './prompt.js';
export { callAgent, classify, extractText, type AgentReport } from './agent.js';

export interface RunnerJob {
  /**
   * Identity, `<origin>~<name>`. The runner splits it: the origin decides which store the
   * subject is fetched from and which folder its report lands in, and the bare name is what
   * the prompt and the report call the app.
   */
  subject: SubjectKey;
  try_n: number;
}

/** What the scheduler needs back. Mirrors `scheduler/record.ts`'s `Outcome`. */
/**
 * Re-exported rather than declared: the shape crosses the wire on `/assays/current`, so it
 * is defined once in `shared/` and both sides compile against that one definition.
 */
export type { RunOutcome };

export interface RunnerOptions {
  /**
   * Where to dump the agent's answer when it cannot be parsed.
   *
   * 800 characters in a log line is enough to see *that* the answer was wrong and never
   * enough to see *why* — a truncated report and a malformed one look identical at that
   * length. One file, overwritten each time, so it never grows.
   */
  dumpDir?: string;
  /** False means refuse every job and say so. The default, until reviewed. */
  enabled: boolean;
  reportsRoot: string;
  events: EventLog;
  index?: ReportIndex;
  prober?: BenchProber;
  /** The agent and browser endpoints, so a section that needs a browser can lease one. */
  ports?: PortProber;
  /** The rubric, read fresh per run so an edit takes effect on the next audit, not the next boot. */
  protocols?: ProtocolStore;
  /** Where the agent records requirements as it settles them. Absent = the old blob-only path. */
  ledger?: RunLedger;
  /** How the agent reaches this app's MCP surface. Named in the prompt. */
  callbackUrl?: string;
  agent?: AgentOptions;
  /** How long to wait before the one retry. n8n waits ten minutes. */
  busyBackoffMs?: number;
  /** Injected in tests so the backoff does not actually take ten minutes. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const DEFAULT_BACKOFF_MS = 10 * 60_000;

/** What the UI needs to show a run in progress, and what became of the last one. */
export interface RunnerStatus {
  running: RunLive | null;
  last: LastRun | null;
}

export class Runner {
  private readonly opts: RunnerOptions;
  private running = false;
  private current: RunnerStatus['running'] = null;
  private previous: RunnerStatus['last'] = null;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  get enabled(): boolean {
    return this.opts.enabled;
  }

  /** Whether a job is in flight. The scheduler's single-flight is the real guard; this is a belt. */
  get busy(): boolean {
    return this.running;
  }

  /**
   * Add to what `status()` says about the run already in flight.
   *
   * The bench, the browser and the set of sections are all resolved inside `execute`, after
   * the run is announced. Without this the UI would spend the whole audit describing the job
   * as it was requested rather than as it is being run.
   */
  private note(patch: Partial<RunLive>): void {
    if (this.current) this.current = { ...this.current, ...patch };
  }

  /**
   * What is happening, for a page that has to show a six-minute operation honestly.
   *
   * `last` survives the run so a browser that polls a second too late still finds out what
   * happened, rather than seeing "nothing running" and having to guess.
   */
  status(): RunnerStatus {
    return { running: this.current, last: this.previous };
  }

  async run(job: RunnerJob): Promise<RunOutcome> {
    if (!this.opts.enabled) {
      return { kind: 'blocked', reason: 'runner_disabled' };
    }
    if (this.running) {
      // Two assays at once would contend for the one agent and the one bench, and the
      // second would lose in a way that looks like the subject's fault.
      return { kind: 'blocked', reason: 'runner_busy' };
    }
    this.running = true;
    const startedAt = this.now().toISOString();
    this.current = { subject: job.subject, started_at: startedAt };
    try {
      const outcome = await this.execute(job);
      this.previous = {
        subject: job.subject,
        ...(this.current?.sections ? { sections: this.current.sections } : {}),
        started_at: startedAt,
        finished_at: this.now().toISOString(),
        outcome,
      };
      return outcome;
    } finally {
      this.running = false;
      this.current = null;
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private async execute(job: RunnerJob): Promise<RunOutcome> {
    const events = this.opts.events;
    const startedAt = this.now().toISOString();
    const { origin, name: appName } = splitSubjectKey(job.subject);

    // ── what this run is made of ─────────────────────────────────────────────────────────
    // Read per run, not cached: an operator who edits the protocol expects the next audit to
    // use it, and a rubric held in memory since boot is the kind of staleness nobody suspects.
    const plan = await this.plan();
    if (!plan || plan.sections.length === 0) {
      events.log({
        level: 'error',
        code: 'PROTOCOL_MISSING',
        message: 'There is no protocol on disk, so there is nothing to audit against',
        detail: { dir: this.opts.protocols?.directory ?? '<unset>' },
      });
      return { kind: 'blocked', reason: 'no_protocol' };
    }

    // ── what each section needs, and whether we have it ──────────────────────────────────
    // The bench is chosen here, not by the agent: the management board reports an instance
    // Ready while its login gate is broken, so the host handed to the prompt is one whose
    // login we probed ourselves. Rows D7/D8.
    //
    // A capability is probed only if some section asks for it. Nothing leasable does not abort
    // the run and does not narrow it: principle 4 says sections are independent, and returning
    // `blocked` for the whole job made a dead demo pool cost the static verdict as well —
    // the very conflation §2.2 exists to complain about. The sections that can run, run; the
    // rest are *recorded* as blocked.
    const wanted = new Set(plan.sections.flatMap((s) => s.requires));
    let benchHost: string | undefined;
    let browserEndpoint: string | undefined;
    const missing = new Map<string, string>();

    if (wanted.has('bench')) {
      const leasable = this.opts.prober?.leasable() ?? [];
      if (leasable.length === 0) missing.set('bench', 'bench_unavailable');
      else benchHost = leasable[0]!.url;
    }
    if (wanted.has('browser')) {
      // A lease is `(bench, browser)` together. There is one run at a time — the scheduler's
      // single-flight and this class's own guard both say so — so taking the first healthy
      // sidecar *is* the lease, and no two assays can share a browser by construction. That is
      // the whole point: the page-stealing race in §2.4 cannot occur.
      const browsers = this.opts.ports?.healthy('browser') ?? [];
      if (browsers.length === 0) missing.set('browser', 'browser_unavailable');
      else browserEndpoint = browsers[0]!.url;
    }

    const runSections: ProtocolSection[] = [];
    const skipped: { section: ProtocolSection; reason: string }[] = [];
    for (const section of plan.sections) {
      const unmet = section.requires.find((c) => missing.has(c));
      if (unmet) skipped.push({ section, reason: missing.get(unmet)! });
      else runSections.push(section);
    }

    this.note({
      sections: runSections.map((s) => s.id),
      blocked: skipped.map((s) => ({ section: s.section.id, reason: s.reason })),
      degraded_reason: skipped[0]?.reason ?? null,
      bench: benchHost ?? null,
      browser: browserEndpoint ?? null,
    });

    for (const { section, reason } of skipped) {
      events.log({
        level: 'warn',
        code: 'ASSAY_DEGRADED',
        message: 'An audit skipped one section, because it had nothing to run it on',
        subject: job.subject,
        detail: { subject: job.subject, reason, section: section.id },
      });
    }

    if (runSections.length === 0) {
      // Every section blocked. There is no audit to run and nothing to say about the subject,
      // so this costs it no try — the same rule that keeps an outage from parking innocent
      // apps, applied to the case where the outage takes out everything at once.
      return { kind: 'blocked', reason: skipped[0]?.reason ?? 'no_section_runnable' };
    }

    // The ticket. Minted per dispatch, dead when the run ends — see `services/ledger.ts` for
    // why this is not a shared secret.
    const canonical = runSections.flatMap((section) =>
      section.requirements
        .filter((r) => r?.id && r?.text)
        .map((r) => ({
          id: String(r.id),
          text: String(r.text),
          // The section comes from the protocol that listed the id, so the ledger never has to
          // ask the agent which section an item belongs to, or guess it from a heading.
          section: section.id,
          ...(r.requires ? { requires: String(r.requires) } : {}),
        })),
    );
    const ticket =
      this.opts.ledger && this.opts.callbackUrl
        ? this.opts.ledger.open({
            subject: job.subject,
            sections: runSections.map((s) => ({
              id: s.id,
              name: s.name,
              phases: s.phases.map((p) => p.id),
            })),
            canonical,
          })
        : null;

    const { prompt } = buildPrompt({
      app_name: appName,
      protocols: {
        ...(plan.orchestrator ? { orchestrator: plan.orchestrator } : {}),
        sections: runSections.map((s) => ({
          id: s.id,
          name: s.name,
          body: s.body,
          phases: s.phases,
          requires: s.requires,
        })),
      },
      skipped: skipped.map(({ section, reason }) => ({ id: section.id, name: section.name, reason })),
      ...(ticket && this.opts.callbackUrl
        ? { callback: { url: this.opts.callbackUrl, run_token: ticket.token } }
        : {}),
      ...(benchHost ? { demo_host: benchHost } : {}),
      ...(browserEndpoint ? { browser_endpoint: browserEndpoint } : {}),
    });

    events.log({
      level: 'info',
      code: 'ASSAY_STARTED',
      message: 'An audit has started',
      subject: job.subject,
      detail: {
        subject: job.subject,
        sections: runSections.map((s) => s.id),
        try_n: job.try_n,
        bench: benchHost ?? null,
        browser: browserEndpoint ?? null,
      },
    });

    let outcome = await callAgent(prompt, this.opts.agent);

    // ── the one retry, row D5 ────────────────────────────────────────────────────────────
    if (!outcome.ok && outcome.error === 'agent-busy') {
      const waitMs = this.opts.busyBackoffMs ?? DEFAULT_BACKOFF_MS;
      events.log({
        level: 'info',
        code: 'AGENT_BUSY',
        message: 'The agent was busy, so the audit will wait and try once more',
        subject: job.subject,
        detail: { subject: job.subject, waitMs, attempt: 1 },
      });
      await (this.opts.sleep ?? sleep)(waitMs);
      outcome = await callAgent(prompt, this.opts.agent);

      if (!outcome.ok && outcome.error === 'agent-busy') {
        // Still busy. The subject is put back exactly as it was — this is the branch that
        // must never burn a try, and the one that parked thirteen innocent apps when the old
        // system got it wrong for a bench instead of an agent.
        events.log({
          level: 'warn',
          code: 'AGENT_BUSY',
          message: 'The agent was still busy after the retry, so the app keeps its place',
          subject: job.subject,
          detail: { subject: job.subject, waitMs, attempt: 2 },
        });
        return { kind: 'agent_busy' };
      }
    }

    // Whatever the agent recorded, however the run ended. Closed before the outcome is
    // examined precisely so a failure keeps what it established.
    const flagged = ticket ? this.opts.ledger?.close(ticket.token) ?? null : null;

    if (!outcome.ok) {
      return this.fail(job, outcome, flagged);
    }

    // ── the result ───────────────────────────────────────────────────────────────────────
    const finishedAt = this.now().toISOString();
    const assays = assaysFromAgentReport({
      subject: appName,
      origin,
      declared: outcome.report,
      // The sections that actually ran, and — recorded rather than dropped — the ones that
      // could not, so a run always produces one file per section and the store can say "not
      // checked" instead of nothing.
      sections: runSections.map((s) => this.assaySection(s)),
      blocked: skipped.map(({ section, reason }) => ({ section: this.assaySection(section), reason })),
      startedAt,
      finishedAt,
      ...(benchHost ? { benchHost } : {}),
      ...(browserEndpoint ? { browserEndpoint } : {}),
      ...(flagged ? { requirements: flagged.requirements, phases: flagged.phases } : {}),
    });

    const files: string[] = [];
    for (const assay of assays) {
      const res = await writeReport(this.opts.reportsRoot, assay.meta, assay.body);
      files.push(res.rel);
      // `recordFor` rather than a second literal: how a record is derived from a file is one
      // definition, shared with `buildIndex`'s scan, so the in-memory record and the one a
      // restart would rebuild cannot drift apart.
      this.opts.index?.upsert(recordFor(assay.meta, res.rel));
    }

    const blocked = assays.find((a) => a.meta.status === 'blocked');
    events.log({
      level: 'info',
      code: 'ASSAY_COMPLETED',
      message: blocked
        ? 'An audit finished, but one of its sections could not run'
        : 'An audit finished',
      subject: job.subject,
      detail: {
        subject: job.subject,
        verdict: String(assays[0]!.meta.verdict ?? 'none'),
        risk: assays[0]!.meta.risk_score,
        sections: assays.map((a) => a.meta.section),
        blocked: blocked ? String(blocked.meta.blocked_reason ?? 'unknown') : null,
      },
    });

    return {
      kind: 'verdict',
      verdict: String(assays[0]!.meta.verdict ?? 'none'),
      risk: assays[0]!.meta.risk_score,
      files,
    };
  }

  /**
   * A failure that is not busy.
   *
   * `agent-auth` is called out separately because it is the one class where *nothing* about
   * any app is wrong and no amount of retrying will help — somebody has to log the agent in.
   * It still costs a try, as n8n charges it, but it opens the alert that says where to look.
   */
  /**
   * The protocol, read fresh: the orchestrator's text and the sections it composes.
   *
   * `null` means there is nothing on disk. That used to be survivable — the prompt fell back
   * to wording that told the agent to fetch the rubric from a wiki — but the rubric lives
   * here now, and there is no wiki to fall back to. A run with no protocol has nothing to
   * judge against and no sections to write, so it stops instead of inventing either.
   */
  private async plan(): Promise<{ orchestrator?: string; sections: ProtocolSection[] } | null> {
    if (!this.opts.protocols) return null;
    const all = await this.opts.protocols.list();
    if (all.length === 0) return null;
    const orchestrator = all.find((p) => p.meta.kind === 'orchestrator')?.body;
    return {
      ...(orchestrator ? { orchestrator } : {}),
      sections: sectionsOf(all),
    };
  }

  /**
   * A section, plus the standard that names and versions it — which is the protocol file
   * itself. There is no second file to override it: one that carried its own version could
   * only ever disagree with the rubric it claimed to version, and did (`static-v4.yaml` was
   * still stamping assays v4 after the protocol had been edited to v5).
   */
  private assaySection(section: ProtocolSection): AssaySection {
    return {
      id: section.id,
      name: section.name,
      standard: { name: section.name, version: section.version },
      phases: section.phases.map((p) => p.id),
      headings: section.headings,
    };
  }

  private async dump(job: RunnerJob, outcome: Extract<AgentOutcome, { ok: false }>): Promise<void> {
    if (!this.opts.dumpDir || outcome.error !== 'parse-failed') return;
    try {
      const file = path.join(this.opts.dumpDir, 'last-unparsed-response.txt');
      await fs.mkdir(this.opts.dumpDir, { recursive: true });
      await fs.writeFile(file, `# ${job.subject} · ${this.now().toISOString()}\n\n${outcome.rawText}\n`, 'utf8');
    } catch {
      /* a failed dump must not turn a classified failure into a thrown one */
    }
  }

  private fail(
    job: RunnerJob,
    outcome: Extract<AgentOutcome, { ok: false }>,
    flagged: RunState | null,
  ): RunOutcome {
    void this.dump(job, outcome);
    // A run that died at requirement 12 of 16 established twelve facts. Saying so is the
    // difference between "we know nothing" and "we know most of it and the rest is unknown".
    const partial = flagged ? coverageOf(flagged.requirements) : null;
    this.opts.events.log({
      level: 'error',
      code: outcome.error === 'agent-auth' ? 'AGENT_UNAUTHENTICATED' : 'ASSAY_FAILED',
      message:
        outcome.error === 'agent-auth'
          ? 'The audit agent is not logged in, so no audit can run'
          : 'An audit failed to produce a report',
      subject: job.subject,
      detail: {
        subject: job.subject,
        error: outcome.error,
        raw: outcome.rawText.slice(0, 800),
        ...(partial ? { verified: partial.verified, of: partial.applicable } : {}),
      },
    });
    return { kind: 'error', reason: outcome.error };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
