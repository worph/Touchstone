/**
 * The importer — pull the AppStore QA corpus out of Docmost into `data/reports/**`.
 *
 * Two callers: `yarn sync` (`tools/import.ts`, a thin argv wrapper) and the 15-minute
 * timer in `src/server/index.ts`. It lives here rather than in `tools/` because of that
 * second one: the index is built at boot and never re-scanned, so an importer that shells
 * out rewrites files the running API will not read until it restarts — the UI would show
 * stale data and look exactly like a failed import. Running in-process lets it `upsert`
 * each written record into the live index instead.
 *
 * Docmost is storage today and stops being storage after this runs. The importer is
 * one-shot in intent and idempotent in fact: every value it writes is derived from the
 * source pages, timestamps included, so running it twice produces byte-identical files and
 * reports zero writes the second time. That is what lets MVP-0 keep it on a 15-minute timer
 * to stay fresh without an ingest endpoint.
 *
 * The one structural transformation: the existing reports cover *both* legs in a single
 * page, and Touchstone's model is one assay per (subject, leg). So each page is split — the
 * "Tech & Documentation" section becomes a `static` assay, the "Functionality" section
 * becomes a `functional` one. Where the functional leg could not run, that assay is
 * `status: blocked` with `verdict: null`, never `errored`: the demo pool returning 401 is a
 * fact about the bench, and recording it as a verdict about the app would be the exact
 * failure mode Touchstone exists to prevent.
 *
 *   yarn sync                 fetch from Docmost via beacon, using the on-disk page cache
 *   yarn sync --refresh       ignore the page cache and re-fetch every page
 *   yarn sync --offline       fail rather than hit the network; cache only
 *   yarn sync --dry-run       parse and report, write nothing
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AssayMeta, AssayRecord, Leg, Severity, Verdict } from '../../shared/types.js';
import { loadConfig, loadStandards, type Standard } from '../store/config.js';
import { writeReport } from '../store/reports.js';
import { callTool } from './mcp.js';
import {
  parseHeadline,
  parsePhases,
  parseRollup,
  shapeReport,
  type RollupRow,
  MANDATORY_PHASES,
} from '../domain/extract.js';

const DOCMOST_TOOL = 'beacon-yunderalabs.docmost-mcp__get_page';
const PAGE_BASE = 'https://docmost-yunderalabs.nsl.sh/s/general/p/';

/** Fetch policy. The timer runs with all three false; the CLI sets them from argv. */
export interface ImportArgs {
  refresh: boolean;
  offline: boolean;
  dryRun: boolean;
  /**
   * Re-fetch the roll-up even when the per-subject pages come from cache.
   *
   * The polling importer must never read a cached roll-up. The page *is* the live state —
   * the loop rewrites it every tick — so caching it turns "stay current with n8n with zero
   * changes to n8n" into a snapshot that never moves. It did: the feed served a page from
   * 2026-08-06 for thirteen days, and the scheduler's first dry run inherited every stale
   * date in it.
   *
   * The subject pages stay cached, and are re-fetched only when the row says the subject
   * was audited since — one page per real audit rather than fifty-seven every quarter hour
   * against someone else's wiki.
   */
  refreshRollup?: boolean;
}

// ── page fetching ──────────────────────────────────────────────────────────────────────

/**
 * Raw Docmost pages are cached on disk. Not an optimisation — it is what makes the import
 * reproducible and lets the parser be iterated on without hammering a production wiki.
 */
async function getPage(slug: string, cacheDir: string, args: ImportArgs): Promise<string> {
  const file = path.join(cacheDir, `${slug}.md`);
  if (!args.refresh) {
    try {
      return await fs.readFile(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  if (args.offline) throw new Error(`--offline and no cached page for ${slug}`);
  const md = await callTool(DOCMOST_TOOL, { slug_id: slug }, { timeout: 120 });
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(file, md, 'utf8');
  return md;
}

/** Docmost's MCP renderer prepends a `# None <title>` banner and a metadata block. */
function stripDocmostBanner(md: string): string {
  const cut = md.indexOf('\n---\n');
  if (cut >= 0 && cut < 400) return md.slice(cut + 5).replace(/^\n+/, '');
  return md;
}

/**
 * The `rollup_last_run` we already have on disk for a subject, or null.
 *
 * Cheap enough to do per subject: it reads the first few hundred bytes of one file. Used to
 * decide whether that subject's report page needs re-fetching at all.
 */
async function storedLastRun(reportsRoot: string, subject: string): Promise<string | null> {
  try {
    const dir = path.join(reportsRoot, subject);
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    const newest = files[files.length - 1];
    if (!newest) return null;
    const head = (await fs.readFile(path.join(dir, newest), 'utf8')).slice(0, 1500);
    return /^rollup_last_run:\s*'?([^'\n]+)/m.exec(head)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

// ── per-subject assembly ───────────────────────────────────────────────────────────────

interface SubjectImport {
  subject: string;
  row: RollupRow;
  page: string | null;
  slug: string | null;
  assays: { meta: AssayMeta; body: string }[];
}

/** Audit dates are day-resolution; times are not recorded anywhere in the corpus. */
function timestamp(date: string | null, fallback: string | null): string {
  const d = date ?? fallback ?? '1970-01-01';
  return `${d}T00:00:00Z`;
}

function buildSubject(
  row: RollupRow,
  page: string | null,
  standards: { staticStd: Standard; functionalStd: Standard },
): SubjectImport {
  const { staticStd, functionalStd } = standards;
  const subject = row.subject;
  const assays: SubjectImport['assays'] = [];

  const head = page ? parseHeadline(page) : null;
  const shape = page ? shapeReport(page) : null;
  const started = timestamp(head?.auditDate ?? null, row.lastRun);

  const sourceUrl = row.slug ? `${PAGE_BASE}${row.slug}` : null;
  const common = {
    subject_ref: `Yundera/AppStore@${head?.ref ?? 'main'}:Apps/${subject}`,
    ...(head?.composeSha ? { commit: head.composeSha.slice(0, 12) } : {}),
    images: head?.images ?? [],
    started_at: started,
    finished_at: started,
    // Provenance. Unknown to the type, preserved verbatim by the store — which is the point
    // of the "unknown frontmatter keys survive a round-trip" rule.
    imported_from: sourceUrl,
    imported_source: sourceUrl ? 'docmost-report' : 'docmost-rollup',
    rollup_result: row.raw,
    rollup_risk: row.risk,
    rollup_last_run: row.lastRun,
    ...(head?.scope ? { scope: head.scope } : {}),
    ...(head?.composeSha ? { compose_sha: head.composeSha } : {}),
  };

  // A leg "ran" only if a *mandatory* phase produced a real result. Reading `H — Cleanup |
  // pass | nothing was installed, so there was nothing to uninstall` as a completed run is
  // precisely the mistake that turns a bench outage into a verdict about the app.
  const phases = shape?.functionalSection ? parsePhases(shape.functionalSection.text) : [];
  const ran = phases.some(
    (p) => MANDATORY_PHASES.has(p.code) && (p.result === 'pass' || p.result === 'fail'),
  );
  const failedPhase = phases.some((p) => MANDATORY_PHASES.has(p.code) && p.result === 'fail');

  // ── static leg ───────────────────────────────────────────────────────────────────────
  //
  // The verdict, tier and score are taken from the report's own headline, and from the
  // roll-up row when there is no report page. Nothing is derived from the prose.
  //
  // This is ARCHITECTURE.md principle 3, and it is here because the alternative was tried:
  // an earlier importer extracted findings from the body and computed a tier from them,
  // which read eight of twenty non-compliant subjects milder than their own headline and
  // promoted four Critical apps to `compliant`. The agent already stated the answer under
  // contract; re-deriving it can only lose.
  const scored = scoreFrom(head, row, subject, ran);

  assays.push({
    meta: {
      subject,
      leg: 'static',
      standard: staticStd.name,
      standard_version: staticStd.version,
      status: 'done',
      verdict: scored.verdict,
      top_severity: scored.top_severity,
      risk_score: scored.risk_score,
      blocked_reason: null,
      ...common,
      ...(scored.source === 'rollup' ? { score_source: 'docmost-rollup-row' } : {}),
    } as AssayMeta,
    body: composeBody(subject, 'static', shape, sourceUrl, page),
  });

  // ── functional leg ───────────────────────────────────────────────────────────────────
  const blockedDetail = shape?.functionalSection
    ? blockedReasonDetail(shape.functionalSection.text)
    : null;

  assays.push({
    meta: {
      subject,
      leg: 'functional',
      standard: functionalStd.name,
      standard_version: functionalStd.version,
      status: ran ? 'done' : 'blocked',
      verdict: ran ? (failedPhase ? 'non-compliant' : 'compliant') : null,
      // The headline scores the report as a whole, and the whole is dominated by the
      // checklist. Attributing it twice would double the store's risk, so it lands on the
      // static leg and this leg records the phase outcome only. The live runner replaces
      // this within FRESH_DAYS; the migration only has to avoid lying.
      top_severity: 'none',
      risk_score: 0,
      // The whole point of the distinction: the bench was unreachable, so there is no
      // verdict to give. `errored` would read as a statement about the subject.
      blocked_reason: ran ? null : 'bench_unavailable',
      ...(ran ? {} : { combined_score_on: 'static' }),
      ...(ran || !blockedDetail ? {} : { blocked_detail: blockedDetail }),
      ...common,
    } as AssayMeta,
    body: composeBody(subject, 'functional', shape, sourceUrl, page),
  });

  return { subject, row, page, slug: row.slug, assays };
}

interface Scored {
  verdict: Verdict | null;
  top_severity: Severity;
  risk_score: number;
  source: 'headline' | 'rollup';
}

/**
 * The assay's own answer, in order of authority: the report headline, then the roll-up row.
 *
 * A page that exists but whose headline will not parse is an error, never a silent
 * `compliant` — the whole failure mode this function exists to prevent is a Critical app
 * quietly reading as clean.
 */
function scoreFrom(
  head: ReturnType<typeof parseHeadline> | null,
  row: RollupRow,
  subject: string,
  functionalRan: boolean,
): Scored {
  if (head?.verdict) {
    const tier = head.topSeverity ?? 'none';
    return {
      verdict: scopeVerdict(head.verdict, tier, functionalRan),
      top_severity: tier,
      risk_score: head.riskScore ?? 0,
      source: 'headline',
    };
  }
  if (head) {
    throw new Error(
      `${subject}: the report page has no parsable verdict headline. ` +
        'Refusing to import it as compliant — fix parseHeadline or the page.',
    );
  }
  // No page at all: the roll-up row is the only record there is.
  const verdict: Verdict | null =
    row.kind === 'compliant' ? 'compliant'
    : row.kind === 'non-compliant' ? 'non-compliant'
    : row.kind === 'errored' ? 'errored'
    : null;
  return {
    verdict: scopeVerdict(verdict, row.severity, functionalRan),
    top_severity: row.severity,
    risk_score: row.risk ?? 0,
    source: 'rollup',
  };
}

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
function scopeVerdict(
  verdict: Verdict | null,
  tier: Severity,
  functionalRan: boolean,
): Verdict | null {
  if (verdict !== 'errored' || functionalRan) return verdict;
  return tier === 'none' ? 'compliant' : 'non-compliant';
}

/**
 * Signals in an errored E9 note that the auth gate is not merely unobserved but doubtful.
 * A bare "Not reachable." or "Depends on C/D." is not one.
 */
const SUSPECTED_AUTH_RISK =
  /auth[- ]?bypass|\bbypass\b|deliberately disabled|disabled and undocumented|no auth|without auth|published credential|seeded with|undocumented|first-signup|onboarding gate|see (the )?(major|critical|minor)|see [A-Z]\d|treated as .?local|bypassable/i;

function blockedReasonDetail(section: string): string | null {
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
function composeBody(
  subject: string,
  leg: Leg,
  shape: ReturnType<typeof shapeReport> | null,
  sourceUrl: string | null,
  page: string | null,
): string {
  const parts: string[] = [];
  parts.push(`# Yundera/AppStore — ${subject} · ${leg} leg\n`);
  parts.push(
    sourceUrl
      ? `> Imported from the combined audit report at ${sourceUrl}, which covers both legs.\n> The ${leg} section is reproduced below verbatim.\n`
      : `> No per-app report page exists for ${subject}; this assay is reconstructed from the\n> roll-up index row alone.\n`,
  );
  if (shape?.preamble) parts.push(shape.preamble);
  const section = leg === 'static' ? shape?.staticSection : shape?.functionalSection;
  if (section) parts.push(section.text.trim());
  else if (page) parts.push(`## ${leg === 'static' ? 'Tech & Documentation' : 'Functionality'}\n\n_The source report has no ${leg} section._`);
  if (shape?.tail) parts.push(shape.tail);
  return `\n${parts.join('\n\n')}\n`;
}

/**
 * `- **Last audit finished:** 2026-08-19T12:28:28Z` from the roll-up's Loop status block.
 * `—` is n8n's own placeholder for "never", and is not a timestamp.
 */
export function parseLastAuditFinished(markdown: string): string | undefined {
  const m = markdown.match(/Last audit finished:\*\*\s*(\S+)/);
  const raw = m?.[1];
  if (!raw || raw === '—' || raw === '-') return undefined;
  return Number.isNaN(Date.parse(raw)) ? undefined : raw;
}

// ── the run ────────────────────────────────────────────────────────────────────────────

/** What one import did. The CLI prints it; the timer logs it and moves on. */
export interface ImportSummary {
  /**
   * n8n's own `- **Last audit finished:**` line, verbatim.
   *
   * The scheduler's cooldown anchor during shadow mode, and the one input it cannot derive
   * for itself: the roll-up's Last run column carries a date with no clock, so every
   * imported assay reads as finished at midnight and a 55-minute cooldown computed from the
   * archive has always already expired. Reading it here costs nothing — the page is already
   * fetched — and it is what makes a cooldown tick comparable between the two systems.
   */
  lastAuditFinished?: string;
  /**
   * Each row's Result and Last run cells, for the scheduler to read n8n's try counts and
   * parks out of — `scheduler/adopt.ts` explains why a shadow diff is meaningless without
   * them. Transitional, and it goes with the roll-up at M5.
   */
  rollupSchedule: { subject: string; raw: string; lastRun: string | null }[];
  subjects: number;
  fetched: number;
  rollupOnly: string[];
  functionalBlocked: number;
  scoredFromRow: number;
  written: number;
  unchanged: number;
  reportsRoot: string;
}

export interface ImportOptions extends Partial<ImportArgs> {
  /** Where to load config from. Defaults to the resolved data dir. */
  dataDir?: string;
  /**
   * The live index. Every written report is upserted into it, so the API serves the new
   * record immediately rather than at the next restart.
   */
  index?: { upsert(record: AssayRecord): void };
  /** Progress lines. The CLI passes `console.log`; the server passes nothing. */
  onProgress?: (line: string) => void;
}

/**
 * Read the roll-up, fetch each linked report, write both legs per subject.
 *
 * Idempotent: every value is derived from the source pages, timestamps included, so a
 * second run writes nothing and reports `written 0`. That is what makes running it on a
 * timer safe, and it is also the transitional data feed for P3 — n8n updates the roll-up
 * each tick and we re-read it, with zero changes to n8n (see the plan, P2).
 */
export async function runImport(opts: ImportOptions = {}): Promise<ImportSummary> {
  const args: ImportArgs = {
    refresh: opts.refresh ?? false,
    offline: opts.offline ?? false,
    dryRun: opts.dryRun ?? false,
    // Default on. A cached roll-up is never what a caller wants unless they asked to be
    // offline — see the field's comment for the thirteen days this cost.
    refreshRollup: opts.refreshRollup ?? !(opts.offline ?? false),
  };
  const say = opts.onProgress ?? (() => {});

  const cfg = await loadConfig(opts.dataDir);
  const standards = await loadStandards(cfg.standardsDir);
  const staticStd = standards.find((s) => s.leg === 'static');
  const functionalStd = standards.find((s) => s.leg === 'functional');
  if (!staticStd || !functionalStd) {
    throw new Error(`no standards found under ${cfg.standardsDir}`);
  }
  say(`standards: ${standards.map((s) => `${s.id} v${s.version}`).join(', ')}`);

  const rollup = stripDocmostBanner(
    await getPage(cfg.docmost.rollupSlug, cfg.docmost.cacheDir, {
      ...args,
      refresh: args.refresh || args.refreshRollup === true,
    }),
  );
  const rows = parseRollup(rollup);
  const lastAuditFinished = parseLastAuditFinished(rollup);
  say(`roll-up: ${rows.length} subjects`);
  // Zero rows means the page moved or the parser broke, never that the store emptied.
  // Writing that through would blank the archive, so it is an error, loudly.
  if (rows.length === 0) throw new Error('roll-up table parsed to zero rows');

  const imports: SubjectImport[] = [];
  const noReport: string[] = [];

  for (const row of rows) {
    let page: string | null = null;
    if (row.slug) {
      try {
        // Re-fetch this subject's report only when the roll-up says it has been audited
        // since the copy we hold. Everything else comes off disk.
        const stale = row.lastRun ? (await storedLastRun(cfg.reportsRoot, row.subject)) !== row.lastRun : false;
        const raw = stripDocmostBanner(
          await getPage(row.slug, cfg.docmost.cacheDir, { ...args, refresh: args.refresh || stale }),
        );
        // Two rows link to the parent "App Audits" index rather than to a report. Detect
        // that by shape, not by slug, so a future mis-link is caught the same way.
        const shape = shapeReport(raw);
        page = shape.staticSection || shape.functionalSection ? raw : null;
      } catch (err) {
        say(`  ! ${row.subject}: ${String(err).slice(0, 120)}`);
      }
    }
    if (!page) noReport.push(row.subject);
    imports.push(buildSubject(row, page, { staticStd, functionalStd }));
  }

  let written = 0;
  let unchanged = 0;
  for (const imp of imports) {
    for (const a of imp.assays) {
      if (args.dryRun) continue;
      const res = await writeReport(cfg.reportsRoot, a.meta, a.body);
      if (res.written) written++;
      else unchanged++;
      // Keep the live index in step with the disk. Unconditional rather than only on
      // `written`, because an index that missed a file once would stay wrong forever.
      opts.index?.upsert({
        meta: a.meta,
        path: res.rel,
        subject: a.meta.subject,
        file: path.basename(res.rel),
      });
    }
  }

  return {
    lastAuditFinished,
    rollupSchedule: rows.map((r) => ({ subject: r.subject, raw: r.raw, lastRun: r.lastRun })),
    subjects: imports.length,
    fetched: imports.length - noReport.length,
    rollupOnly: noReport,
    functionalBlocked: imports.filter((i) =>
      i.assays.some((a) => a.meta.leg === 'functional' && a.meta.status === 'blocked'),
    ).length,
    scoredFromRow: imports.filter((i) => !i.page).length,
    written,
    unchanged,
    reportsRoot: cfg.reportsRoot,
  };
}
