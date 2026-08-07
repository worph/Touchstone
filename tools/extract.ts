/**
 * Turning the Docmost corpus into assays and findings.
 *
 * The reports are written by an LLM against a protocol, not by a serialiser, so nothing
 * about their shape is guaranteed. Across 57 pages the same finding appears as a numbered
 * bold paragraph, a table row, an H3 heading, and a bullet with a `[Minor]` prefix. The
 * strategy that survives that is:
 *
 *   1. split the page into the two legs by heading, and keep the prose verbatim;
 *   2. chop each leg into *items* — one bullet, one table row, one numbered paragraph;
 *   3. read each item's status and severity from whatever marker it happens to carry,
 *      falling back to the enclosing "Passing / Failing / Advisory" heading;
 *   4. normalise the item's text onto a rule code from data/standards/*.yaml.
 *
 * Step 4 is the point of the exercise. Everything before it is plumbing, and everything
 * after it — grouping, risk, the Findings page — depends on it being right, so an item that
 * matches no rule is never silently dropped: it keeps a synthetic `x:<slug>` code so the
 * long tail stays countable and the frequent members of it can be promoted into the
 * vocabulary later.
 */

import type { Finding, FindingStatus, Severity } from '../src/shared/types.js';
import type { RuleDef } from '../src/server/store/config.js';

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

  const verdictM =
    /\*{0,2}(NON-COMPLIANT|COMPLIANT|ERRORED|DEFERRED)\b[^\n]{0,40}?(?:top severity\s*)?\b(Critical|Major|Minor|None)\b[^\n]{0,20}?risk[ _]score\s*(\d+)/i.exec(
      head,
    ) ??
    /\*{0,2}(NON-COMPLIANT|COMPLIANT|ERRORED|DEFERRED)\b[^\n]{0,40}?\b(Critical|Major|Minor|None)\b/i.exec(
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
  const ref = /\bref\**:?\**\s*`?([\w.\-/]+)`?/i.exec(head)?.[1] ?? null;
  const scope = /\bscope\**:?\**\s*`?([\w.\-]+)`?/i.exec(head)?.[1] ?? null;

  return { verdict, topSeverity, riskScore, auditDate, images, composeSha, ref, scope };
}

// ── items ──────────────────────────────────────────────────────────────────────────────

interface Item {
  /** The heading the item sits under, used as the status fallback. */
  mode: FindingStatus | null;
  title: string;
  note: string;
  /** Everything, for rule matching. */
  text: string;
  /** Set when the source states the status unambiguously, e.g. a table's Verdict column. */
  status?: FindingStatus;
}

const MODE_HEADINGS: [RegExp, FindingStatus][] = [
  [/advisor|opinion|flagged|weak pass/i, 'advisory'],
  [/^n-?\/?a\b|not assessable|not applicable/i, 'n-a'],
  [/fail|finding|deficien|remediation|deviation/i, 'fail'],
  [/pass|compliant item/i, 'pass'],
];

function modeFor(heading: string): FindingStatus | null {
  for (const [re, status] of MODE_HEADINGS) if (re.test(heading)) return status;
  return null;
}

/** Chop a leg section into candidate items. */
export function chopItems(section: string): Item[] {
  const lines = section.split('\n');
  const items: Item[] = [];
  let mode: FindingStatus | null = null;
  let fenced = false;
  let buf: string[] = [];
  let bufMode: FindingStatus | null = null;

  const flush = (): void => {
    if (!buf.length) return;
    const text = buf.join('\n').trim();
    buf = [];
    if (!text) return;
    const { title, note } = titleAndNote(text);
    if (!title) return;
    items.push({ mode: bufMode, title, note, text });
  };

  for (const raw of lines) {
    if (/^```/.test(raw)) {
      fenced = !fenced;
      if (buf.length) buf.push(raw);
      continue;
    }
    if (fenced) {
      if (buf.length) buf.push(raw);
      continue;
    }

    const heading = /^#{2,6}\s+(.*)$/.exec(raw);
    if (heading) {
      flush();
      const h = clean(heading[1]!);
      const m = modeFor(h);
      // An H3/H4 that is itself a finding ("### F3 — cpu_shares: 10 is the wrong tier ·
      // **Minor**") rather than a section label. Section labels are short and generic.
      if (m && /^(passing|failing|advisor|findings?|n-?a|not assessable)/i.test(h)) {
        mode = m;
      } else if (/^(passing|failing|advisor|findings?|n-?a|not assessable|cleanup|phase)/i.test(h)) {
        mode = m;
      } else if (mode) {
        bufMode = mode;
        buf = [raw.replace(/^#+\s+/, '')];
        continue;
      }
      continue;
    }

    // Table row.
    if (/^\s*\|/.test(raw)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue;
      flush();
      const cells = raw.split('|').slice(1, -1).map((c) => clean(c));
      if (cells.length < 2) continue;
      if (/^(item|check|checklist|rule|#|phase|id)$/i.test(cells[0] ?? '')) continue;
      const item = tableItem(cells, mode);
      if (item) items.push(item);
      continue;
    }

    // Bullet or numbered-bold item.
    if (/^\s*[-*]\s+\S/.test(raw) || /^\*\*\d+\.\s/.test(raw) || /^\d+\.\s+\S/.test(raw)) {
      flush();
      bufMode = mode;
      buf = [raw];
      continue;
    }

    // Continuation of the current item, or prose between items.
    if (buf.length) {
      if (raw.trim() === '') buf.push('');
      else buf.push(raw);
      continue;
    }
  }
  flush();
  return items;
}

const TABLE_STATUS: [RegExp, FindingStatus][] = [
  [/^unverified/i, 'unverified'],
  [/^(weak )?pass/i, 'pass'],
  [/^fail/i, 'fail'],
  [/^n-?\/?a\b/i, 'n-a'],
  [/^advisory/i, 'advisory'],
  // `errored` is a phase outcome, not a finding about the subject. Recorded so the row is
  // recognised as a checklist row, then dropped by the caller.
  [/^errored?/i, 'unverified'],
];

function tableItem(cells: string[], mode: FindingStatus | null): Item | null {
  // Emphasis is decorative and inconsistent — `pass`, **fail**, **FAIL** and `pass (D4)`
  // all appear — so match against a de-emphasised copy while keeping the original text.
  const bare = cells.map((c) => c.replace(/[*`]/g, '').trim());
  let statusIdx = -1;
  let status: FindingStatus | null = null;
  let sevIdx = -1;
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i]!;
    if (statusIdx < 0) {
      const hit = TABLE_STATUS.find(([re]) => re.test(c));
      if (hit && c.length < 40) {
        statusIdx = i;
        status = hit[1];
        continue;
      }
    }
    if (sevIdx < 0 && /^(critical|major|minor|none|—|-|n-?\/?a)$/i.test(c)) sevIdx = i;
  }
  if (statusIdx < 0 || !status) return null;
  const titleCells = cells.filter((_, i) => i !== statusIdx && i !== sevIdx);
  // A leading short code cell ("S3", "F5", "1") is an in-report index, not a title.
  const first = titleCells[0] ?? '';
  const titleIdx = /^[A-Z]?\d{1,2}$/.test(first.replace(/[*`]/g, '').trim()) ? 1 : 0;
  const title = cleanTitle(titleCells[titleIdx] ?? first);
  if (!title) return null;
  const note = titleCells.slice(titleIdx + 1).join(' — ');
  // Severity lives in its own column here, so hand it to the matcher explicitly.
  const sevCell = sevIdx >= 0 ? bare[sevIdx]! : '';
  const text = cells.join(' | ');
  return { mode, status, title, note: sevCell && /^(critical|major|minor)$/i.test(sevCell) ? `severity: ${sevCell}. ${note}` : note, text };
}

/** First sentence-ish fragment is the title; the rest is the note. */
function titleAndNote(text: string): { title: string; note: string } {
  const firstLine = text.split('\n')[0] ?? '';
  const rest = text.split('\n').slice(1).join('\n').trim();
  let head = firstLine
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\*{0,2}\d+\.\s*\*{0,2}/, '')
    .replace(/^\s*\[(Critical|Major|Minor)\]\s*/i, '')
    .trim();

  // Split at the first em-dash / bullet separator that is followed by prose, keeping the
  // finding's own leading `F5 —` style index attached so the matcher can see it.
  const sep = /\s+[—–·]\s+|\.\s+(?=[A-Z`])/.exec(head.replace(/`[^`]*`/g, (s) => ' '.repeat(s.length)));
  let title = head;
  let note = rest;
  if (sep && sep.index > 8) {
    title = head.slice(0, sep.index).trim();
    const tailOfLine = head.slice(sep.index + sep[0].length).trim();
    note = [tailOfLine, rest].filter(Boolean).join(' ');
  }
  return { title: cleanTitle(title), note: note.trim() };
}

// ── status, severity, rules ────────────────────────────────────────────────────────────

function statusOf(item: Item): FindingStatus {
  if (item.status) return item.status;
  const head = item.title + ' ' + item.text.split('\n')[0];
  if (/\bunverified\b/i.test(head)) return 'unverified';
  if (/❌|✗|\bFAIL\b|\*\*fail\*\*|\bfail\b\s*[·|—]|→\s*\*{0,2}FAIL/i.test(head)) return 'fail';
  if (/✅|✔|\*\*pass\*\*|→\s*\*{0,2}pass/i.test(head)) return 'pass';
  if (/\bn-?\/?a\b/i.test(head)) return 'n-a';
  if (item.mode) return item.mode;
  return 'advisory';
}

const SEVERITY_PATTERNS: RegExp[] = [
  /(?:severity|sev)\s*:?\s*\*{0,2}(Critical|Major|Minor)/i,
  /[—–·|]\s*\*{0,2}(Critical|Major|Minor)\*{0,2}\s*(?:\(|$|\n|\.)/im,
  /\*\*(Critical|Major|Minor)\*\*/,
  /\[(Critical|Major|Minor)\]/i,
  /\b(?:FAIL|fail)\b\s*[·|—–]\s*(Critical|Major|Minor)/i,
  /\b(Critical|Major|Minor)\b/,
];

function severityOf(item: Item, fallback: Severity): Severity {
  const scope = `${item.title}\n${item.note.slice(0, 400)}`;
  for (const re of SEVERITY_PATTERNS) {
    const m = re.exec(scope);
    if (m) return SEVERITIES[m[1]!.toLowerCase()]!;
  }
  return fallback;
}

export interface CompiledRule {
  code: string;
  title: string;
  severity: Severity;
  match: RegExp[];
  exclude: RegExp[];
  family: RegExp[];
  supersedes: string[];
}

export function compileRules(rules: RuleDef[]): CompiledRule[] {
  return rules.map((r) => ({
    code: r.code,
    title: r.title,
    severity: r.severity ?? 'minor',
    match: (r.match ?? []).map((p) => new RegExp(p, 'i')),
    exclude: (r.exclude ?? []).map((p) => new RegExp(p, 'i')),
    family: (r.family ?? []).map((p) => new RegExp(p, 'i')),
    supersedes: r.supersedes ?? [],
  }));
}

/**
 * First rule whose `match` fires and whose `exclude` does not. Order in the YAML is the
 * precedence order, so the specific codes (AS2 "thumbnail duplicates icon") are listed
 * before the general ones (AS1 "thumbnail missing").
 */
export function matchRule(text: string, rules: CompiledRule[]): CompiledRule | null {
  for (const rule of rules) {
    if (!rule.match.some((re) => re.test(text))) continue;
    if (rule.exclude.some((re) => re.test(text))) continue;
    return rule;
  }
  return null;
}

/** Stable synthetic code for an item the vocabulary does not cover yet. */
export function syntheticCode(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  return `x:${slug || 'unnamed'}`;
}

export interface ExtractOptions {
  rules: CompiledRule[];
  /** Passing items that match no rule carry no cross-subject signal, so they are dropped. */
  keepUncodedPasses?: boolean;
}

const HAS_SEVERITY = /\b(Critical|Major|Minor)\b/;

/**
 * Whether an item that matched no rule is worth importing.
 *
 * The reports interleave findings with their *evidence* — "`GET /` → HTTP 200, full UI
 * rendered, no login" is a bullet under a finding, not a finding. Uncoded items therefore
 * have to earn their place: a fail must carry an explicit severity (every real finding in
 * this corpus does), and an advisory must come from a section headed as advisory.
 */
function uncodedIsFinding(item: Item, status: FindingStatus): boolean {
  if (item.title.length < 8) return false;
  if (status === 'pass' || status === 'n-a') return false;
  if (status === 'advisory') return item.mode === 'advisory';
  return HAS_SEVERITY.test(`${item.title} ${item.note.slice(0, 300)}`);
}

export function extractFindings(section: string, opts: ExtractOptions): Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  for (const item of chopItems(section)) {
    const status = statusOf(item);
    const rule = matchRule(`${item.title}\n${item.note}`, opts.rules);
    const keep =
      Boolean(rule) ||
      uncodedIsFinding(item, status) ||
      (status === 'pass' && Boolean(opts.keepUncodedPasses));
    if (!keep) continue;

    const code = rule ? rule.code : syntheticCode(item.title);
    const severity =
      status === 'pass' || status === 'n-a'
        ? 'none'
        : severityOf(item, rule?.severity ?? 'minor');

    const key = `${code}|${status}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      rule: code,
      title: rule ? rule.title : cleanTitle(item.title),
      severity,
      status,
      ...(item.note ? { note: squash(item.note, 400) } : {}),
    });
  }
  // A rule cannot both pass and fail in one report. Reports routinely record the halves of
  // a compound checklist item separately — "`cpu_shares` present on every service — pass
  // (presence) … tier is wrong, see F3" — and the failing half is the one that matters.
  const failed = new Set(out.filter((f) => f.status === 'fail').map((f) => f.rule));
  let kept = out.filter(
    (f) => !(failed.has(f.rule) && (f.status === 'pass' || f.status === 'n-a')),
  );

  // Where one checklist item was split into a general and a specific code, keep only the
  // specific one — a report saying both "cpu_shares set appropriately: fail" and
  // "cpu_shares: 10 is the reserved tier" has stated one defect, not two.
  const byCode = new Map(opts.rules.map((r) => [r.code, r]));
  const superseded = new Set<string>();
  for (const f of kept) {
    for (const code of byCode.get(f.rule)?.supersedes ?? []) superseded.add(`${code}|${f.status}`);
  }
  kept = kept.filter((f) => !superseded.has(`${f.rule}|${f.status}`));
  return kept;
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

export function cleanTitle(s: string): string {
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
