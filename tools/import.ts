/**
 * `yarn import` — pull the AppStore QA corpus out of Docmost into `data/reports/**`.
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
 *   yarn import               fetch from Docmost via beacon, using the on-disk page cache
 *   yarn import --refresh     ignore the page cache and re-fetch every page
 *   yarn import --offline     fail rather than hit the network; cache only
 *   yarn import --dry-run     parse and report, write nothing
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AssayMeta, Finding, Leg, Severity } from '../src/shared/types.js';
import { SEVERITY_RANK } from '../src/shared/types.js';
import { loadConfig, loadStandards, type Standard } from '../src/server/store/config.js';
import { writeReport, riskScore } from '../src/server/store/reports.js';
import { callTool } from './mcp.js';
import {
  compileRules,
  extractFindings,
  parseHeadline,
  parsePhases,
  parseRollup,
  shapeReport,
  type CompiledRule,
  type RollupRow,
  MANDATORY_PHASES,
} from './extract.js';

const DOCMOST_TOOL = 'beacon-yunderalabs.docmost-mcp__get_page';
const PAGE_BASE = 'https://docmost-yunderalabs.nsl.sh/s/general/p/';

interface Args {
  refresh: boolean;
  offline: boolean;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    refresh: argv.includes('--refresh'),
    offline: argv.includes('--offline'),
    dryRun: argv.includes('--dry-run'),
  };
}

// ── page fetching ──────────────────────────────────────────────────────────────────────

/**
 * Raw Docmost pages are cached on disk. Not an optimisation — it is what makes the import
 * reproducible and lets the parser be iterated on without hammering a production wiki.
 */
async function getPage(slug: string, cacheDir: string, args: Args): Promise<string> {
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

// ── per-subject assembly ───────────────────────────────────────────────────────────────

interface SubjectImport {
  subject: string;
  row: RollupRow;
  page: string | null;
  slug: string | null;
  assays: { meta: AssayMeta; body: string }[];
}

function topSeverity(findings: Finding[]): Severity {
  let top: Severity = 'none';
  for (const f of findings) {
    if (f.status !== 'fail') continue;
    if (SEVERITY_RANK[f.severity] > SEVERITY_RANK[top]) top = f.severity;
  }
  return top;
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
  rules: { all: CompiledRule[]; functionalCodes: Set<string> },
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

  // ── static leg ───────────────────────────────────────────────────────────────────────
  let staticFindings: Finding[] = [];
  let functionalExtra: Finding[] = [];
  if (shape?.staticSection) {
    const all = extractFindings(shape.staticSection.text, { rules: rules.all });
    // A finding whose code belongs to the functional standard was raised in the static
    // prose but is a statement about the functional leg — Prowlarr's "the reverse-proxy
    // auth-bypass advisory is precisely what E9 would have settled" is the archetype.
    // Only *suspicions* migrate. An observed static result stays on the static leg even when
    // it concerns the same defect a functional phase would have checked — Radarr's static
    // "no authentication method enabled" is a static finding that happens to agree with its
    // functional E9 failure, and recording it once per leg is correct.
    const migrates = (f: Finding): boolean =>
      rules.functionalCodes.has(f.rule) && (f.status === 'unverified' || f.status === 'advisory');
    staticFindings = all.filter((f) => !migrates(f));
    functionalExtra = all.filter(migrates).map((f) => ({ ...f, status: 'unverified' as const }));
  }

  const staticRan = Boolean(shape?.staticSection) && !/not\s+(completed|run)/i.test(shape?.staticSection?.heading ?? '');
  const staticVerdict = !staticRan
    ? row.kind === 'errored'
      ? 'errored'
      : row.kind === 'non-compliant'
        ? 'non-compliant'
        : null
    : staticFindings.some((f) => f.status === 'fail')
      ? 'non-compliant'
      : 'compliant';

  assays.push({
    meta: {
      subject,
      leg: 'static',
      standard: staticStd.name,
      standard_version: staticStd.version,
      status: 'done',
      verdict: staticVerdict,
      top_severity: topSeverity(staticFindings),
      risk_score: riskScore(staticFindings),
      blocked_reason: null,
      ...common,
      findings: staticFindings,
    } as AssayMeta,
    body: composeBody(subject, 'static', shape, sourceUrl, page),
  });

  // ── functional leg ───────────────────────────────────────────────────────────────────
  const phases = shape?.functionalSection ? parsePhases(shape.functionalSection.text) : [];
  // A leg "ran" only if a *mandatory* phase produced a real result. Reading `H — Cleanup |
  // pass | nothing was installed, so there was nothing to uninstall` as a completed run is
  // precisely the mistake that turns a bench outage into a verdict about the app.
  const ran = phases.some(
    (p) => MANDATORY_PHASES.has(p.code) && (p.result === 'pass' || p.result === 'fail'),
  );

  const functionalFindings: Finding[] = ran
    ? phases
        .filter((p) => p.result !== 'errored')
        .map((p) => {
          const def = functionalStd.rules.find((r) => r.code === p.code);
          const status = p.result === 'n-a' ? 'n-a' : p.result;
          return {
            rule: p.code,
            title: def?.title ?? p.label,
            severity: (status === 'fail' ? (def?.severity ?? 'major') : 'none') as Severity,
            status,
            ...(p.note ? { note: p.note } : {}),
          } as Finding;
        })
    : [];

  // Merge the unverified advisories raised in the static prose, without letting them
  // displace an observed result for the same phase.
  for (const extra of functionalExtra) {
    if (functionalFindings.some((f) => f.rule === extra.rule)) continue;
    functionalFindings.push(extra);
  }

  // The suspected-Critical queue. When the bench blocked E9, most reports write "Not
  // reachable." and there is nothing to say. A minority instead record what the static
  // analysis *expects* the gate to be and why that expectation is doubtful — a disabled
  // default, a published credential, a reverse-proxy bypass. Those are the rows worth
  // draining first the moment the pool comes back, so they are promoted to a finding with
  // `status: unverified` and the *suspected* severity, never to an observed fail.
  if (!ran && !functionalFindings.some((f) => f.rule === 'E9')) {
    const e9 = phases.find((p) => p.code === 'E9');
    if (e9 && SUSPECTED_AUTH_RISK.test(e9.note)) {
      const def = functionalStd.rules.find((r) => r.code === 'E9');
      functionalFindings.push({
        rule: 'E9',
        title: def?.title ?? 'auth gate',
        severity: def?.severity ?? 'critical',
        status: 'unverified',
        note: e9.note,
      });
    }
  }

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
      verdict: ran
        ? functionalFindings.some((f) => f.status === 'fail')
          ? 'non-compliant'
          : 'compliant'
        : null,
      top_severity: topSeverity(functionalFindings),
      risk_score: riskScore(functionalFindings),
      // The whole point of the distinction: the bench was unreachable, so there is no
      // verdict to give. `errored` would read as a statement about the subject.
      blocked_reason: ran ? null : 'bench_unavailable',
      ...(ran || !blockedDetail ? {} : { blocked_detail: blockedDetail }),
      ...common,
      findings: functionalFindings,
    } as AssayMeta,
    body: composeBody(subject, 'functional', shape, sourceUrl, page),
  });

  return { subject, row, page, slug: row.slug, assays };
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

// ── family propagation ─────────────────────────────────────────────────────────────────

/**
 * Some findings are stated once, about several apps: "this is a family-wide convention —
 * Radarr, Sonarr, Lidarr and qBittorrent all ship `cpu_shares: 10`". That sentence is the
 * only record that four other apps carry the same defect, and one of them has no report
 * page at all. Left as prose it is invisible to every query.
 *
 * So it is propagated — onto the named siblings, as `unverified`, never as an observed
 * `fail`, and never over the top of a result the sibling's own report established. The
 * severity travels as the *suspected* severity, which is exactly what `unverified` means in
 * the contract, and the UI parenthesises its risk rather than counting it.
 */
function propagateFamilies(
  imports: SubjectImport[],
  rules: CompiledRule[],
): { rule: string; from: string; to: string }[] {
  const subjects = new Map(imports.map((i) => [i.subject.toLowerCase(), i.subject]));
  const applied: { rule: string; from: string; to: string }[] = [];

  for (const rule of rules) {
    if (!rule.family.length) continue;
    for (const src of imports) {
      if (!src.page) continue;
      for (const re of rule.family) {
        const m = re.exec(src.page);
        if (!m?.[1]) continue;
        const named = m[1]
          .split(/,| and | & /)
          .map((s) => s.trim())
          .filter(Boolean);
        for (const name of named) {
          const canonical = subjects.get(name.toLowerCase());
          if (!canonical) continue;
          const target = imports.find((i) => i.subject === canonical)!;
          const assay = target.assays.find((a) => a.meta.leg === 'static')!;
          if (assay.meta.findings.some((f) => f.rule === rule.code)) continue;
          assay.meta.findings.push({
            rule: rule.code,
            title: rule.title,
            severity: rule.severity,
            status: 'unverified',
            note: `named by the ${src.subject} report as sharing this defect; not independently observed on ${canonical}`,
          });
          applied.push({ rule: rule.code, from: src.subject, to: canonical });
        }
      }
    }
  }
  return applied;
}

// ── main ───────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig();
  const standards = await loadStandards(cfg.standardsDir);
  const staticStd = standards.find((s) => s.leg === 'static');
  const functionalStd = standards.find((s) => s.leg === 'functional');
  if (!staticStd || !functionalStd) {
    throw new Error(`no standards found under ${cfg.standardsDir} — cannot code findings`);
  }
  const functionalCodes = new Set(functionalStd.rules.map((r) => r.code));
  // Static rules first. A static checklist item that *observes* something about auth is a
  // static finding (SEC1); only what the static rules leave unmatched — the reverse-proxy
  // bypass suspicions phrased around the runtime check — should fall through to E9.
  const compiled = compileRules([
    ...staticStd.rules,
    ...functionalStd.rules.filter((r) => r.match?.length),
  ]);

  console.log(`standards: ${standards.map((s) => `${s.id} (${s.rules.length} rules)`).join(', ')}`);

  const rollup = stripDocmostBanner(
    await getPage(cfg.docmost.rollupSlug, cfg.docmost.cacheDir, args),
  );
  const rows = parseRollup(rollup);
  console.log(`roll-up: ${rows.length} subjects`);
  if (rows.length === 0) throw new Error('roll-up table parsed to zero rows');

  const imports: SubjectImport[] = [];
  const noReport: string[] = [];

  for (const row of rows) {
    let page: string | null = null;
    if (row.slug) {
      try {
        const raw = stripDocmostBanner(await getPage(row.slug, cfg.docmost.cacheDir, args));
        // Two rows link to the parent "App Audits" index rather than to a report. Detect
        // that by shape, not by slug, so a future mis-link is caught the same way.
        const shape = shapeReport(raw);
        page = shape.staticSection || shape.functionalSection ? raw : null;
      } catch (err) {
        console.warn(`  ! ${row.subject}: ${String(err).slice(0, 120)}`);
      }
    }
    if (!page) noReport.push(row.subject);
    imports.push(
      buildSubject(row, page, { staticStd, functionalStd }, { all: compiled, functionalCodes }),
    );
  }

  const propagated = propagateFamilies(imports, compiled);

  // Recompute the derived scalars for any assay a propagated finding touched. `unverified`
  // never contributes to risk, so only the finding list actually changes — but recomputing
  // keeps the invariant "risk_score is a function of findings" true by construction.
  for (const imp of imports) {
    for (const a of imp.assays) {
      a.meta.risk_score = riskScore(a.meta.findings);
      a.meta.top_severity = topSeverity(a.meta.findings);
    }
  }

  let written = 0;
  let unchanged = 0;
  for (const imp of imports) {
    for (const a of imp.assays) {
      if (args.dryRun) continue;
      const res = await writeReport(cfg.reportsRoot, a.meta, a.body);
      if (res.written) written++;
      else unchanged++;
    }
  }

  const blocked = imports.filter((i) =>
    i.assays.some((a) => a.meta.leg === 'functional' && a.meta.status === 'blocked'),
  ).length;

  console.log('');
  console.log(`subjects            ${imports.length}`);
  console.log(`reports fetched     ${imports.length - noReport.length}`);
  console.log(`roll-up only        ${noReport.length}${noReport.length ? ` (${noReport.join(', ')})` : ''}`);
  console.log(`functional blocked  ${blocked}`);
  console.log(`findings            ${imports.reduce((n, i) => n + i.assays.reduce((m, a) => m + a.meta.findings.length, 0), 0)}`);
  if (propagated.length) {
    console.log(`propagated          ${propagated.length}`);
    for (const p of propagated) console.log(`  ${p.rule}: ${p.from} → ${p.to}`);
  }
  console.log(args.dryRun ? 'dry run — nothing written' : `written ${written}, unchanged ${unchanged}`);
  console.log(`reports root        ${cfg.reportsRoot}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
