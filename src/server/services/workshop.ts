/**
 * The workshop — proposals authored against a bench, validated by trials, opened as PRs.
 *
 * docs/auto-app-pr.md is the design and this is its world-reading half; the decisions are
 * pure functions in `domain/workshop.ts`. The order of a proposal's life:
 *
 *   propose (a person) / slot (idle selection)
 *     → dispatch: pin the base, open a session, hand the agent its prompt
 *     → the agent edits the working copy through `routes/mcp-workshop.ts`, ends with submit
 *     → validation: one trial per platform the standard covers, queued like any trial
 *     → ready → submitPr (a person, or automatically when armed) → merged | closed
 *
 * Three rules hold throughout, and each is structural here rather than remembered:
 *
 * - **The author never judges.** Its surface has no verdict tool and validation is trials, in
 *   fresh sessions, written where the report index never looks.
 * - **Infra never charges a task** (invariant 3). An agent that is busy or logged out, a bench
 *   that vanished, a restart: the proposal goes back where it was, with a backoff, and the
 *   task's memory is not touched. Only an outcome that says something about the *task* —
 *   `cannot`, rounds exhausted, a PR opened or closed — is remembered.
 * - **The token stays here.** Nothing in a prompt, a tool result or the working copy carries
 *   it; `services/github.ts` is the only code that holds it.
 */

import { randomBytes } from 'node:crypto';

import type {
  CandidateRow,
  GitHubStatus,
  Proposal,
  ProposalDetail,
  ProposalKind,
  ProposalSummary,
  SectionResult,
  Wish,
  WorkshopLive,
  WorkshopView,
} from '../../shared/workshop.js';
import type { AssayRecord, SubjectState } from '../../shared/types.js';
import { DEFAULT_TARGET } from '../../shared/target.js';
import { asSubjectKey, subjectName, type SubjectKey } from '../../shared/subject.js';
import { buildFixReport } from '../domain/fixreport.js';
import { hallmarks, subjectHallmark } from '../domain/hallmark.js';
import { buildPrBody, prTitle } from '../domain/prbody.js';
import { readStandards } from '../domain/standards.js';
import { resolveSubjectKey } from '../domain/subjects.js';
import type { AssayStore } from '../domain/store.js';
import {
  candidates as candidateRows,
  crossesMajor,
  currencyOf,
  findingsOf,
  judgeValidation,
  quota,
  refFor,
  resultOf,
  taskKey,
} from '../domain/workshop.js';
import { classify, postToAgent, type AgentOptions, type AgentRaw } from '../runner/agent.js';
import type { OriginEntry } from '../store/config.js';
import type { KbStore } from '../store/kb.js';
import { sectionsOf, type ProtocolSection, type ProtocolStore } from '../store/protocols.js';
import type { SubjectRegistry } from '../store/registry.js';
import type { WishlistStore } from '../store/wishlist.js';
import { ACTIVE_STATES, WorkshopError, type WorkshopStore } from '../store/workshop.js';
import { buildAuthorPrompt } from '../workshop/prompt.js';
import type { AlertStore } from './alerts.js';
import type { EventLog } from './events.js';
import { branchOf, GitHubClient, GitHubError, type TreeEntry } from './github.js';
import { WORKSHOP_LABEL, type GitHubProbe } from './githubprobe.js';
import type { GitHubTokenStore } from '../store/githubtoken.js';
import type { Lease, Leases } from './leases.js';
import type { StoreDocReader } from './storedoc.js';
import { enqueueTrial, specFromFiles, trialIndex, trialsReady, type TrialRunDeps } from './trialrun.js';
import { archiveUrlForCommit, extractApp, fetchStoreZip, packAppStore } from './trialstore.js';

/** Free re-enqueues of a validation trial after an infra outcome. */
const MAX_TRIAL_RETRIES = 3;
/** Free re-queues of an authoring session after an infra outcome, before it is given up. */
const MAX_INFRA = 6;
/** A staged zip lives this long — long enough to install and iterate, not for ever. */
const STAGE_TTL_MS = 3 * 60 * 60_000;

export interface WorkshopSettings {
  origin: string;
  armed: boolean;
  prs_per_day: number;
  max_rounds: number;
  session_minutes: number;
  currency_section: string;
  login: string;
  commit_name: string;
  commit_email: string;
}

export interface WorkshopOptions {
  store: WorkshopStore;
  settings: WorkshopSettings;
  origins: OriginEntry[];
  github?: GitHubClient;
  probe: GitHubProbe;
  /**
   * Where a token set from the Settings page is kept. Absent, `setToken` refuses and the only
   * way to configure GitHub is the one the process booted with.
   */
  tokens?: GitHubTokenStore;
  /** Whether `github` came from the page's stored token or from config/env at boot. */
  tokenSource?: 'page' | 'boot';
  /** The config/env token, which clearing the page's token falls back to. Empty for none. */
  bootToken?: string;
  /** Injected in tests. */
  makeGitHub?: (token: string, repo: string) => GitHubClient;
  /** Touchstone's public address — where a bench fetches a staged or validated store. */
  publicBaseUrl: string;
  /** The workshop MCP surface the agent calls back on. */
  callbackUrl: string;
  agent: AgentOptions;
  /** Read live: the runner switch and its backoff. */
  runner: { enabled: boolean; busyBackoffMin: number };
  index: AssayStore;
  registry?: Pick<SubjectRegistry, 'list' | 'delisted' | 'versions' | 'versionOf'>;
  protocols?: ProtocolStore;
  kb?: KbStore;
  storedoc?: StoreDocReader;
  wishlist?: WishlistStore;
  trialDeps: () => TrialRunDeps;
  trialsRoot: string;
  leases?: Leases;
  alerts?: AlertStore;
  events: EventLog;
  /** Ask the scheduler to look now. */
  kick?: () => void;
  fetchImpl?: typeof fetch;
  /** Injected in tests. */
  postAgent?: (prompt: string, opts: AgentOptions) => Promise<AgentRaw>;
  now?: () => Date;
}

interface Session {
  proposal: string;
  expires_at: number;
  ended?: { kind: 'submit'; summary: string } | { kind: 'cannot'; reason: string };
}

interface Stage {
  zip: Buffer;
  subject: string;
  expires_at: number;
}

export class Workshop {
  private readonly sessions = new Map<string, Session>();
  private readonly stages = new Map<string, Stage>();
  private live?: { id: string; label: string; started_at: string; token: string; browser?: string; app?: string };
  private prsPerDayOverride?: number;
  private openPrs: { apps: Set<string> | null; at: number } = { apps: null, at: 0 };
  private evaluating = new Set<string>();
  /**
   * The candidate list, briefly. `slot()` is asked on every tick *and* on every queue preview,
   * which the UI polls every few seconds; recomputing every hallmark and re-reading the rubric
   * for each poll would be work for nothing. Anything that acts reads it fresh.
   */
  private candidateCache?: { at: number; rows: CandidateRow[] };

  /** The client every GitHub call goes through — replaced when the page sets a token. */
  private gh: GitHubClient | undefined;
  private tokenSource: 'page' | 'boot' | null;
  private tokenSetAt?: string;

  constructor(private readonly opts: WorkshopOptions) {
    this.gh = opts.github;
    this.tokenSource = opts.github ? (opts.tokenSource ?? 'boot') : null;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  // ── configuration and switches ───────────────────────────────────────────────────────

  get origin(): OriginEntry | undefined {
    return this.opts.origins.find((o) => o.id === this.opts.settings.origin);
  }

  /** Why the workshop cannot work, or null when it can. */
  unconfigured(): string | null {
    if (!this.origin) return `workshop.origin "${this.opts.settings.origin}" is not a configured origin`;
    if (!this.gh) return 'no GitHub token — set one in Settings (or TOUCHSTONE_GITHUB_TOKEN / github.token)';
    if (!this.opts.publicBaseUrl) return 'trials.public_base_url is empty, so no bench can install a proposal';
    return null;
  }

  get armed(): boolean {
    return this.opts.store.armed ?? this.opts.settings.armed;
  }

  get armedDefault(): boolean {
    return this.opts.settings.armed;
  }

  async setArmed(armed: boolean, by: string): Promise<void> {
    await this.opts.store.setArmed(armed);
    this.opts.events.log({
      level: 'warn',
      code: armed ? 'WORKSHOP_ARMED' : 'WORKSHOP_DISARMED',
      message: armed
        ? 'The workshop was armed — it will pick its own work and open pull requests within the quota'
        : 'The workshop was disarmed — nothing is picked or submitted automatically',
      detail: { armed, by },
    });
    this.opts.kick?.();
  }

  async clearArmed(by: string): Promise<void> {
    await this.opts.store.setArmed(undefined);
    this.opts.events.log({
      level: 'info',
      code: this.armed ? 'WORKSHOP_ARMED' : 'WORKSHOP_DISARMED',
      message: 'The workshop switch went back to what config.yaml says',
      detail: { armed: this.armed, by },
    });
  }

  get prsPerDay(): number {
    return this.prsPerDayOverride ?? this.opts.settings.prs_per_day;
  }

  get prsPerDayDefault(): number {
    return this.opts.settings.prs_per_day;
  }

  setPrsPerDay(n: number): void {
    this.prsPerDayOverride = Math.max(0, Math.floor(n));
  }

  clearPrsPerDay(): void {
    this.prsPerDayOverride = undefined;
  }

  quotaNow(): ReturnType<typeof quota> {
    const since = new Date(this.now().getTime() - 86_400_000).toISOString();
    return quota(this.prsPerDay, this.opts.store.prsOpenedSince(since), this.now());
  }

  github(): GitHubStatus {
    return this.opts.probe.status();
  }

  /** Where the token in use came from — never the token. */
  tokenInfo(): WorkshopView['github_token'] {
    const repo = this.origin?.repo;
    const login = this.opts.settings.login;
    return {
      source: this.tokenSource,
      ...(this.tokenSetAt ? { set_at: this.tokenSetAt } : {}),
      settable: !!this.opts.tokens,
      boot_token: !!this.opts.bootToken,
      ...(repo ? { repo } : {}),
      ...(login ? { expected_login: login } : {}),
    };
  }

  /**
   * Set the token from the Settings page, or clear it (`null`) back to whatever the process
   * booted with. Takes effect at once: the client is swapped and the probe asked, so the
   * answer to "does this token work" comes back in the same response.
   *
   * An authoring session already running keeps going; its submit reads the new client. The
   * token itself is never logged — the event names who did it and which source is now live.
   */
  async setToken(token: string | null, by: string): Promise<GitHubStatus> {
    const tokens = this.opts.tokens;
    if (!tokens) throw new WorkshopRefusal(503, 'no data directory to keep a GitHub token in');
    const origin = this.origin;
    if (token === null) {
      await tokens.clear();
      const boot = this.opts.bootToken;
      this.tokenSetAt = undefined;
      this.tokenSource = boot && origin ? 'boot' : null;
      this.gh = boot && origin ? this.client(boot, origin.repo) : undefined;
    } else {
      if (!origin) throw new WorkshopRefusal(409, this.unconfigured() ?? 'the workshop has no origin');
      await tokens.write(token);
      this.tokenSetAt = this.now().toISOString();
      this.tokenSource = 'page';
      this.gh = this.client(token, origin.repo);
    }
    this.openPrs = { apps: null, at: 0 };
    this.opts.probe.setClient(this.gh);
    this.opts.events.log({
      level: 'warn',
      code: token === null ? 'GITHUB_TOKEN_CLEARED' : 'GITHUB_TOKEN_SET',
      message:
        token === null
          ? this.gh
            ? 'The GitHub token set on the Settings page was cleared; the one from config.yaml / the environment applies again'
            : 'The GitHub token set on the Settings page was cleared; the workshop has no token now'
          : 'A GitHub token was set on the Settings page; pull requests are now opened as its account',
      detail: { by, source: this.tokenSource ?? 'none' },
    });
    const status = this.gh ? await this.opts.probe.probe() : this.opts.probe.status();
    this.opts.kick?.();
    return status;
  }

  /** At boot, when the page's stored token is what the composition root chose. */
  noteStoredToken(setAt: string): void {
    if (this.tokenSource === 'page') this.tokenSetAt = setAt;
  }

  private client(token: string, repo: string): GitHubClient {
    return this.opts.makeGitHub ? this.opts.makeGitHub(token, repo) : new GitHubClient({ token, repo });
  }

  // ── the world ────────────────────────────────────────────────────────────────────────

  private async sections(): Promise<ProtocolSection[]> {
    if (!this.opts.protocols) return [];
    try {
      return sectionsOf(await this.opts.protocols.list());
    } catch {
      return [];
    }
  }

  private async subjects(): Promise<SubjectState[]> {
    let standards;
    try {
      standards = this.opts.protocols ? (await readStandards(this.opts.protocols)).sections : undefined;
    } catch {
      standards = undefined;
    }
    return hallmarks(this.opts.index.all(), {
      include: this.opts.registry?.list() ?? [],
      ...(standards ? { standards } : {}),
      ...(this.opts.registry ? { versions: this.opts.registry.versions(), delisted: this.opts.registry.delisted() } : {}),
    });
  }

  private async wishes(): Promise<Wish[]> {
    return this.opts.wishlist ? this.opts.wishlist.list().catch(() => []) : [];
  }

  /** Apps with an open PR by anybody. Refreshed at most every 30 minutes, or on demand. */
  async openPrApps(force = false): Promise<Set<string> | null> {
    const gh = this.gh;
    const origin = this.origin;
    if (!gh || !origin) return null;
    if (!force && this.now().getTime() - this.openPrs.at < 30 * 60_000) return this.openPrs.apps;
    try {
      this.openPrs = { apps: await gh.openPullApps(origin.apps_path), at: this.now().getTime() };
    } catch {
      this.openPrs = { apps: null, at: this.now().getTime() };
    }
    return this.openPrs.apps;
  }

  async candidates(fresh = true): Promise<CandidateRow[]> {
    const now = this.now().getTime();
    if (!fresh && this.candidateCache && now - this.candidateCache.at < 15_000) return this.candidateCache.rows;
    const rows = await this.computeCandidates();
    this.candidateCache = { at: now, rows };
    return rows;
  }

  private async computeCandidates(): Promise<CandidateRow[]> {
    const origin = this.origin;
    if (!origin) return [];
    const sections = await this.sections();
    const scoring = new Set(sections.filter((s) => s.scores).map((s) => s.id));
    const subjects = await this.subjects();
    const offered = new Set<string>([
      ...(this.opts.registry?.list() ?? []).map((k) => subjectName(k)),
      ...(this.opts.registry?.delisted() ?? []).map((k) => subjectName(k)),
    ]);
    const active = new Set(this.opts.store.list().filter((p) => ACTIVE_STATES.includes(p.state)).map((p) => p.task_key));
    return candidateRows({
      subjects,
      origin: origin.id,
      scoring,
      ...(this.opts.settings.currency_section ? { currencySection: this.opts.settings.currency_section } : {}),
      versions: this.opts.registry?.versions() ?? {},
      standardShas: sections.filter((s) => s.scores).map((s) => s.sha256),
      openPrApps: await this.openPrApps(),
      memory: this.opts.store.memory(),
      active,
      wishes: await this.wishes(),
      offered,
    });
  }

  // ── asking ───────────────────────────────────────────────────────────────────────────

  /**
   * An operator asks for one proposal. It goes into the queue like a request: it waits for
   * nothing but quiet and a free pair, and it ignores `armed` — a person asking outranks the
   * switch, which is about the workshop helping itself.
   */
  async propose(input: { subject?: string; wish?: string; kind: ProposalKind }, by: string): Promise<Proposal> {
    const problem = this.unconfigured();
    if (problem) throw new WorkshopRefusal(503, problem);
    if (!this.opts.runner.enabled) throw new WorkshopRefusal(409, 'the runner is disabled — set runner.enabled');
    const rows = await this.candidates();
    let row: CandidateRow | undefined;
    if (input.kind === 'wish') {
      row = rows.find((r) => r.kind === 'wish' && r.wish_file === input.wish);
      if (!row) throw new WorkshopRefusal(404, `no usable wish file ${input.wish ?? ''}`);
    } else {
      const resolved = resolveSubjectKey(String(input.subject ?? ''), this.opts.registry?.list() ?? []);
      if (resolved.kind !== 'ok') throw new WorkshopRefusal(404, `${input.subject ?? ''} is not an app a store offers`);
      row = rows.find((r) => r.kind === input.kind && r.subject === resolved.key);
      if (!row) {
        throw new WorkshopRefusal(
          409,
          input.kind === 'fix'
            ? `${subjectName(resolved.key)} has no non-compliant verdict on ${this.opts.settings.origin} to fix`
            : `${subjectName(resolved.key)} is not compliant and behind its upstream, so there is no update to propose`,
        );
      }
    }
    // A person may retry what memory parked, and may ask past an open PR they know about —
    // but not past a proposal already in flight, or a delisted app.
    const hard = row.reasons.filter((r) => /in flight|delisted|not a usable|already offers|is missing|frontmatter/.test(r));
    if (hard.length > 0) throw new WorkshopRefusal(409, hard.join('; '));
    return this.create(row, 'operator', by);
  }

  private async create(row: CandidateRow, cls: 'operator' | 'idle', by: string): Promise<Proposal> {
    const origin = this.origin!;
    const at = this.now().toISOString();
    let p: Proposal;
    try {
      p = await this.opts.store.create({
        kind: row.kind,
        task_key: row.task_key,
        app: row.app,
        ...(row.subject ? { subject: row.subject } : {}),
        ...(row.wish_file ? { wish_file: row.wish_file } : {}),
        origin: origin.id,
        class: cls,
        asked_at: at,
        by,
        input_sha: row.input_sha,
        max_rounds: this.opts.settings.max_rounds,
      });
    } catch (err) {
      if (err instanceof WorkshopError) throw new WorkshopRefusal(409, err.message);
      throw err;
    }
    this.opts.events.log({
      level: 'info',
      code: 'PROPOSAL_QUEUED',
      message: `Queued a ${row.kind} proposal for ${row.app}`,
      detail: { proposal: p.id, kind: row.kind, app: row.app, class: cls, by },
    });
    this.opts.kick?.();
    return p;
  }

  // ── the queue ────────────────────────────────────────────────────────────────────────

  running(): { id: string; label: string; started_at: string } | undefined {
    return this.live ? { id: this.live.id, label: this.live.label, started_at: this.live.started_at } : undefined;
  }

  /** The app an authoring session is driving this browser for — the live browser panel. */
  runningOn(browserUrl: string): string | null {
    return this.live?.browser === browserUrl ? (this.live.app ?? null) : null;
  }

  liveView(): WorkshopLive | undefined {
    if (!this.live) return undefined;
    const p = this.opts.store.get(this.live.id);
    if (!p) return undefined;
    return { id: p.id, app: p.app, kind: p.kind, state: p.state, round: p.round, ...(p.started_at ? { started_at: p.started_at } : {}) };
  }

  /**
   * What the workshop would author next, or nothing. Called every tick; never writes.
   *
   * An idle candidate is offered as `cand:<task key>` and only becomes a proposal when the
   * scheduler actually dispatches it, so previewing the queue cannot create work.
   */
  async slot(): Promise<{ id: string; label: string; class: 'operator' | 'idle'; asked_at: string } | undefined> {
    if (this.unconfigured() || !this.opts.runner.enabled || this.live) return undefined;
    await this.reconcile().catch(() => undefined);
    const now = this.now().getTime();
    const waiting = this.opts.store
      .list()
      .filter((p) => (p.state === 'queued' || p.state === 'revising') && !(p.backoff_until && Date.parse(p.backoff_until) > now))
      .sort((a, b) => {
        // A revision finishes what was started before anything new is begun.
        const ra = a.state === 'revising' ? 0 : 1;
        const rb = b.state === 'revising' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        const ca = a.class === 'operator' ? 0 : 1;
        const cb = b.class === 'operator' ? 0 : 1;
        return ca - cb || a.asked_at.localeCompare(b.asked_at);
      });
    const next = waiting[0];
    if (next) {
      return { id: next.id, label: `${verb(next.kind)} ${next.app}`, class: next.class, asked_at: next.asked_at };
    }
    if (!this.armed) return undefined;
    if (!this.quotaNow().allowed) return undefined;
    if (this.opts.store.list().some((p) => p.state === 'ready' || p.state === 'validating')) return undefined;
    const pick = (await this.candidates(false)).find((c) => c.eligible);
    if (!pick) return undefined;
    return { id: `cand:${pick.task_key}`, label: pick.label, class: 'idle', asked_at: new Date(now).toISOString() };
  }

  /** The scheduler starts one. The lease is ours until this returns. */
  async dispatch(id: string, lease?: Lease): Promise<void> {
    let p: Proposal | undefined;
    try {
      if (id.startsWith('cand:')) {
        const key = id.slice('cand:'.length);
        const row = (await this.candidates()).find((c) => c.task_key === key && c.eligible);
        if (!row) return;
        p = await this.create(row, 'idle', 'workshop');
      } else {
        p = this.opts.store.get(id);
      }
      if (!p || (p.state !== 'queued' && p.state !== 'revising')) return;
      await this.author(p, lease);
    } finally {
      this.opts.leases?.release(lease?.id);
      this.live = undefined;
      this.opts.kick?.();
    }
  }

  async failed(id: string, reason: string): Promise<void> {
    const p = this.opts.store.get(id);
    if (p) await this.infra(p, `dispatch failed: ${reason}`);
  }

  // ── authoring ────────────────────────────────────────────────────────────────────────

  private async author(p0: Proposal, lease?: Lease): Promise<void> {
    const origin = this.origin!;
    const started = this.now().toISOString();
    let p = await this.opts.store.update(p0.id, { state: 'authoring', started_at: started, backoff_until: undefined });
    const token = randomBytes(24).toString('base64url');
    this.live = { id: p.id, label: `${verb(p.kind)} ${p.app}`, started_at: started, token };

    const bench = lease?.bench?.url;
    const browser = lease?.browser?.url;
    this.live = { ...this.live, ...(browser ? { browser } : {}), app: p.app };
    if (!bench || !browser) {
      await this.infra(p, !bench ? 'no demo bench was free' : 'no browser was free');
      return;
    }

    try {
      if (!(await this.opts.store.hasBase(p.id))) p = await this.pinBase(p);
    } catch (err) {
      await this.infra(p, `could not read the store at its head: ${(err as Error).message}`);
      return;
    }

    this.opts.events.log({
      level: 'info',
      code: 'AUTHORING_STARTED',
      message: `Authoring ${verb(p.kind)} ${p.app} (round ${p.round})`,
      detail: { proposal: p.id, app: p.app, round: p.round, bench },
    });

    const sections = await this.sections();
    const scoring = sections.filter((s) => s.scores);
    // One rubric body per file: a target-scoped rubric expands into a section per platform
    // with the same prose, and the author needs to read it once.
    const rubrics = [...new Map(scoring.map((s) => [s.rubric, { id: s.rubric, name: s.name, body: s.body }])).values()];
    const kb = this.opts.kb ? await this.opts.kb.forSections(scoring.map((s) => s.id)).catch(() => null) : null;
    const contributing = this.opts.storedoc
      ? await this.opts.storedoc
          .read({ id: origin.id, repo: origin.repo, ref: p.base_sha ?? origin.ref }, 'CONTRIBUTING.md')
          .then((d) => (d.kind === 'file' ? d.text : null))
          .catch(() => null)
      : null;

    this.sessions.set(token, {
      proposal: p.id,
      expires_at: this.now().getTime() + (this.opts.settings.session_minutes + 10) * 60_000,
    });

    const prompt = buildAuthorPrompt({
      kind: p.kind,
      app: p.app,
      repo: origin.repo,
      ref: origin.ref,
      apps_path: origin.apps_path,
      brief: await this.brief(p),
      contributing,
      rubrics,
      kb: kb ? { index: kb.index, docs: kb.docs.map((d) => ({ file: d.file, title: d.title, body: d.body })) } : null,
      author: await this.opts.store.authorInstructions(),
      bench,
      browser,
      callback: { url: this.opts.callbackUrl, session_token: token },
      feedback: p.round > 1 ? await this.opts.store.feedback(p.id) : null,
      round: p.round,
      max_rounds: p.max_rounds,
    });

    const post = this.opts.postAgent ?? postToAgent;
    let raw: AgentRaw;
    try {
      raw = await post(prompt, { ...this.opts.agent, timeoutS: this.opts.settings.session_minutes * 60 });
    } catch (err) {
      raw = { ok: false, errorText: `Error calling remote tool: ${(err as Error).message}` };
    }
    const session = this.sessions.get(token);
    this.sessions.delete(token);
    p = this.opts.store.get(p.id) ?? p;

    if (session?.ended?.kind === 'submit') {
      this.ended(p, 'submitted');
      await this.startValidation(p, session.ended.summary);
      return;
    }
    if (session?.ended?.kind === 'cannot') {
      this.ended(p, 'cannot', session.ended.reason);
      await this.cannot(p, session.ended.reason);
      return;
    }
    if (!raw.ok) {
      const cls = classify(raw.errorText);
      if (cls.ok === false && (cls.error === 'agent-auth' || cls.error === 'agent-busy')) {
        if (cls.error === 'agent-auth') {
          this.opts.alerts?.open({
            key: 'agent.auth',
            title: 'The agent is not logged in',
            detail: 'The workshop asked the agent to author a proposal and was told its session is dead.',
            impact: 'No audit, trial or proposal can run until the agent is logged in again.',
          });
        }
        this.ended(p, 'infra', cls.error);
        await this.infra(p, cls.error === 'agent-auth' ? 'the agent is not logged in' : 'the agent was busy');
        return;
      }
    }
    const why = raw.ok
      ? 'the session ended without calling submit or cannot'
      : `the agent call failed: ${raw.errorText.slice(0, 200)}`;
    this.ended(p, 'failed round', why);
    await this.failRound(p, `Round ${p.round} did not produce a submission: ${why}.`);
  }

  private ended(p: Proposal, outcome: string, reason?: string): void {
    this.opts.events.log({
      level: 'info',
      code: 'AUTHORING_ENDED',
      message: `Authoring ${p.app} ended — ${outcome}`,
      detail: { proposal: p.id, app: p.app, round: p.round, outcome, ...(reason ? { reason } : {}) },
    });
  }

  /** Record the commit the proposal is built on, and lay the app out as it was there. */
  private async pinBase(p: Proposal): Promise<Proposal> {
    const gh = this.gh!;
    const origin = this.origin!;
    const base = await gh.headOf(origin.ref);
    const appTree = await gh.appTreeSha(origin.apps_path, p.app, base);
    if (p.kind === 'wish' && appTree) throw new Error(`${p.app} already exists in ${origin.repo}`);
    if (p.kind !== 'wish' && !appTree) throw new Error(`${p.app} is not in ${origin.repo} at ${base.slice(0, 7)}`);
    let files = new Map<string, Uint8Array>();
    if (appTree) {
      const zip = await fetchStoreZip(archiveUrlForCommit(origin.repo, base), {
        ...(this.opts.publicBaseUrl ? { publicBaseUrl: this.opts.publicBaseUrl } : {}),
        ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      });
      files = extractApp(zip, origin.apps_path, p.app);
    }
    await this.opts.store.setBase(p.id, files);
    const patch: Partial<Proposal> = { base_sha: base, app_tree_sha: appTree };
    if (p.kind === 'fix' && p.subject) {
      const state = await this.stateOf(p.subject);
      const scoring = new Set((await this.sections()).filter((s) => s.scores).map((s) => s.id));
      if (state) patch.before_findings = findingsOf(state.sections, scoring);
    }
    if (p.kind === 'currency' && p.subject) {
      const state = await this.stateOf(p.subject);
      const meta = state?.sections[this.opts.settings.currency_section]?.meta;
      const c = currencyOf(meta);
      const pinned = Array.isArray(meta?.rows)
        ? meta!.rows!.map((r) => r.pinned).find((v): v is string => typeof v === 'string')
        : undefined;
      if (c.latest) patch.to_version = c.latest;
      patch.major = crossesMajor(pinned, c.latest);
    }
    return this.opts.store.update(p.id, patch);
  }

  private async stateOf(subject: SubjectKey): Promise<SubjectState | undefined> {
    return (await this.subjects()).find((s) => s.name === subject);
  }

  /** What this proposal is for, in the words the archive or the operator already used. */
  private async brief(p: Proposal): Promise<string> {
    if (p.kind === 'wish') {
      const w = p.wish_file ? await this.opts.wishlist?.get(p.wish_file) : null;
      if (!w) return `Integrate ${p.app}.`;
      return [`App: ${w.name}`, `Image: ${w.image}`, '', w.body].join('\n');
    }
    const state = p.subject ? await this.stateOf(p.subject) : undefined;
    if (!state) return `${verb(p.kind)} ${p.app}.`;
    if (p.kind === 'fix') {
      return (
        buildFixReport({
          subject: state.label,
          sections: Object.values(state.sections)
            .filter((r): r is AssayRecord => !!r)
            .map((r) => ({ meta: r.meta, path: r.path })),
        }) ?? `Fix ${p.app}.`
      );
    }
    const meta = state.sections[this.opts.settings.currency_section]?.meta;
    const lines = [`The image-currency reading for ${state.label}:`, '', String(meta?.summary ?? '')];
    const rows = Array.isArray(meta?.rows) ? meta!.rows! : [];
    if (rows.length > 0) {
      const cols = ['service', 'image', 'pinned', 'latest', 'behind', 'days', 'state'];
      lines.push('', `| ${cols.join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`);
      for (const r of rows) lines.push(`| ${cols.map((c) => String(r[c] ?? '')).join(' | ')} |`);
    }
    if (p.to_version) lines.push('', `Move to ${p.to_version}${p.major ? ' (a major version — check migrations)' : ''}.`);
    return lines.join('\n');
  }

  // ── outcomes ─────────────────────────────────────────────────────────────────────────

  /** Infra: back where it was, no charge, a backoff so a kick cannot spin. */
  private async infra(p: Proposal, reason: string): Promise<void> {
    const retries = p.infra_retries + 1;
    if (retries > MAX_INFRA) {
      await this.opts.store.update(p.id, { state: 'failed', reason: `infrastructure kept failing: ${reason}`, infra_retries: retries });
      this.opts.events.log({
        level: 'warn',
        code: 'PROPOSAL_FAILED',
        message: `Gave up on ${p.app} after repeated infrastructure failures — nothing was charged to the task`,
        detail: { proposal: p.id, app: p.app, reason },
      });
      return;
    }
    const until = new Date(this.now().getTime() + this.opts.runner.busyBackoffMin * 60_000).toISOString();
    await this.opts.store.update(p.id, {
      state: p.round > 1 ? 'revising' : 'queued',
      infra_retries: retries,
      backoff_until: until,
      reason,
      started_at: undefined,
    });
    this.opts.events.log({
      level: 'warn',
      code: 'PROPOSAL_INFRA',
      message: `${p.app} is waiting on infrastructure — ${reason}; nothing was charged`,
      detail: { proposal: p.id, app: p.app, reason, retry_after: until },
    });
  }

  private async cannot(p: Proposal, reason: string): Promise<void> {
    await this.opts.store.update(p.id, { state: 'cannot', reason });
    await this.opts.store.remember(p.task_key, {
      input_sha: p.input_sha,
      last_attempt_at: this.now().toISOString(),
      outcome: 'cannot',
      reason,
      proposal_id: p.id,
    });
    this.opts.events.log({
      level: 'warn',
      code: 'PROPOSAL_CANNOT',
      message: `The author says ${p.app} cannot be done as asked — ${reason.slice(0, 160)}`,
      detail: { proposal: p.id, app: p.app, reason },
    });
    await this.opts.store.pruneFiles(p.id);
  }

  private async failRound(p: Proposal, feedback: string, failing: string[] = []): Promise<void> {
    await this.opts.store.setFeedback(p.id, feedback);
    if (p.round < p.max_rounds) {
      await this.opts.store.update(p.id, { state: 'revising', round: p.round + 1, started_at: undefined });
      this.opts.events.log({
        level: 'info',
        code: 'PROPOSAL_REVISING',
        message: `${p.app} did not pass round ${p.round}; it goes back for another`,
        detail: { proposal: p.id, app: p.app, round: p.round, failing },
      });
      this.opts.kick?.();
      return;
    }
    const reason = `did not pass validation in ${p.max_rounds} round(s)`;
    await this.opts.store.update(p.id, { state: 'failed', reason });
    await this.opts.store.remember(p.task_key, {
      input_sha: p.input_sha,
      last_attempt_at: this.now().toISOString(),
      outcome: 'failed_validation',
      reason,
      proposal_id: p.id,
    });
    this.opts.events.log({
      level: 'warn',
      code: 'PROPOSAL_FAILED',
      message: `Gave up on ${p.app} — ${reason}`,
      detail: { proposal: p.id, app: p.app, reason },
    });
  }

  // ── validation ───────────────────────────────────────────────────────────────────────

  /** One target per platform a scoring section is about; the default carries the rest. */
  private async expected(): Promise<{ target: string; sections: string[] }[]> {
    const by = new Map<string, string[]>();
    for (const s of (await this.sections()).filter((x) => x.scores)) {
      const t = s.target ?? DEFAULT_TARGET;
      by.set(t, [...(by.get(t) ?? []), s.id]);
    }
    return [...by.entries()].map(([target, sections]) => ({ target, sections }));
  }

  private async startValidation(p: Proposal, summary: string, onlyTargets?: string[]): Promise<void> {
    const deps = this.opts.trialDeps();
    const refusal = trialsReady(deps);
    if (refusal) {
      await this.infra(p, refusal.error);
      return;
    }
    const files = await this.opts.store.workFiles(p.id);
    const origin = this.origin!;
    const plan = (await this.expected()).filter((e) => !onlyTargets || onlyTargets.includes(e.target));
    const trials = [...p.trials];
    const at0 = this.now().getTime();
    let i = 0;
    for (const { target } of plan) {
      // Distinct instants: a trial's slug is minted from its time, and two in one millisecond
      // would collide.
      const at = new Date(at0 + i++).toISOString();
      const built = specFromFiles(
        deps,
        {
          subject: p.app,
          files,
          apps_path: 'Apps',
          source_url: `workshop:${p.id}#r${p.round}`,
          ...(target !== DEFAULT_TARGET ? { target } : {}),
          repo: origin.repo,
          proposal_id: p.id,
        },
        at,
      );
      if (!built.ok) {
        // The working copy itself is unusable (no compose): that is the author's, not infra.
        await this.failRound(p, `The working copy could not be audited: ${built.error}.`);
        return;
      }
      const prior = trials.filter((t) => t.round === p.round && t.target === target).length;
      await enqueueTrial(deps, built.spec, at, built.compare_to);
      trials.push({ round: p.round, target, slug: built.spec.slug, ...(prior > 0 ? { retry: prior } : {}) });
    }
    await this.opts.store.update(p.id, {
      state: 'validating',
      summary,
      trials,
      reason: undefined,
      started_at: undefined,
    });
    this.opts.events.log({
      level: 'info',
      code: 'PROPOSAL_VALIDATING',
      message: `${p.app} was submitted; validating on ${plan.map((x) => x.target).join(' and ')}`,
      detail: {
        proposal: p.id,
        app: p.app,
        round: p.round,
        trials: trials.filter((t) => t.round === p.round).map((t) => t.slug),
      },
    });
  }

  /** A trial ended. If it was one of ours and the round is complete, judge it. */
  async onTrialFinished(slug: string): Promise<void> {
    const p = this.opts.store.list().find((x) => x.state === 'validating' && x.trials.some((t) => t.slug === slug));
    if (p) await this.evaluate(p.id);
  }

  /** Idempotent catch-up: anything validating whose trials are all done gets judged. */
  async reconcile(): Promise<void> {
    for (const p of this.opts.store.list()) if (p.state === 'validating') await this.evaluate(p.id);
  }

  /** The newest trial of this round per target. */
  private current(p: Proposal): Map<string, string> {
    const out = new Map<string, string>();
    for (const t of p.trials) if (t.round === p.round) out.set(t.target, t.slug);
    return out;
  }

  private async evaluate(id: string): Promise<void> {
    if (this.evaluating.has(id)) return;
    this.evaluating.add(id);
    try {
      const p = this.opts.store.get(id);
      if (!p || p.state !== 'validating') return;
      const trialStore = this.opts.trialDeps().trials;
      const current = this.current(p);
      for (const slug of current.values()) {
        const rec = trialStore?.get(slug);
        // Still queued or running: wait. A row that is gone was evicted, and is judged below
        // as missing, which is infra.
        if (rec && !rec.finished_at) return;
      }
      const plan = await this.expected();
      const results: SectionResult[] = [];
      const reports: { section: string; text: string; slug: string }[] = [];
      const failingRecs: { meta: AssayRecord['meta']; path: string }[] = [];
      for (const { target, sections } of plan) {
        const slug = current.get(target);
        if (!slug) {
          for (const s of sections) results.push({ section: s, status: 'missing', verdict: null, risk_score: null, trial: '' });
          continue;
        }
        const idx = await trialIndex(this.opts.trialsRoot, slug).catch(() => null);
        const state = idx ? subjectHallmark(asSubjectKey(`${slug}~${p.app}`), idx.all()).state : undefined;
        for (const s of sections) {
          const rec = state?.sections[s] ?? null;
          results.push(resultOf(s, slug, rec));
          if (rec && idx) {
            const file = await idx.read(rec.path).catch(() => null);
            if (file) reports.push({ section: s, text: file.raw, slug });
            if (rec.meta.verdict !== 'compliant') failingRecs.push({ meta: rec.meta, path: rec.path });
          }
        }
      }
      const verdict = judgeValidation(
        plan.flatMap((x) => x.sections),
        results,
      );
      if (verdict.kind === 'pass') {
        for (const r of reports) {
          const name = await this.opts.store.writeEvidence(p.id, `${r.section}.md`, r.text);
          const row = results.find((x) => x.section === r.section);
          if (row) row.evidence = name;
        }
        await this.opts.store.update(p.id, { state: 'ready', validation: results, reason: undefined });
        this.opts.events.log({
          level: 'info',
          code: 'PROPOSAL_READY',
          message: `${p.app} passed validation and is ready to open as a pull request`,
          detail: { proposal: p.id, app: p.app, round: p.round },
        });
        await this.maybeSubmit();
        return;
      }
      if (verdict.kind === 'impossible') {
        await this.opts.store.update(p.id, { state: 'failed', validation: results, reason: verdict.reason });
        this.opts.events.log({
          level: 'warn',
          code: 'PROPOSAL_FAILED',
          message: `${p.app} cannot be validated on this installation — ${verdict.reason}`,
          detail: { proposal: p.id, app: p.app, reason: verdict.reason },
        });
        return;
      }
      if (verdict.kind === 'infra') {
        const targets = plan.filter((x) => x.sections.some((s) => verdict.sections.includes(s))).map((x) => x.target);
        const retries = Math.max(0, ...p.trials.filter((t) => t.round === p.round).map((t) => t.retry ?? 0));
        if (retries >= MAX_TRIAL_RETRIES) {
          await this.opts.store.update(p.id, { state: 'failed', validation: results, reason: `validation kept blocking: ${verdict.reason}` });
          this.opts.events.log({
            level: 'warn',
            code: 'PROPOSAL_FAILED',
            message: `Gave up validating ${p.app} — ${verdict.reason}; nothing was charged to the task`,
            detail: { proposal: p.id, app: p.app, reason: verdict.reason },
          });
          return;
        }
        this.opts.events.log({
          level: 'warn',
          code: 'PROPOSAL_INFRA',
          message: `Validation of ${p.app} did not complete — ${verdict.reason}; re-queued at no cost`,
          detail: { proposal: p.id, app: p.app, reason: verdict.reason },
        });
        await this.startValidation(p, p.summary ?? '', targets);
        return;
      }
      await this.opts.store.update(p.id, { validation: results });
      const feedback =
        buildFixReport({ subject: p.app, sections: failingRecs }) ??
        `These sections did not pass: ${verdict.failing.join(', ')}.`;
      await this.failRound(p, feedback, verdict.failing);
    } finally {
      this.evaluating.delete(id);
    }
  }

  // ── submission ───────────────────────────────────────────────────────────────────────

  /** Automatic submission (phase 2): when armed and the quota allows, the oldest ready. */
  async maybeSubmit(): Promise<void> {
    if (!this.armed || !this.quotaNow().allowed) return;
    const ready = this.opts.store
      .list()
      .filter((p) => p.state === 'ready')
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at))[0];
    if (!ready) return;
    await this.submitPr(ready.id, 'workshop').catch(() => undefined);
  }

  /** Open the pull request. The only path to GitHub's write API in the whole app. */
  async submitPr(id: string, by: string): Promise<Proposal> {
    const gh = this.gh;
    const origin = this.origin;
    if (!gh || !origin) throw new WorkshopRefusal(503, this.unconfigured() ?? 'the workshop is not configured');
    const p = this.opts.store.get(id);
    if (!p) throw new WorkshopRefusal(404, `no such proposal: ${id}`);
    if (p.state !== 'ready') throw new WorkshopRefusal(409, `${p.app} is ${p.state}, not ready`);
    if (!this.opts.probe.usable()) await this.opts.probe.probe();
    if (!this.opts.probe.usable()) {
      throw new WorkshopRefusal(409, `the GitHub token is not usable: ${this.opts.probe.status().problems.join('; ')}`);
    }
    const q = this.quotaNow();
    if (!q.allowed) {
      throw new WorkshopRefusal(
        409,
        this.prsPerDay <= 0
          ? 'workshop.prs_per_day is 0 — this instance builds and validates but never opens a pull request'
          : `the daily quota is spent; the next slot opens ${q.next_slot_at ?? 'later'}`,
      );
    }

    const now = this.now();
    // Every GitHub call below can fail, and each failure has to reach the operator as GitHub's
    // own sentence and leave a row in Activity. Only the last step used to be caught: a 403 on
    // the first blob escaped as a bare 500, so Open PR said "Internal Server Error" and the log
    // said nothing at all.
    const failed = (err: unknown): never => {
      const error = err instanceof GitHubError ? err.message : String((err as Error)?.message ?? err);
      this.opts.events.log({
        level: 'error',
        code: 'PROPOSAL_SUBMIT_FAILED',
        message: `Could not open the pull request for ${p.app}`,
        detail: { proposal: p.id, app: p.app, error },
      });
      throw new WorkshopRefusal(502, error);
    };

    let head: string;
    let appTree: string | null;
    try {
      head = await gh.headOf(origin.ref);
      appTree = await gh.appTreeSha(origin.apps_path, p.app, head);
    } catch (err) {
      return failed(err);
    }
    if ((p.app_tree_sha ?? null) !== appTree) {
      const reason = `${p.app} changed in ${origin.repo} since this proposal was built on it`;
      await this.opts.store.update(p.id, { state: 'discarded', reason });
      this.opts.events.log({
        level: 'warn',
        code: 'PROPOSAL_DISCARDED',
        message: `Discarded ${p.app} — the store moved under it; nothing was charged`,
        detail: { proposal: p.id, app: p.app, reason, by },
      });
      await this.opts.store.pruneFiles(p.id);
      throw new WorkshopRefusal(409, reason);
    }

    const diff = await this.opts.store.diff(p.id);
    const work = await this.opts.store.workFiles(p.id);
    const prefix = `${origin.apps_path.replace(/^\/+|\/+$/g, '')}/${p.app}/`;
    if (diff.added.length + diff.modified.length + diff.deleted.length === 0) {
      throw new WorkshopRefusal(409, 'the working copy changes nothing');
    }
    const title = prTitle(p);
    const ref = refFor(p, now);

    let branched = false;
    let pr: { number: number; url: string };
    try {
      const entries: TreeEntry[] = [];
      for (const rel of [...diff.added, ...diff.modified]) {
        entries.push({ path: prefix + rel, sha: await gh.createBlob(work.get(rel)!) });
      }
      for (const rel of diff.deleted) entries.push({ path: prefix + rel, sha: null });

      const tree = await gh.createTree(await gh.commitTree(head), entries);
      const email =
        this.opts.settings.commit_email ||
        `${this.opts.probe.userId ?? 0}+${this.opts.probe.status().login ?? this.opts.settings.login}@users.noreply.github.com`;
      const commit = await gh.createCommit(
        `${title.replace(/^\[touchstone\] /, '')}\n\nPrepared by Touchstone's workshop, proposal ${p.id}.`,
        tree,
        head,
        { name: this.opts.settings.commit_name, email },
      );
      await gh.createBranch(ref, commit);
      branched = true;

      const reports: { section: string; text: string }[] = [];
      for (const r of p.validation ?? []) {
        const text = r.evidence ? await this.opts.store.readEvidence(p.id, r.evidence) : null;
        if (text) reports.push({ section: r.section, text });
      }
      pr = await gh.openPull({
        title,
        head: branchOf(ref),
        base: origin.ref,
        body: buildPrBody({
          proposal: p,
          validation: p.validation ?? [],
          ...(p.before_findings ? { before: p.before_findings } : {}),
          after: [],
          reports,
        }),
      });
    } catch (err) {
      if (branched) await gh.deleteBranch(ref).catch(() => undefined);
      return failed(err);
    }
    // The label is best effort (D13): a PR without it is still a PR.
    await gh.addLabel(pr.number, WORKSHOP_LABEL).catch(() => undefined);

    const updated = await this.opts.store.update(p.id, {
      state: 'submitted',
      ref,
      pr: { number: pr.number, url: pr.url, state: 'open', opened_at: now.toISOString() },
    });
    await this.opts.store.remember(p.task_key, {
      input_sha: p.input_sha,
      last_attempt_at: now.toISOString(),
      outcome: 'pr_opened',
      proposal_id: p.id,
      pr_url: pr.url,
    });
    this.openPrs.apps?.add(p.app);
    this.opts.events.log({
      level: 'info',
      code: 'PROPOSAL_SUBMITTED',
      message: `Opened a pull request for ${p.app}: ${title}`,
      detail: { proposal: p.id, app: p.app, pr: pr.number, url: pr.url, branch: branchOf(ref), by },
    });
    return updated;
  }

  async discard(id: string, by: string): Promise<Proposal> {
    const p = this.opts.store.get(id);
    if (!p) throw new WorkshopRefusal(404, `no such proposal: ${id}`);
    if (p.state === 'authoring') throw new WorkshopRefusal(409, 'an authoring session is running on it');
    if (p.state === 'submitted' || p.state === 'merged' || p.state === 'closed') {
      throw new WorkshopRefusal(409, 'its pull request is already open — close it on GitHub instead');
    }
    if (!ACTIVE_STATES.includes(p.state)) return p;
    const out = await this.opts.store.update(p.id, { state: 'discarded', reason: `discarded by ${by}` });
    this.opts.events.log({
      level: 'info',
      code: 'PROPOSAL_DISCARDED',
      message: `Discarded the proposal for ${p.app}; nothing was charged`,
      detail: { proposal: p.id, app: p.app, reason: 'operator', by },
    });
    await this.opts.store.pruneFiles(p.id);
    return out;
  }

  async forget(taskKey: string, by: string): Promise<boolean> {
    const done = await this.opts.store.forget(taskKey);
    if (done) {
      this.opts.events.log({
        level: 'info',
        code: 'WORKSHOP_MEMORY_CLEARED',
        message: `Cleared what the workshop remembered about ${taskKey}`,
        detail: { task: taskKey, by },
      });
      this.opts.kick?.();
    }
    return done;
  }

  /** Follow open PRs: merged or closed, the branch is ours to delete (D12). */
  async pollPrs(): Promise<void> {
    const gh = this.gh;
    if (!gh) return;
    for (const p of this.opts.store.list()) {
      if (p.state !== 'submitted' || !p.pr) continue;
      let state;
      try {
        state = await gh.pull(p.pr.number);
      } catch {
        continue;
      }
      if (state.state === 'open') continue;
      if (p.ref) await gh.deleteBranch(p.ref).catch(() => undefined);
      const at = this.now().toISOString();
      if (state.merged) {
        await this.opts.store.update(p.id, { state: 'merged', pr: { ...p.pr, state: 'merged', closed_at: at } });
        this.opts.events.log({
          level: 'info',
          code: 'PROPOSAL_MERGED',
          message: `The pull request for ${p.app} was merged`,
          detail: { proposal: p.id, app: p.app, pr: p.pr.number },
        });
      } else {
        await this.opts.store.update(p.id, { state: 'closed', pr: { ...p.pr, state: 'closed', closed_at: at } });
        await this.opts.store.remember(p.task_key, {
          input_sha: p.input_sha,
          last_attempt_at: at,
          outcome: 'pr_closed',
          proposal_id: p.id,
          pr_url: p.pr.url,
        });
        this.opts.events.log({
          level: 'info',
          code: 'PROPOSAL_CLOSED',
          message: `The pull request for ${p.app} was closed without merging; the task waits for its input to change`,
          detail: { proposal: p.id, app: p.app, pr: p.pr.number },
        });
      }
      await this.opts.store.pruneFiles(p.id);
    }
    await this.openPrApps(true);
  }

  // ── the authoring surface ────────────────────────────────────────────────────────────

  /** The proposal a session token is for, or a refusal naming why not. */
  sessionFor(token: string): { proposal: Proposal; session: Session } {
    const s = this.sessions.get(String(token ?? ''));
    if (!s || s.expires_at < this.now().getTime()) throw new WorkshopError('unknown or expired session_token');
    if (s.ended) throw new WorkshopError(`this session already ended with ${s.ended.kind}`);
    const proposal = this.opts.store.get(s.proposal);
    if (!proposal || proposal.state !== 'authoring') throw new WorkshopError('this session is no longer authoring');
    return { proposal, session: s };
  }

  async listFiles(token: string): Promise<{ path: string; bytes: number }[]> {
    return this.opts.store.manifest(this.sessionFor(token).proposal.id);
  }

  async readFile(token: string, rel: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<string> {
    const bytes = await this.opts.store.read(this.sessionFor(token).proposal.id, String(rel ?? '').replace(/^\/+/, ''));
    if (!bytes) throw new WorkshopError(`no such file in the working copy: ${rel}`);
    return encoding === 'base64' ? Buffer.from(bytes).toString('base64') : Buffer.from(bytes).toString('utf8');
  }

  async writeFile(token: string, rel: string, content: string, encoding: 'utf8' | 'base64' = 'utf8') {
    const { proposal } = this.sessionFor(token);
    const bytes = encoding === 'base64' ? Buffer.from(String(content ?? ''), 'base64') : Buffer.from(String(content ?? ''), 'utf8');
    return this.opts.store.put(proposal.id, rel, bytes);
  }

  async deleteFile(token: string, rel: string): Promise<boolean> {
    return this.opts.store.del(this.sessionFor(token).proposal.id, rel);
  }

  async readStoreFile(token: string, rel: string) {
    const { proposal } = this.sessionFor(token);
    const origin = this.origin!;
    if (!this.opts.storedoc) throw new WorkshopError('store files cannot be read on this installation');
    return this.opts.storedoc.read({ id: origin.id, repo: origin.repo, ref: proposal.base_sha ?? origin.ref }, rel);
  }

  /** Publish the working copy as it is now, for the bench to install. */
  async stage(token: string): Promise<{ store_url: string; bench_open_url?: string }> {
    const { proposal } = this.sessionFor(token);
    const files = await this.opts.store.workFiles(proposal.id);
    if (!files.has('docker-compose.yml') && !files.has('docker-compose.yaml')) {
      throw new WorkshopError('write a docker-compose.yml before staging');
    }
    const now = this.now().getTime();
    for (const [k, v] of this.stages) if (v.expires_at < now) this.stages.delete(k);
    const stageToken = randomBytes(24).toString('base64url');
    this.stages.set(stageToken, {
      zip: packAppStore(files, proposal.app, `stage-${proposal.id}`),
      subject: proposal.app,
      expires_at: now + STAGE_TTL_MS,
    });
    const store_url = `${this.opts.publicBaseUrl.replace(/\/+$/, '')}/api/v1/trialstore/${stageToken}.zip`;
    return { store_url };
  }

  /** For `GET /trialstore/:file` — a staged zip by its token, while it lives. */
  staged(token: string): { zip: Buffer; subject: string } | undefined {
    const s = this.stages.get(token);
    if (!s || s.expires_at < this.now().getTime()) return undefined;
    return { zip: s.zip, subject: s.subject };
  }

  submit(token: string, summary: string): void {
    const { session } = this.sessionFor(token);
    const text = String(summary ?? '').trim();
    if (!text) throw new WorkshopError('submit needs a summary of what you changed and why');
    session.ended = { kind: 'submit', summary: text.slice(0, 20_000) };
  }

  cannotDo(token: string, reason: string): void {
    const { session } = this.sessionFor(token);
    const text = String(reason ?? '').trim();
    if (!text) throw new WorkshopError('cannot needs the reason');
    session.ended = { kind: 'cannot', reason: text.slice(0, 4_000) };
  }

  // ── reading ──────────────────────────────────────────────────────────────────────────

  async view(): Promise<WorkshopView> {
    const proposals: ProposalSummary[] = [];
    for (const p of this.opts.store.list()) {
      const live = ACTIVE_STATES.includes(p.state) || p.state === 'failed';
      const d = live ? await this.opts.store.diff(p.id).catch(() => null) : null;
      proposals.push({
        ...p,
        ...(d ? { diff: { added: d.added.length, modified: d.modified.length, deleted: d.deleted.length } } : {}),
      });
    }
    const wishes = await this.wishes();
    const offered = new Set<string>([
      ...(this.opts.registry?.list() ?? []).map((k) => subjectName(k)),
      ...(this.opts.registry?.delisted() ?? []).map((k) => subjectName(k)),
    ]);
    const memory = this.opts.store.memory();
    const problem = this.unconfigured();
    const open = this.openPrs.apps;
    return {
      configured: !problem,
      ...(problem ? { unconfigured_reason: problem } : {}),
      github: this.github(),
      github_token: this.tokenInfo(),
      origin: this.opts.settings.origin,
      armed: this.armed,
      prs_per_day: this.prsPerDay,
      quota: this.quotaNow(),
      ...(this.liveView() ? { live: this.liveView()! } : {}),
      proposals,
      candidates: problem ? [] : await this.candidates(),
      memory,
      wishlist: wishes.map((w) => ({
        ...w,
        offered: offered.has(w.name),
        ...(memory[taskKey('wish', w.file)] ? { memory: memory[taskKey('wish', w.file)]! } : {}),
      })),
      open_pr_apps: open ? [...open].sort() : null,
    };
  }

  async detail(id: string): Promise<ProposalDetail | null> {
    const p = this.opts.store.get(id);
    if (!p) return null;
    const d = await this.opts.store.diff(p.id).catch(() => null);
    return {
      proposal: { ...p, ...(d ? { diff: { added: d.added.length, modified: d.modified.length, deleted: d.deleted.length } } : {}) },
      files: await this.opts.store.diffFiles(p.id).catch(() => []),
      ...((await this.opts.store.feedback(p.id)) ? { feedback: (await this.opts.store.feedback(p.id))! } : {}),
    };
  }

  /** The open PR for a subject, for the operator's subject page and Store row. */
  prFor(subject: string): { number: number; url: string; state: string } | undefined {
    const p = this.opts.store
      .list()
      .find((x) => x.subject === subject && x.pr && (x.state === 'submitted' || x.state === 'merged'));
    return p?.pr ? { number: p.pr.number, url: p.pr.url, state: p.pr.state } : undefined;
  }

  /** Every subject with a proposal in flight or an open PR, for the Store table's join. */
  activeBySubject(): Record<string, { state: string; pr?: { number: number; url: string } }> {
    const out: Record<string, { state: string; pr?: { number: number; url: string } }> = {};
    for (const p of this.opts.store.list()) {
      if (!p.subject || !ACTIVE_STATES.includes(p.state) || out[p.subject]) continue;
      out[p.subject] = { state: p.state, ...(p.pr ? { pr: { number: p.pr.number, url: p.pr.url } } : {}) };
    }
    return out;
  }
}

/** A refusal with the HTTP status a route should answer. */
export class WorkshopRefusal extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function verb(kind: ProposalKind): string {
  return kind === 'fix' ? 'fix' : kind === 'currency' ? 'update' : 'add';
}
