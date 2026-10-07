/**
 * The workshop's decisions, as pure functions — what to work on, whether a round passed,
 * whether a PR may be opened now, and what its branch is called.
 *
 * Nothing here reads a file or the clock: `services/workshop.ts` gathers the world and these
 * functions decide, so the rules that matter most — a blocked section is never a pass, infra
 * never charges a task, the quota is a rolling window — are tested without a runner.
 */

import { createHash } from 'node:crypto';

import type { AssayMeta, AssayRecord, SubjectState } from '../../shared/types.js';
import type {
  BaselineSection,
  CandidateRow,
  FindingRow,
  Proposal,
  ProposalKind,
  Regression,
  SectionResult,
  TaskMemory,
  Wish,
} from '../../shared/workshop.js';
import { subjectName, type SubjectKey } from '../../shared/subject.js';
import { assertOwnRef } from '../services/github.js';
import { isAppDirName } from '../store/trials.js';

export const DAY_MS = 86_400_000;

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function taskKey(kind: ProposalKind, id: string): string {
  return `${kind}:${id}`;
}

// ── the quota ───────────────────────────────────────────────────────────────────────────

/**
 * Whether a PR may be opened now: fewer than `prsPerDay` opened in the last 24 hours. A
 * rolling window rather than a calendar day, so there is no time zone to argue about. 0 is
 * the dry run and never allows one.
 */
export function quota(
  prsPerDay: number,
  openedAts: readonly string[],
  now: Date,
): { allowed: boolean; next_slot_at?: string; opened_last_24h: number } {
  const since = now.getTime() - DAY_MS;
  const recent = openedAts
    .map((a) => Date.parse(a))
    .filter((t) => !Number.isNaN(t) && t > since)
    .sort((a, b) => a - b);
  if (prsPerDay <= 0) return { allowed: false, opened_last_24h: recent.length };
  if (recent.length < prsPerDay) return { allowed: true, opened_last_24h: recent.length };
  // The slot reopens when the oldest PR that is filling it leaves the window.
  const oldest = recent[recent.length - prsPerDay]!;
  return { allowed: false, next_slot_at: new Date(oldest + DAY_MS).toISOString(), opened_last_24h: recent.length };
}

// ── the commit's scope ──────────────────────────────────────────────────────────────────

/**
 * Every path a workshop commit writes must be inside `<apps_path>/<App>/` — or be that
 * directory itself, which is how a revert puts the old tree back in one entry.
 *
 * Without a pull request nobody reads the diff before it lands, so this is what keeps a
 * proposal for one app from touching `.github/`, another app, or the store's own files. It
 * runs in both delivery modes; in PR mode it costs nothing and closes the same hole.
 */
export function assertAppScope(paths: readonly string[], appsPath: string, app: string): void {
  if (!isAppDirName(app)) throw new Error(`not an app directory name: ${app}`);
  const root = `${appsPath.replace(/^\/+|\/+$/g, '')}/${app}`;
  if (paths.length === 0) throw new Error('a commit that writes nothing');
  for (const p of paths) {
    const segments = p.split('/');
    const bad = segments.some((x) => x === '' || x === '.' || x === '..');
    if (bad || (p !== root && !p.startsWith(`${root}/`))) {
      throw new Error(`refusing to write ${JSON.stringify(p)}: a proposal for ${app} may only write ${root}/`);
    }
  }
}

// ── the branch ──────────────────────────────────────────────────────────────────────────

/**
 * `refs/heads/touchstone/<kind>/<App>-<yyyymmdd>-<id6>` — the only ref name the workshop
 * produces. The id suffix keeps two proposals for one app on one day from colliding.
 */
export function refFor(p: Pick<Proposal, 'kind' | 'app' | 'id'>, now: Date): string {
  if (!isAppDirName(p.app)) throw new Error(`not an app directory name: ${p.app}`);
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const ref = `refs/heads/touchstone/${p.kind}/${p.app}-${day}-${p.id.slice(0, 6)}`;
  assertOwnRef(ref);
  return ref;
}

// ── validation ──────────────────────────────────────────────────────────────────────────

/** Blocked reasons that say the agent's *answer* was unusable — a round, not infra (§7). */
const ANSWER_FAILURES = new Set(['agent_error', 'parse_failed']);
/** Blocked reasons no retry can fix — configuration answers. */
const CONFIG_FAILURES = new Set(['bench_unconfigured', 'store_url_unconfigured']);

export type Judgement =
  | { kind: 'pass' }
  | { kind: 'fail'; failing: string[] }
  | { kind: 'infra'; sections: string[]; reason: string }
  | { kind: 'impossible'; reason: string };

/**
 * Did this round pass? Every expected scoring section must be `done` and `compliant`.
 *
 * A blocked section is **never** a pass. Blocked by infrastructure, it is retried at no cost
 * to the task; blocked because the agent's answer was unusable, it established nothing and
 * counts as a failed round, since "nothing" cannot be put in a PR as evidence.
 */
export function judgeValidation(expected: readonly string[], results: readonly SectionResult[]): Judgement {
  const by = new Map(results.map((r) => [r.section, r]));
  const infra: string[] = [];
  const failing: string[] = [];
  for (const id of expected) {
    const r = by.get(id);
    if (!r || r.status === 'missing' || r.status === 'running') {
      infra.push(id);
      continue;
    }
    if (r.status === 'blocked') {
      const why = r.blocked_reason ?? '';
      if (CONFIG_FAILURES.has(why)) return { kind: 'impossible', reason: `${id}: ${why.replace(/_/g, ' ')}` };
      if (ANSWER_FAILURES.has(why)) failing.push(id);
      else infra.push(id);
      continue;
    }
    if (r.verdict !== 'compliant') failing.push(id);
  }
  if (failing.length > 0) return { kind: 'fail', failing };
  if (infra.length > 0) return { kind: 'infra', sections: infra, reason: `not audited: ${infra.join(', ')}` };
  return { kind: 'pass' };
}

/** One section's record, as a validation result. */
export function resultOf(section: string, slug: string, rec: AssayRecord | null | undefined): SectionResult {
  if (!rec) return { section, status: 'missing', verdict: null, risk_score: null, trial: slug };
  const m = rec.meta;
  return {
    section,
    ...(typeof m.target === 'string' ? { target: m.target } : {}),
    status: m.status,
    verdict: m.verdict ?? null,
    risk_score: typeof m.risk_score === 'number' ? m.risk_score : null,
    ...(m.blocked_reason ? { blocked_reason: String(m.blocked_reason) } : {}),
    ...(typeof m.standard_sha256 === 'string' ? { standard_sha256: m.standard_sha256 } : {}),
    trial: slug,
  };
}

// ── findings ────────────────────────────────────────────────────────────────────────────

const RANK: Record<string, number> = { critical: 3, major: 2, minor: 1 };
const rankOf = (severity: string | null | undefined) => RANK[severity ?? ''] ?? 0;

/** Every failing requirement across a subject's current sections, most severe first. */
export function findingsOf(sections: Record<string, AssayRecord | null>, scoring: ReadonlySet<string>): FindingRow[] {
  const rank = RANK;
  const out: FindingRow[] = [];
  for (const [section, rec] of Object.entries(sections)) {
    if (!rec || !scoring.has(section)) continue;
    for (const r of rec.meta.requirements ?? []) {
      if (r.verdict !== 'fail') continue;
      out.push({
        section,
        id: r.id,
        severity: r.severity ?? null,
        ...(r.requirement ? { requirement: r.requirement } : {}),
      });
    }
  }
  return out.sort((a, b) => (rank[b.severity ?? ''] ?? 0) - (rank[a.severity ?? ''] ?? 0) || a.id.localeCompare(b.id));
}

// ── D7′: never add a finding ────────────────────────────────────────────────────────────

/** The subject's scoring sections, reduced to what D7′ compares. Sections never audited are left out. */
export function baselineOf(
  sections: Record<string, AssayRecord | null>,
  scoring: ReadonlySet<string>,
): Record<string, BaselineSection> {
  const out: Record<string, BaselineSection> = {};
  for (const [section, rec] of Object.entries(sections)) {
    if (!rec || !scoring.has(section) || rec.meta.status !== 'done') continue;
    const requirements: BaselineSection['requirements'] = {};
    for (const r of rec.meta.requirements ?? []) {
      requirements[r.id] = { verdict: r.verdict, ...(r.severity ? { severity: r.severity } : {}) };
    }
    out[section] = {
      ...(typeof rec.meta.standard_sha256 === 'string' ? { standard_sha256: rec.meta.standard_sha256 } : {}),
      risk_score: typeof rec.meta.risk_score === 'number' ? rec.meta.risk_score : null,
      requirements,
    };
  }
  return out;
}

/**
 * What the change made worse, against the baseline it was built on (D7′). Every delivery
 * mode applies it: there is no case for a proposal that raises risk.
 *
 * A requirement regresses when validation fails it and the baseline did not, or fails it more
 * severely. One the baseline never judged counts only when both ran under the same standard
 * revision — otherwise it may simply be new in the rubric, and that section is reported as
 * `stale` instead. `risk_score` is not compared: the agent declares it, and it moves between
 * two runs of the same bytes. A section with no baseline (a wish, a section never audited)
 * has nothing to regress from.
 */
export function regressionsOf(
  baseline: Record<string, BaselineSection> | undefined,
  trial: Record<string, AssayRecord | null>,
): { regressions: Regression[]; stale: string[] } {
  const regressions: Regression[] = [];
  const stale: string[] = [];
  for (const [section, base] of Object.entries(baseline ?? {})) {
    const rec = trial[section];
    if (!rec) continue;
    const sameStandard = !!base.standard_sha256 && base.standard_sha256 === rec.meta.standard_sha256;
    if (!sameStandard) stale.push(section);
    for (const r of rec.meta.requirements ?? []) {
      if (r.verdict !== 'fail') continue;
      const was = base.requirements[r.id];
      let from: string | null = null;
      if (!was) from = sameStandard ? 'absent' : null;
      else if (was.verdict !== 'fail') from = was.verdict;
      else if (rankOf(r.severity) > rankOf(was.severity)) from = was.severity ?? 'fail';
      if (from === null) continue;
      regressions.push({
        section,
        id: r.id,
        severity: r.severity ?? null,
        ...(r.requirement ? { requirement: r.requirement } : {}),
        was: from,
      });
    }
  }
  regressions.sort((a, b) => rankOf(b.severity) - rankOf(a.severity) || a.id.localeCompare(b.id));
  return { regressions, stale: stale.sort() };
}

// ── currency ────────────────────────────────────────────────────────────────────────────

/**
 * The currency reading's rows, as far as the workshop needs them.
 *
 * `rows` are opaque to `src/` by design (`AssayMeta.rows`): a reading is drawn, not
 * interpreted. This is the first reader, and it stays as shallow as it can — eligibility comes
 * from the typed `badge_state`, and the rows are read only to rank (`days`) and to name a
 * target version (`latest`), defensively, with any surprise reading as "unknown".
 */
export function currencyOf(meta: AssayMeta | undefined): {
  behind: boolean;
  worstDays: number;
  latest?: string;
  rowsSha: string;
} {
  if (!meta) return { behind: false, worstDays: 0, rowsSha: '' };
  const rows = Array.isArray(meta.rows) ? meta.rows : [];
  const own = rows.filter((r) => r && r.platform !== true);
  const behindRows = own.filter((r) => r.state === 'behind' || r.state === 'stale');
  const days = behindRows.map((r) => (typeof r.days === 'number' ? r.days : 0));
  const latest = behindRows.map((r) => r.latest).find((v): v is string => typeof v === 'string' && v.length > 0);
  return {
    behind: meta.badge_state === 'warn' || meta.badge_state === 'bad',
    worstDays: days.length > 0 ? Math.max(...days) : 0,
    ...(latest ? { latest } : {}),
    rowsSha: sha256(JSON.stringify(rows)),
  };
}

/** Best effort: does moving `from` → `to` cross a major version? */
export function crossesMajor(from: string | undefined, to: string | undefined): boolean {
  const major = (v: string | undefined) => {
    const m = /(\d+)(?:\.\d+)*/.exec(String(v ?? '').replace(/^v/i, ''));
    return m ? Number(m[1]) : null;
  };
  const a = major(from);
  const b = major(to);
  return a !== null && b !== null && a !== b;
}

// ── candidates ──────────────────────────────────────────────────────────────────────────

export interface CandidateInput {
  subjects: readonly SubjectState[];
  /** The workshop's origin — no other store is proposed against. */
  origin: string;
  /** Scoring section ids. */
  scoring: ReadonlySet<string>;
  /** The reading section that measures image currency, when there is one. */
  currencySection?: string;
  /** Compose blob sha per subject. */
  versions: Record<string, string | undefined>;
  /** The scoring rubrics' hashes now, sorted into the fix input. */
  standardShas: readonly string[];
  /** Apps with an open PR by anybody; `null` when that could not be read. */
  openPrApps: ReadonlySet<string> | null;
  memory: Record<string, TaskMemory>;
  /** Task keys with a live proposal. */
  active: ReadonlySet<string>;
  wishes?: readonly Wish[];
  /** Every app name any origin offers or used to offer. */
  offered?: ReadonlySet<string>;
}

/**
 * Everything the workshop could pick for itself, with why each is or is not eligible.
 *
 * Ranked fix → currency → wish, and within each by the order docs/auto-app-pr.md §5.1 gives.
 * Derived afresh every time — invariant 8: the memory is a record of attempts, not a queue.
 */
export function candidates(input: CandidateInput): CandidateRow[] {
  const rows: CandidateRow[] = [];
  const sortedStandards = [...input.standardShas].sort().join(',');

  const common = (key: string, app: string, inputSha: string, reasons: string[]): void => {
    const mem = input.memory[key];
    if (mem && mem.input_sha === inputSha) {
      reasons.push(`tried ${mem.last_attempt_at.slice(0, 10)} — ${mem.outcome.replace(/_/g, ' ')}; waits for the input to change`);
    }
    if (input.active.has(key)) reasons.push('a proposal is already in flight');
    if (input.openPrApps === null) reasons.push('open pull requests could not be read');
    else if (input.openPrApps.has(app)) reasons.push('an open pull request already touches this app');
  };

  for (const s of input.subjects) {
    if (s.origin !== input.origin) continue;
    const app = s.label;
    const scoringSections = Object.entries(s.sections).filter(([id]) => input.scoring.has(id));
    const nonCompliant = scoringSections.filter(([, r]) => r?.meta.status === 'done' && r.meta.verdict === 'non-compliant');
    const allCompliant =
      scoringSections.length > 0 &&
      [...input.scoring].every((id) => {
        const r = s.sections[id];
        return r?.meta.status === 'done' && r.meta.verdict === 'compliant';
      });
    const version = input.versions[s.name] ?? '';

    // fix
    if (nonCompliant.length > 0) {
      const key = taskKey('fix', s.name);
      const inputSha = sha256(`${version}|${sortedStandards}`);
      const reasons: string[] = [];
      if (s.delisted) reasons.push('delisted');
      if (s.standard !== 'current') reasons.push('verdict is not under the standard in force — audit first');
      if (s.subject_version === 'changed') reasons.push('the app changed since its verdict — audit first');
      common(key, app, inputSha, reasons);
      const findings = findingsOf(s.sections, input.scoring);
      const critical = findings.filter((f) => f.severity === 'critical').length;
      rows.push({
        task_key: key,
        kind: 'fix',
        label: `fix ${app}`,
        app,
        subject: s.name,
        input_sha: inputSha,
        eligible: reasons.length === 0,
        reasons,
        // critical count, then risk, then oldest verdict
        rank: critical * 1e9 + s.risk * 1e3 + Math.min(999, s.age_days ?? 0),
      });
      continue;
    }

    // currency
    if (input.currencySection && allCompliant) {
      const reading = s.sections[input.currencySection];
      const c = currencyOf(reading?.meta);
      if (!c.behind) continue;
      const key = taskKey('currency', s.name);
      const inputSha = sha256(`${version}|${c.rowsSha}`);
      const reasons: string[] = [];
      if (s.delisted) reasons.push('delisted');
      if (s.subject_version === 'changed') reasons.push('the app changed since its reading — audit first');
      common(key, app, inputSha, reasons);
      rows.push({
        task_key: key,
        kind: 'currency',
        label: `update ${app}${c.latest ? ` to ${c.latest}` : ''}`,
        app,
        subject: s.name,
        input_sha: inputSha,
        eligible: reasons.length === 0,
        reasons,
        rank: c.worstDays,
      });
    }
  }

  for (const w of input.wishes ?? []) {
    const key = taskKey('wish', w.file);
    const reasons: string[] = [];
    if (w.problem) reasons.push(w.problem);
    if (input.offered?.has(w.name)) reasons.push(`a store already offers ${w.name}`);
    common(key, w.name, w.sha256, reasons);
    rows.push({
      task_key: key,
      kind: 'wish',
      label: `add ${w.name}`,
      app: w.name,
      wish_file: w.file,
      input_sha: w.sha256,
      eligible: reasons.length === 0,
      reasons,
      rank: -(w.order ?? 100),
    });
  }

  const kindOrder: Record<ProposalKind, number> = { fix: 0, currency: 1, wish: 2 };
  return rows.sort(
    (a, b) =>
      Number(b.eligible) - Number(a.eligible) ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      b.rank - a.rank ||
      a.label.localeCompare(b.label),
  );
}

/** The bare app name of a subject key — re-exported so callers need one import. */
export function appOf(key: SubjectKey): string {
  return subjectName(key);
}
