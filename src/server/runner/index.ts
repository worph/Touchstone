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
import type { AssayMeta, Section } from '../../shared/types.js';
import type { LastRun, RunLive, RunOutcome } from '../../shared/activity.js';
import { assaysFromAgentReport, blockedSectionAssay, type AssaySection } from '../domain/assay.js';
import { assayFromScript } from '../domain/scripted.js';
import type { ReportIndex } from '../store/index.js';
import { recordFor, writeReport } from '../store/reports.js';
import { subjectRefOf, type OriginEntry } from '../store/config.js';
import type { BenchProber } from '../services/bench.js';
import type { PortProber } from '../services/ports.js';
import { sectionsOf, type ExecutorRef, type ProtocolSection, type ProtocolStore } from '../store/protocols.js';
import type { KbStore } from '../store/kb.js';
import type { RevisionStore } from '../store/revisions.js';
import { coverageOf, type CanonicalRequirement, type RunLedger, type RunState } from '../services/ledger.js';
import type { EventLog } from '../services/events.js';
import { liveWorld, resolveCapabilities } from './capabilities.js';
import { callAgent, type AgentOptions, type AgentOutcome } from './agent.js';
import { runScript, type ScriptRun } from './exec.js';
import { buildPrompt } from './prompt.js';

export { buildPrompt } from './prompt.js';
export { callAgent, classify, extractText, type AgentReport } from './agent.js';
export { runScript, parseOutput, type ScriptOutput, type ScriptRun } from './exec.js';

export interface RunnerJob {
  /**
   * Identity, `<origin>~<name>`. The runner splits it: the origin decides which store the
   * subject is fetched from and which folder its report lands in, and the bare name is what
   * the prompt and the report call the app.
   *
   * For a trial the origin half is the trial's slug, so the whole path machinery works
   * unchanged and the reports land under `data/trials/<slug>/<Subject>/`.
   */
  subject: SubjectKey;
  try_n: number;
  /**
   * Present, this is a **trial**: the same run written where the report index does not look.
   *
   * It overrides the store's repo and ref, redirects the write root, and skips the index
   * upsert. All three travel together — redirecting only the root would write into
   * `data/trials` *and* upsert into the main index, at which point `server/index.ts`'s
   * `archived: () => store.subjects()` would make every trial a schedulable subject.
   */
  trial?: {
    /**
     * The **rubric anchor**, never a place a byte came from.
     *
     * `static.md` resolves the asset rule against `<repo>@main` and reads that repo's
     * `CONTRIBUTING.md` as the definition of every checklist item, so a run carrying no repo
     * would throw a false Major on every asset URL and apply a rubric whose terms it could not
     * look up. The ref is `main` for the same reason and is not a field: a trial audits an
     * archive, not a branch, and `prompt.ts` rebinds the asset rule for any other value —
     * which is right for a store pinned to a branch and wrong for a working copy.
     */
    repo: string;
    apps_path: string;
    root: string;
    /**
     * The app's files, read out of the store archive this trial audits.
     *
     * Always present: a trial resolves to a store zip before it reaches here, whatever the
     * caller named, and that zip is where these come from. It is also where `store_url` points,
     * so the bytes judged and the bytes installed are the same by construction rather than by
     * the hand-written compose assertion `functional.md` v6 had to add.
     */
    source: { files: string[]; compose: string; rationale?: string | null };
    /**
     * Where a bench fetches this trial's own copy of that archive.
     *
     * Absent only when `trials.public_base_url` is unset — Touchstone cannot serve a store it
     * has no external address for, and the functional section then records
     * `store_url_unconfigured`. That is the one remaining reason a trial is not a full audit,
     * and it is a fact about this box's configuration rather than about trials.
     */
    store_url?: string;
  };
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
  /**
   * How long a section's script may take before it is stopped.
   *
   * The runner is single-flight, so a script that hangs does not fail one section — it parks
   * the entire loop behind itself. Generous, because a check with fifty images to resolve is
   * doing fifty round-trips, and still bounded.
   */
  scriptTimeoutMs?: number;
  reportsRoot: string;
  /**
   * The stores, by id — where a subject's repo, ref and apps path come from.
   *
   * Absent, or missing the job's origin, the runner falls back to the Yundera store's values,
   * which is what every assay written before origins existed was judged against.
   */
  origins?: OriginEntry[];
  /**
   * Whether a store can be read right now — `SubjectRegistry.reachable`.
   *
   * Asked before anything is dispatched. A store we have never reached is an **infra**
   * condition, and invariant 3 says an infra condition may not cost the subject a retry: a
   * subject still in the backlog from a last-known list, audited against a dead source, would
   * error, burn a try, and after three ticks park an app that has nothing wrong with it.
   */
  storeReachable?: (origin: string) => boolean;
  /** Why not, for the blocked report. One clause, never an error object. */
  storeFailure?: (origin: string) => string | undefined;
  /**
   * The version of the subject the store is offering — `SubjectRegistry.versionOf`.
   *
   * A callback rather than the registry itself, exactly as `storeReachable` is: the runner
   * asks a question and is handed an answer, so a test needs no GitHub. Recorded onto every
   * assay of the run so the archive can later say whether a verdict is about the app as it
   * stands. Absent — no registry, a store that offers no compose, a tree fetch that failed —
   * writes nothing, which reads downstream as "no version to compare" and never as "changed".
   */
  subjectVersion?: (key: string) => string | undefined;
  events: EventLog;
  index?: ReportIndex;
  prober?: BenchProber;
  /** The agent and browser endpoints, so a section that needs a browser can lease one. */
  ports?: PortProber;
  /** The rubric, read fresh per run so an edit takes effect on the next audit, not the next boot. */
  protocols?: ProtocolStore;
  /**
   * The protocol history. Optional, and a run proceeds without it — a box that cannot write
   * its history must still be able to audit (invariant 7).
   */
  revisions?: RevisionStore;
  /**
   * The knowledge base, read fresh per run for the same reason the rubric is: a page edited
   * on the volume is meant to reach the next audit, not the next boot.
   *
   * Absent — and it is absent on any box whose volume has no `kb/` — the prompt is exactly
   * what it was before the KB existed and no assay records a digest.
   */
  kb?: KbStore;
  /** The KB's own history, so a recorded `kb_sha256` resolves to bytes. Same optionality. */
  kbRevisions?: RevisionStore;
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

/** What a run started now would cover. See `Runner.forecast()`. */
export interface Forecast {
  /** Section ids that would be attempted, in protocol order. */
  run: Section[];
  /** Those that would be recorded blocked, with the archive's own reason codes. */
  blocked: { section: Section; reason: string }[];
  /** No protocol on disk: the run would stop without writing anything. Not "nothing runs". */
  noProtocol?: boolean;
}

export class Runner {
  private readonly opts: RunnerOptions;
  private running = false;
  private current: RunnerStatus['running'] = null;
  private previous: RunnerStatus['last'] = null;
  /** Set when someone switched the runner on or off at runtime. Absent, the config stands. */
  private enabledOverride?: boolean;
  private backoffOverrideMs?: number;

  constructor(opts: RunnerOptions) {
    this.opts = opts;
  }

  get enabled(): boolean {
    return this.enabledOverride ?? this.opts.enabled;
  }

  /** What `config.yaml` asked for, which is what a fresh boot falls back to. */
  get enabledDefault(): boolean {
    return this.opts.enabled;
  }

  /**
   * Switch the runner on or off while the process is up — `domain/controls.ts`.
   *
   * It gates hand-run assays as well as the loop's, which is why it is a separate switch
   * from `scheduler.armed` and why turning it off does not stop the audit in flight: the
   * flag is read when a job arrives, so a run already dispatched finishes and records. The
   * override is not persisted here; `ControlStore` owns the file and the composition root
   * re-applies it after boot.
   */
  setEnabled(enabled: boolean): void {
    this.enabledOverride = enabled;
  }

  /** Forget the override, back to what the config file says. */
  clearEnabled(): void {
    this.enabledOverride = undefined;
  }

  /** Minutes waited before the single retry when the agent answered 409. */
  get busyBackoffMin(): number {
    return (this.backoffOverrideMs ?? this.opts.busyBackoffMs ?? DEFAULT_BACKOFF_MS) / 60_000;
  }

  get busyBackoffMinDefault(): number {
    return (this.opts.busyBackoffMs ?? DEFAULT_BACKOFF_MS) / 60_000;
  }

  setBusyBackoffMin(minutes: number): void {
    this.backoffOverrideMs = minutes * 60_000;
  }

  clearBusyBackoff(): void {
    this.backoffOverrideMs = undefined;
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

  /**
   * What a run started now would be made of — the answer `run_assay` gives the operator.
   *
   * A method on `Runner` rather than something the chat assembles from `ctx.prober` and
   * `ctx.protocols`: those happen to be the same instances the runner holds today, but
   * `ChatToolContext` takes them as four independent optional fields, so a free function could
   * describe a world the run will not use and nothing would notice. Reading `this.opts` makes
   * "the same collaborators" true by construction.
   *
   * **A forecast, not a promise.** `execute()` resolves capabilities again at dispatch, after
   * its own `plan()` — deliberately, because an operator's protocol edit must reach the next
   * audit — so the answer here can be overtaken. The wording it feeds says so.
   *
   * Four things it must not do, each of which the extraction made easy to get wrong:
   *
   * - **No `revisions.sweep()`.** `execute()` sweeps before reading the protocol. A read that
   *   appended revision rows as a side effect would write an `observed` entry into the history
   *   every time somebody asked a question, which is precisely the corruption the history
   *   exists to make impossible.
   * - **No lease in the answer.** `benchHost` and `browserEndpoint` are internal addresses,
   *   and this reply is reachable from `routes/mcp-admin.ts`, which authenticates nobody.
   * - **No events, no `note()`.** It is a read.
   * - **Section ids only** — no rubric bodies crossing into a chat turn.
   */
  async forecast(job?: Pick<RunnerJob, 'trial'>): Promise<Forecast> {
    const plan = await this.plan();
    if (!plan || plan.sections.length === 0) return { run: [], blocked: [], noProtocol: true };
    const { run, blocked } = resolveCapabilities(
      plan.sections,
      liveWorld({ ...this.opts, ...(job?.trial ? { trial: job.trial } : {}) }),
    );
    return {
      run: run.map((s) => s.id as Section),
      blocked: blocked.map((b) => ({ section: b.section.id as Section, reason: b.reason })),
    };
  }

  async run(job: RunnerJob): Promise<RunOutcome> {
    if (!this.enabled) {
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

  /**
   * The store a subject belongs to.
   *
   * Falls back to the Yundera store rather than failing: a subject whose origin has been taken
   * out of `config.yaml` still has reports and can still be asked for by hand, and refusing to
   * audit it would be a worse answer than auditing it against the store it came from.
   */
  private originOf(id: string): OriginEntry {
    return (
      this.opts.origins?.find((o) => o.id === id) ??
      { id, repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' }
    );
  }

  private async execute(job: RunnerJob): Promise<RunOutcome> {
    const events = this.opts.events;
    const startedAt = this.now().toISOString();
    const { origin, name: appName } = splitSubjectKey(job.subject);
    const store = job.trial
      ? { id: origin, repo: job.trial.repo, ref: 'main', apps_path: job.trial.apps_path }
      : this.originOf(origin);
    // A trial's reports go where the index does not look; an assay's go to the archive.
    const reportsRoot = job.trial?.root ?? this.opts.reportsRoot;

    // Before anything else, and before a try is spent: if the store this subject came from
    // cannot be read, there is nothing to audit *against*. `blocked` restores the subject
    // untouched — no try burned, no finish stamped — which is the whole distinction between
    // "we could not look" and "the app is broken".
    if (!job.trial && this.opts.storeReachable && !this.opts.storeReachable(origin)) {
      const why = this.opts.storeFailure?.(origin);
      events.log({
        level: 'warn',
        code: 'ASSAY_BLOCKED',
        message: `The ${store.repo} store could not be read, so ${appName} was not audited`,
        subject: job.subject,
        detail: { subject: job.subject, reason: 'store_unreachable' },
      });
      return { kind: 'blocked', reason: why ? `store_unreachable: ${why}` : 'store_unreachable' };
    }

    // ── what this run is made of ─────────────────────────────────────────────────────────
    // Record what is about to judge this run, before reading it. Every assay stamps the
    // sha256 of the protocol that graded it, and this is what guarantees those bytes are in
    // the history to be read back — including when the rubric was last changed by somebody
    // with an editor and a shell rather than by this app.
    //
    // After the store-reachability gate above on purpose: a run blocked by infra should not
    // manufacture a revision row. Awaited, not fired off, or it races the read below.
    await this.opts.revisions?.sweep();
    // The same guarantee for the reference material: a page that changed what an audit
    // concluded has to be readable back, and this is the last moment before it is read.
    await this.opts.kbRevisions?.sweep();

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
    // `capabilities.ts` holds the partition itself, so `Runner.forecast()` can tell the chat
    // what a run would cover without a second copy of this decision. Destructured back into
    // the same names the rest of this method already used: the point of the move is that
    // nothing below it changed.
    const {
      run: runSections,
      blocked: skipped,
      lease: { benchHost, benchBuild, browserEndpoint },
    } = resolveCapabilities(
      plan.sections,
      liveWorld({ ...this.opts, ...(job.trial ? { trial: job.trial } : {}) }),
    );

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

    // ── who performs each section ────────────────────────────────────────────────────────
    // The second partition, and the reason it is here rather than inside the prompt builder:
    // a scripted section must not reach the agent at all. It is not a rubric, there is nothing
    // for a model to read, and asking one to do arithmetic it is bad at — over a tag list that
    // would crowd the real audit out of the context — is the thing this seam exists to avoid.
    const agentSections = runSections.filter((s) => s.executor.kind === 'agent');
    const scriptSections = runSections.filter((s) => s.executor.kind !== 'agent');
    const subjectRef = subjectRefOf(store, appName);
    // Read once, at dispatch, and carried onto every assay of this run: what the audit is
    // about is the version it started against, not whatever the store holds when it ends.
    const subjectSha = this.opts.subjectVersion?.(job.subject);

    // Scripts run first, because they take seconds where the agent takes minutes and the run's
    // own state is simpler while nothing is in flight.
    //
    // They are **not** kept when the agent call then fails: a busy agent must restore the
    // subject exactly as it was (invariant 3), and writing a report file on that path would
    // make "nothing happened" observably untrue. The cost is one wasted reading on an agent
    // outage, which is seconds, against a retry minutes later that takes it again.
    const scriptAssays = await this.runScripts(scriptSections, {
      subject: job.subject,
      appName,
      ...(origin ? { origin } : {}),
      store,
      subjectRef,
      ...(subjectSha ? { subjectSha } : {}),
      startedAt,
      ...(job.trial?.source?.compose ? { compose: job.trial.source.compose } : {}),
    });

    // Nothing for the agent to do. A protocol of scripted sections only is a legitimate
    // configuration — and without this the run would build a prompt with an empty rubric and
    // ask the agent to audit nothing.
    if (agentSections.length === 0) {
      const finishedAt = this.now().toISOString();
      const blockedAssays = skipped.map(({ section, reason }) =>
        blockedSectionAssay({
          subject: appName,
          ...(origin ? { origin } : {}),
          section: this.assaySection(section),
          reason,
          startedAt,
          finishedAt,
          subjectRef,
          ...(subjectSha ? { subjectSha } : {}),
        }),
      );
      return this.publish(job, [...scriptAssays, ...blockedAssays], reportsRoot, events);
    }

    // The ticket. Minted per dispatch, dead when the run ends — see `services/ledger.ts` for
    // why this is not a shared secret.
    const canonical = agentSections.flatMap((section) =>
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
            sections: agentSections.map((s) => ({
              id: s.id,
              name: s.name,
              phases: s.phases.map((p) => p.id),
            })),
            canonical,
          })
        : null;

    // Only the pages that bear on what is being audited. `forSections` reads the frontmatter;
    // a run with no live section is given nothing about the dashboard it never opens.
    const kb = this.opts.kb
      ? await this.opts.kb.forSections(agentSections.map((s) => s.id)).catch(() => null)
      : null;

    const { prompt } = buildPrompt({
      app_name: appName,
      repo: store.repo,
      ref: store.ref,
      apps_path: store.apps_path,
      // A trial always supplies its own bytes; an assay fetches the subject with `gh`.
      ...(job.trial ? { source: job.trial.source } : {}),
      ...(job.trial?.store_url ? { store_url: job.trial.store_url } : {}),
      protocols: {
        ...(plan.orchestrator ? { orchestrator: plan.orchestrator } : {}),
        sections: agentSections.map((s) => ({
          id: s.id,
          name: s.name,
          body: s.body,
          phases: s.phases,
          requires: s.requires,
        })),
      },
      ...(kb ? { kb: { index: kb.index, docs: kb.docs.map((d) => ({ file: d.file, title: d.title, body: d.body })) } } : {}),
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
      const waitMs = this.backoffOverrideMs ?? this.opts.busyBackoffMs ?? DEFAULT_BACKOFF_MS;
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
      subjectRef: subjectRefOf(store, appName),
      ...(subjectSha ? { subjectSha } : {}),
      declared: outcome.report,
      // The sections that actually ran, and — recorded rather than dropped — the ones that
      // could not, so a run always produces one file per section and the store can say "not
      // checked" instead of nothing.
      sections: agentSections.map((s) => this.assaySection(s)),
      blocked: skipped.map(({ section, reason }) => ({ section: this.assaySection(section), reason })),
      startedAt,
      finishedAt,
      ...(benchHost ? { benchHost } : {}),
      ...(benchBuild ? { benchBuild } : {}),
      ...(browserEndpoint ? { browserEndpoint } : {}),
      ...(kb ? { kbSha256: kb.sha256 } : {}),
      ...(flagged ? { requirements: flagged.requirements, phases: flagged.phases } : {}),
    });

    return this.publish(job, [...assays, ...scriptAssays], reportsRoot, events);
  }

  /**
   * Write one run's assays, index them, log the completion and answer the scheduler.
   *
   * Shared by the agent path and the scripts-only path so there is one definition of what
   * finishing means. The headline comes from `assays[0]`, which is the first section in
   * protocol order — a scripted, non-scoring section carries `verdict: null`, so a run made
   * entirely of measurements answers `none` rather than inventing a verdict.
   */
  private async publish(
    job: RunnerJob,
    assays: { meta: AssayMeta; body: string }[],
    reportsRoot: string,
    events: EventLog,
  ): Promise<RunOutcome> {
    const files: string[] = [];
    for (const assay of assays) {
      const res = await writeReport(reportsRoot, assay.meta, assay.body);
      files.push(res.rel);
      // `recordFor` rather than a second literal: how a record is derived from a file is one
      // definition, shared with `buildIndex`'s scan, so the in-memory record and the one a
      // restart would rebuild cannot drift apart.
      //
      // A trial is deliberately not upserted. This one line is what keeps an unmerged branch
      // from moving a hallmark, entering the backlog, or ageing a subject's freshness.
      if (!job.trial) this.opts.index?.upsert(recordFor(assay.meta, res.rel));
    }

    const blocked = assays.find((a) => a.meta.status === 'blocked');
    const headline = assays[0]?.meta;
    events.log({
      level: 'info',
      code: 'ASSAY_COMPLETED',
      message: blocked
        ? 'An audit finished, but one of its sections could not run'
        : 'An audit finished',
      subject: job.subject,
      detail: {
        subject: job.subject,
        verdict: String(headline?.verdict ?? 'none'),
        risk: headline?.risk_score ?? 0,
        sections: assays.map((a) => a.meta.section),
        blocked: blocked ? String(blocked.meta.blocked_reason ?? 'unknown') : null,
      },
    });

    return {
      kind: 'verdict',
      verdict: String(headline?.verdict ?? 'none'),
      risk: headline?.risk_score ?? 0,
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
   * Perform the sections whose executor is a script, one assay each.
   *
   * Everything a check needs arrives on **stdin**; nothing is interpolated into a command
   * line, because subject names come out of a GitHub directory listing and a directory called
   * `; rm -rf ~` is something a stranger can open a pull request for.
   *
   * `compose` is passed when we already hold the app's own bytes — an upload trial does. When
   * we do not, the coordinates are passed instead and the script fetches for itself, which is
   * what keeps Touchstone from needing to know how any particular store serves a file.
   *
   * A failure here never propagates: the section records blocked, the run carries on, and the
   * subject keeps its place. A check that could take the audit down with it would be a worse
   * deal than not having the check.
   */
  private async runScripts(
    sections: ProtocolSection[],
    ctx: {
      subject: SubjectKey;
      appName: string;
      origin?: string;
      store: OriginEntry;
      subjectRef: string;
      subjectSha?: string;
      startedAt: string;
      compose?: string;
    },
  ): Promise<{ meta: AssayMeta; body: string }[]> {
    const out: { meta: AssayMeta; body: string }[] = [];
    for (const section of sections) {
      const started = this.now().toISOString();
      const file = section.executor.kind === 'script' ? section.executor.file : null;
      // An executor we would not run is recorded, not ignored. Downgrading it to the agent
      // would answer the same question by guesswork and look identical in the archive.
      const ref: ExecutorRef | null = file ? await this.opts.protocols?.executor(file) ?? null : null;

      const run: ScriptRun = ref
        ? await runScript({
            path: ref.path,
            input: {
              subject: ctx.appName,
              origin: ctx.origin ?? null,
              section: section.id,
              subject_ref: ctx.subjectRef,
              repo: ctx.store.repo,
              ref: ctx.store.ref,
              apps_path: ctx.store.apps_path,
              compose: ctx.compose ?? null,
              policy: section.policy,
            },
            ...(this.opts.scriptTimeoutMs ? { timeoutMs: this.opts.scriptTimeoutMs } : {}),
          })
        : {
            ok: false,
            reason: 'spawn',
            detail:
              section.executor.kind === 'invalid'
                ? `\`${section.executor.raw}\` is not a name this app will run — an executor is a \`*.sh\` beside the protocol, with no path`
                : `no such file in the protocol directory`,
            stderr: '',
            ms: 0,
          };

      const assay = assayFromScript({
        subject: ctx.appName,
        ...(ctx.origin ? { origin: ctx.origin } : {}),
        section: this.assaySection(section),
        executor: ref ?? { file: file ?? '<none>', path: '', sha256: '' },
        run,
        scores: section.scores,
        startedAt: started,
        finishedAt: this.now().toISOString(),
        subjectRef: ctx.subjectRef,
        ...(ctx.subjectSha ? { subjectSha: ctx.subjectSha } : {}),
      });

      if (assay.meta.status === 'blocked') {
        this.opts.events.log({
          level: 'warn',
          code: 'EXECUTOR_FAILED',
          message: 'A scripted check produced no reading, so its section is recorded blocked',
          subject: ctx.subject,
          detail: {
            subject: ctx.subject,
            section: section.id,
            executor: file ?? '<none>',
            reason: String(assay.meta.blocked_reason ?? 'unknown'),
            detail: String(assay.meta.blocked_detail ?? '').slice(0, 400),
          },
        });
      }
      out.push(assay);
    }
    return out;
  }

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
      standard: { name: section.name, sha256: section.sha256 },
      phases: section.phases.map((p) => p.id),
      requires: section.requires,
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
