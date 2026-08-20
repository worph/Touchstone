/**
 * The runner — rows D1–D5 and E1, and the thing that makes Touchstone able to audit an app
 * rather than only decide which one to audit.
 *
 * One job in, one or two assay files out, and a `SchedulerOutcome` back so the scheduler
 * knows what it cost. The shape is n8n's, node for node:
 *
 *   Build prompt → Call Claude Code → Extract → busy? → Wait → retry once → record
 *
 * **Three rules it exists to keep, all of them the reason the old system hurt:**
 *
 * 1. **A busy agent costs nothing.** `AppStore PR Review` stays in n8n on the same endpoint,
 *    so a 409 is routine and is never the subject's fault. It retries once after a wait, and
 *    if it is still busy the subject goes back to the queue untouched — no try, no last-run.
 * 2. **A dead bench is not a verdict.** The functional leg is written `blocked`, never
 *    `errored`, whenever no mandatory phase produced a real result.
 * 3. **The agent's declaration is authoritative.** The runner consumes the JSON contract and
 *    parses no markdown for its verdict, tier or score — principle 3.
 *
 * It ships **disabled** (`runner.enabled: false`). Validation is a single hand-run assay via
 * `POST /assays`, never a loop: two systems auditing the same app contend for one agent.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AssayRecord, Leg } from '../../shared/types.js';
import { assaysFromAgentReport, type Standard } from '../domain/assay.js';
import type { ReportIndex } from '../store/index.js';
import { writeReport } from '../store/reports.js';
import type { BenchProber } from '../services/bench.js';
import type { PortProber } from '../services/ports.js';
import type { ProtocolStore } from '../store/protocols.js';
import { coverageOf, type CanonicalRequirement, type RunLedger, type RunState } from '../services/ledger.js';
import type { EventLog } from '../services/events.js';
import { callAgent, type AgentOptions, type AgentOutcome } from './agent.js';
import { buildPrompt } from './prompt.js';

export { buildPrompt } from './prompt.js';
export { callAgent, classify, extractText, type AgentReport } from './agent.js';

export interface RunnerJob {
  subject: string;
  depth: 'static' | 'full';
  try_n: number;
}

/** What the scheduler needs back. Mirrors `scheduler/record.ts`'s `Outcome`. */
export type RunOutcome =
  | { kind: 'verdict'; verdict: string; risk: number; files: string[] }
  | { kind: 'error'; reason: string }
  | { kind: 'agent_busy' }
  | { kind: 'blocked'; reason: string };

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
  standards: { staticStd: Standard; functionalStd: Standard };
  events: EventLog;
  index?: ReportIndex;
  prober?: BenchProber;
  /** The agent and browser endpoints, so a functional run can lease a browser. */
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
  running: { subject: string; depth: 'static' | 'full'; started_at: string } | null;
  last: {
    subject: string;
    depth: 'static' | 'full';
    started_at: string;
    finished_at: string;
    outcome: RunOutcome;
  } | null;
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
    this.current = { subject: job.subject, depth: job.depth, started_at: startedAt };
    try {
      const outcome = await this.execute(job);
      this.previous = {
        subject: job.subject,
        depth: job.depth,
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

    // The bench is chosen here, not by the agent: the management board reports an instance
    // Ready while its login gate is broken, so the host handed to the prompt is one whose
    // login we probed ourselves. Rows D7/D8.
    let benchHost: string | undefined;
    if (job.depth === 'full' && this.opts.prober) {
      const leasable = this.opts.prober.leasable();
      if (leasable.length === 0) {
        events.log({
          level: 'warn',
          code: 'ASSAY_BLOCKED',
          message: 'An audit could not start because no demo bench was usable',
          subject: job.subject,
          detail: { subject: job.subject, reason: 'bench_unavailable' },
        });
        return { kind: 'blocked', reason: 'bench_unavailable' };
      }
      benchHost = leasable[0]!.url;
    }

    // ── the browser, row D6 ──────────────────────────────────────────────────────────────
    // A lease is `(bench, browser)` together. There is one functional run at a time — the
    // scheduler's single-flight and this class's own guard both say so — so taking the first
    // healthy sidecar *is* the lease, and no two assays can share a browser by construction.
    // That is the whole point: the page-stealing race in §2.4 cannot occur.
    let browserEndpoint: string | undefined;
    if (job.depth === 'full' && this.opts.ports) {
      const browsers = this.opts.ports.healthy('browser');
      if (browsers.length === 0) {
        events.log({
          level: 'warn',
          code: 'ASSAY_BLOCKED',
          message: 'An audit could not start because no browser sidecar was answering',
          subject: job.subject,
          detail: { subject: job.subject, reason: 'browser_unavailable' },
        });
        return { kind: 'blocked', reason: 'browser_unavailable' };
      }
      browserEndpoint = browsers[0]!.url;
    }

    // Read per run, not cached: an operator who edits the protocol expects the next audit to
    // use it, and a rubric held in memory since boot is the kind of staleness nobody suspects.
    const protocols = await this.loadProtocols();

    // The ticket. Minted per dispatch, dead when the run ends — see `services/ledger.ts` for
    // why this is not a shared secret.
    const canonical = await this.canonicalRequirements(job.depth);
    const ticket =
      this.opts.ledger && this.opts.callbackUrl
        ? this.opts.ledger.open({ subject: job.subject, depth: job.depth, canonical })
        : null;

    const { prompt } = buildPrompt({
      app_name: job.subject,
      depth: job.depth,
      ...(protocols ? { protocols } : {}),
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
        depth: job.depth,
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
      subject: job.subject,
      declared: outcome.report,
      standards: this.opts.standards,
      startedAt,
      finishedAt,
      depth: job.depth,
      benchHost,
      browserEndpoint,
      ...(flagged ? { requirements: flagged.requirements, phases: flagged.phases } : {}),
    });

    const files: string[] = [];
    for (const assay of assays) {
      const res = await writeReport(this.opts.reportsRoot, assay.meta, assay.body);
      files.push(res.rel);
      this.opts.index?.upsert({
        meta: assay.meta,
        path: res.rel,
        subject: assay.meta.subject,
        file: path.basename(res.rel),
      } satisfies AssayRecord);
    }

    const blocked = assays.find((a) => a.meta.status === 'blocked');
    events.log({
      level: 'info',
      code: 'ASSAY_COMPLETED',
      message: blocked
        ? 'An audit finished, but its functional half could not run'
        : 'An audit finished',
      subject: job.subject,
      detail: {
        subject: job.subject,
        verdict: String(assays[0]!.meta.verdict ?? 'none'),
        risk: assays[0]!.meta.risk_score,
        legs: assays.map((a) => a.meta.leg as Leg),
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
   * The three texts, or nothing.
   *
   * Nothing is a legitimate answer — it makes the prompt fall back to the wiki-fetching
   * wording, which is what the n8n node still does. It is not the configuration this
   * installation wants, so it is logged rather than passed over in silence.
   */
  private async loadProtocols(): Promise<{ orchestrator?: string; static?: string; functional?: string } | null> {
    if (!this.opts.protocols) return null;
    const all = await this.opts.protocols.list();
    if (all.length === 0) {
      this.opts.events.log({
        level: 'warn',
        code: 'PROTOCOL_MISSING',
        message: 'No protocol files were found, so the audit has no rubric of its own',
        detail: { dir: this.opts.protocols.directory },
      });
      return null;
    }
    const byId = new Map(all.map((p) => [p.meta.id, p.body]));
    return {
      orchestrator: byId.get('orchestrator'),
      static: byId.get('static'),
      functional: byId.get('functional'),
    };
  }

  /**
   * The canonical ids for this run — the static leaf always, the functional one at `full`.
   *
   * Handed to the agent through `list_requirements` so it maps to a stable vocabulary rather
   * than inventing wording that drifts between runs and breaks every cross-app question.
   */
  private async canonicalRequirements(depth: 'static' | 'full'): Promise<CanonicalRequirement[]> {
    if (!this.opts.protocols) return [];
    const all = await this.opts.protocols.list();
    const out: CanonicalRequirement[] = [];
    for (const p of all) {
      if (p.meta.kind !== 'leaf') continue;
      if (depth === 'static' && p.meta.leg === 'functional') continue;
      for (const r of p.meta.requirements ?? []) {
        if (r?.id && r?.text) out.push({ id: String(r.id), text: String(r.text), ...(r.requires ? { requires: String(r.requires) } : {}) });
      }
    }
    return out;
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
