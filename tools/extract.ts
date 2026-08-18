/**
 * Reading a report page: its roll-up row, its two legs, and its headline.
 *
 * The reports are written by an LLM against a protocol, not by a serialiser, so nothing
 * about their shape is guaranteed. What *is* reliable is what the agent was asked for by
 * contract — a verdict, a severity tier and a risk score, stated in the headline — so that
 * is all this module reads. It does not mine the prose for findings: per ARCHITECTURE.md
 * principle 3 the assay's own declaration is authoritative, and an earlier version of this
 * file that re-derived a tier from the body promoted four Critical apps to `compliant`.
 *
 * Four parsers, in the order the importer uses them:
 *
 *   parseRollup    — the 69-row table, one row per subject
 *   shapeReport    — split a page into its static and functional sections
 *   parseHeadline  — the verdict line, plus the refs around it
 *   parsePhases    — the functional phase table, which says whether the leg ran at all
 *
 * `shapeReport` and `parsePhases` outlive the migration: the runner reuses them to split
 * one `depth=full` agent response into two assay files (P5).
 */

import type { Severity } from '../src/shared/types.js';

// ── roll-up table ──────────────────────────────────────────────────────────────────────

export type RollupKind = 'compliant' | 'non-compliant' | 'errored' | 'in-progress' | 'not-run';

export interface RollupRow {
  n: number;
  subject: string;
  kind: RollupKind;
  severity: Severity;
  /** `null` where the table shows `—`, i.e. not scored under the strict model. */
  risk: number | null;
  lastRun: string | null;
  slug: string | null;
  raw: string;
}

const SEVERITIES: Record<string, Severity> = {
  critical: 'critical',
  major: 'major',
  minor: 'minor',
  none: 'none',
};

/** Parse the 69-row Results table out of the roll-up page. */
export function parseRollup(md: string): RollupRow[] {
  const rows: RollupRow[] = [];
  for (const line of md.split('\n')) {
    const m = /^\|\s*(\d+)\s*\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|/.exec(line);
    if (!m) continue;
    const [, n, subjectCell, resultCell, riskCell, lastRunCell, reportCell] = m;
    const subject = clean(subjectCell!);
    const result = clean(resultCell!);
    let kind: RollupKind = 'not-run';
    if (/non-compliant/i.test(result)) kind = 'non-compliant';
    else if (/\bcompliant\b/i.test(result)) kind = 'compliant';
    else if (/errored/i.test(result)) kind = 'errored';
    else if (/in progress/i.test(result)) kind = 'in-progress';

    const sev = /\b(critical|major|minor)\b/i.exec(result);
    const riskRaw = clean(riskCell!);
    const risk = /^\d+$/.test(riskRaw) ? Number(riskRaw) : null;
    const lastRun = /(\d{4}-\d{2}-\d{2})/.exec(lastRunCell!)?.[1] ?? null;
    const slug = /\/p\/([A-Za-z0-9]+)\)/.exec(reportCell!)?.[1] ?? null;

    rows.push({
      n: Number(n),
      subject,
      kind,
      severity: sev ? SEVERITIES[sev[1]!.toLowerCase()]! : 'none',
      risk,
      lastRun,
      slug,
      raw: result,
    });
  }
  return rows;
}

// ── page structure ─────────────────────────────────────────────────────────────────────

export interface Section {
  heading: string;
  level: number;
  /** The heading line plus everything up to the next heading of the same or higher level. */
  text: string;
}

/** Split on H2s. Docmost prepends a `# None <title>` banner, which is dropped upstream. */
export function splitSections(md: string): Section[] {
  const lines = md.split('\n');
  const out: Section[] = [];
  let current: Section | null = null;
  let fenced = false;
  for (const line of lines) {
    if (/^```/.test(line)) fenced = !fenced;
    const h = !fenced && /^(#{2,3})\s+(.*)$/.exec(line);
    if (h && h[1]!.length === 2) {
      if (current) out.push(current);
      current = { heading: clean(h[2]!), level: 2, text: `${line}\n` };
      continue;
    }
    if (current) current.text += `${line}\n`;
    else {
      if (!out.length || out[0]!.heading !== '') out.unshift({ heading: '', level: 0, text: '' });
      out[0]!.text += `${line}\n`;
    }
  }
  if (current) out.push(current);
  return out;
}

const STATIC_HEADING = /^tech\s*&\s*documentation|^static\b/i;
const FUNCTIONAL_HEADING = /^functionality|^functional\s+(leaf|review)/i;

export interface ReportShape {
  preamble: string;
  staticSection: Section | null;
  functionalSection: Section | null;
  /** Sections after both legs — bottom line, remediation, cleanup. Kept for both bodies. */
  tail: string;
}

/**
 * Several reports hoist their findings out of the leg section into a top-level `## Findings`
 * or `## Failing items` — FileBrowser's F1–F4 live there, cpu_shares among them. Those are a
 * continuation of the leg that preceded them, not a new topic, so they are folded back in.
 */
const CONTINUATION_HEADING =
  /^(findings?\b|summary of findings|findings summary|failing\b|passing\b|advisor|deviation table|checklist|static (result|leaf|verdict)|phase results)/i;

export function shapeReport(md: string): ReportShape {
  const sections = splitSections(md);
  const preambleParts: string[] = [];
  let staticSection: Section | null = null;
  let functionalSection: Section | null = null;
  const tail: string[] = [];
  let currentLeg: Section | null = null;

  for (const s of sections) {
    if (!staticSection && STATIC_HEADING.test(s.heading)) {
      staticSection = s;
      currentLeg = s;
      continue;
    }
    if (!functionalSection && FUNCTIONAL_HEADING.test(s.heading)) {
      functionalSection = s;
      currentLeg = s;
      continue;
    }
    if (currentLeg && CONTINUATION_HEADING.test(s.heading)) {
      // These sections belong to the static leg unless they are explicitly phase results:
      // the functional leg states itself in its phase table, whereas a trailing
      // `## Findings` is where the checklist items were hoisted to. FileBrowser puts
      // `## Findings` *after* `## Functionality` and fills it with static items, so
      // position is not a reliable signal — content is.
      const target = /^phase results/i.test(s.heading) ? currentLeg : (staticSection ?? currentLeg);
      target.text += `\n${s.text}`;
      continue;
    }
    if (currentLeg) tail.push(s.text);
    else preambleParts.push(s.text);
  }
  return {
    preamble: preambleParts.join('').trim(),
    staticSection,
    functionalSection,
    tail: tail.join('').trim(),
  };
}

// ── headline ───────────────────────────────────────────────────────────────────────────

export interface Headline {
  verdict: 'compliant' | 'non-compliant' | 'errored' | 'deferred' | null;
  topSeverity: Severity | null;
  riskScore: number | null;
  auditDate: string | null;
  images: string[];
  composeSha: string | null;
  ref: string | null;
  scope: string | null;
}

const IMAGE_RE = /`([a-z0-9][a-z0-9._\-]*(?:[/][a-z0-9._\-]+)*:[A-Za-z0-9][\w.\-]*)`/g;

export function parseHeadline(md: string): Headline {
  const head = md.slice(0, 4000);

  // The window between the verdict word and the tier is generous because the reports put
  // a parenthetical there: DocmostMCP writes `ERRORED (audit could not complete — functional
  // half unrunnable) · top severity Major`, which is 55 characters of aside. Still anchored
  // to one line and to the verdict keyword, so a wider window cannot wander into a
  // neighbouring sentence.
  const verdictM =
    /\*{0,2}(NON-COMPLIANT|COMPLIANT|ERRORED|DEFERRED)\b[^\n]{0,120}?(?:top severity\s*)?\b(Critical|Major|Minor|None)\b[^\n]{0,30}?risk[ _]score\s*(\d+)/i.exec(
      head,
    ) ??
    /\*{0,2}(NON-COMPLIANT|COMPLIANT|ERRORED|DEFERRED)\b[^\n]{0,120}?\b(Critical|Major|Minor|None)\b/i.exec(
      head,
    );

  let verdict: Headline['verdict'] = null;
  let topSeverity: Severity | null = null;
  let riskScore: number | null = null;
  if (verdictM) {
    const v = verdictM[1]!.toLowerCase();
    verdict = v === 'non-compliant' ? 'non-compliant' : (v as Headline['verdict']);
    topSeverity = SEVERITIES[verdictM[2]!.toLowerCase()] ?? null;
    if (verdictM[3]) riskScore = Number(verdictM[3]);
  }
  if (riskScore === null) {
    const r = /risk[ _]score\D{0,12}(\d+)/i.exec(head);
    if (r) riskScore = Number(r[1]);
  }

  const auditDate = /audit date\**:?\**\s*(\d{4}-\d{2}-\d{2})/i.exec(head)?.[1] ?? null;

  const versionLine =
    /(?:current )?store version\**:?\**\s*([^\n]*)/i.exec(head)?.[1] ??
    /\*{0,2}image\**:?\**\s*([^\n]*)/i.exec(head)?.[1] ??
    '';
  const images = [...versionLine.matchAll(IMAGE_RE)].map((m) => m[1]!);

  const composeSha =
    /compose (?:blob )?sha\**:?\**\s*`?([0-9a-f]{7,40})`?/i.exec(head)?.[1] ?? null;
  // `ref` and `scope` must be *labelled*, with a real separator. Without one, `\bref`
  // happily matches the front of "referrer", "reference", "therefore" and "reflects", and
  // ten of sixty-nine subjects imported a git ref of `erence` or `errer`.
  const ref = cleanRef(/\bref\**\s*[:=]\s*\**\s*`?([\w.\-/]+)`?/i.exec(head)?.[1]);
  const scope = cleanScope(/\bscope\**\s*[:=]\s*\**\s*`?([\w.\-]+)`?/i.exec(head)?.[1]);

  return { verdict, topSeverity, riskScore, auditDate, images, composeSha, ref, scope };
}

/** A git ref is a branch or a sha, never a path to a file. */
function cleanRef(value: string | undefined): string | null {
  if (!value || value.length > 60) return null;
  if (/\.(ya?ml|md|png|json)$/i.test(value)) return null;
  return value;
}

/** The protocol's `scope` is `full`, `pr-diff` or `n-a`. A bare dash is the table's blank. */
function cleanScope(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.toLowerCase();
  return v === 'full' || v === 'pr-diff' || v === 'n-a' ? v : null;
}

// ── functional phases ──────────────────────────────────────────────────────────────────

export interface PhaseResult {
  code: string;
  label: string;
  result: 'pass' | 'fail' | 'errored' | 'n-a';
  note: string;
}

const PHASE_ROW =
  /^\|\s*\*{0,2}(A|B|C|D|E\d{1,2}|F|G[-−]?(?:prime|′|')?|H)\s*\*{0,2}\s*(?:[—–-]\s*)?([^|]*)\|\s*[^|]*?\*{0,2}(pass|fail|errored|error|n-?\/?a|skipped|not[- ]run)\*{0,2}[^|]*\|([^|]*)\|?/i;

/**
 * The phases that constitute a functional run. `B` is pre-flight, `G′` is n-a whenever no
 * PRIOR_VERSION was supplied, and `H` passes trivially when nothing was ever installed — so
 * none of the three is evidence that the leg actually happened.
 */
export const MANDATORY_PHASES = new Set(['A', 'C', 'D', 'E8', 'E9', 'E10', 'F', 'G']);

export function parsePhases(section: string): PhaseResult[] {
  const out: PhaseResult[] = [];
  const seen = new Set<string>();
  for (const line of section.split('\n')) {
    const m = PHASE_ROW.exec(line);
    if (!m) continue;
    const code = /^G[-−]?(prime|′|')$/i.test(m[1]!) ? 'G′' : m[1]!.toUpperCase();
    if (seen.has(code)) continue;
    seen.add(code);
    const r = m[3]!.toLowerCase();
    out.push({
      code,
      label: cleanTitle(m[2] ?? ''),
      result: r.startsWith('pass') ? 'pass' : r.startsWith('fail') ? 'fail' : /^n-?\/?a/.test(r) ? 'n-a' : 'errored',
      note: squash(clean(m[4] ?? ''), 300),
    });
  }
  return out;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────

function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cleanTitle(s: string): string {
  return clean(
    s
      .replace(/^\s*[-*]\s+/, '')
      .replace(/^\*{0,2}(?:[A-Z]?\d{1,2})[.)]\s*\*{0,2}/, '')
      .replace(/^\*{0,2}([A-Z]\d{1,2})\s*[—–-]\s*/, '')
      // Emphasis only — a bare `_` is part of an identifier here (`cpu_shares`, `x-casaos`).
      .replace(/\*{1,2}/g, '')
      .replace(/`/g, '')
      .replace(/[✅❌⚠️⛔⏳⬜✔✗🔄🧹]/gu, '')
      .replace(/\s*[—–·|,]\s*(?:❌\s*)?(?:FAIL|fail|PASS|pass)\b.*$/, '')
      .replace(/\s*[—–·]\s*(Critical|Major|Minor)\s*$/i, '')
      .replace(/\s*\((?:rule\s+)?[A-Z]\d?['′]?\)\s*$/i, '')
      .replace(/\s*[—–·:]\s*$/, ''),
  ).slice(0, 120);
}

function squash(s: string, max: number): string {
  const t = clean(s.replace(/[*`]/g, ''));
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
