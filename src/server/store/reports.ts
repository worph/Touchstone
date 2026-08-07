/**
 * Report files: read and write markdown with YAML frontmatter.
 *
 * The folder is the archive of record (IMPLEMENTATION.md §5), so the one property that
 * matters here is losslessness: whatever a producer put in the frontmatter comes back out,
 * including keys this codebase has never heard of, and the body is returned byte-identical.
 *
 * Reading is deliberately split in two:
 *   - `readReportMeta` parses the frontmatter block only. The indexer uses this and never
 *     touches the body.
 *   - `readReport` additionally returns the body, verbatim, for the viewer.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

import type { AssayMeta, AssayRecord, Finding, Leg } from '../../shared/types.js';

export interface ReportFile extends AssayRecord {
  /** Everything after the closing `---` line, byte-identical to what was written. */
  body: string;
  /** The whole file as it sits on disk. */
  raw: string;
}

/**
 * Matches the leading frontmatter block. Group 0 ends immediately after the newline that
 * terminates the closing `---`, so `raw.slice(m[0].length)` is the body with nothing
 * trimmed or normalised — which is what makes the round-trip byte-exact.
 */
const FRONTMATTER = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

export class ReportFormatError extends Error {}

/** Split a raw file into its frontmatter block and its untouched body. */
function split(raw: string): { block: string; body: string } {
  const m = FRONTMATTER.exec(raw);
  if (!m) throw new ReportFormatError('no YAML frontmatter block');
  return { block: m[0], body: raw.slice(m[0].length) };
}

function coerceMeta(data: Record<string, unknown>, where: string): AssayMeta {
  for (const key of ['subject', 'leg', 'status'] as const) {
    if (typeof data[key] !== 'string') {
      throw new ReportFormatError(`${where}: frontmatter is missing required key \`${key}\``);
    }
  }
  // Everything else is passed through as-is. Unknown keys ride along untouched; this is a
  // widening cast, not a validation pass — the archive may legitimately be ahead of us.
  const meta = data as unknown as AssayMeta;
  if (!Array.isArray(meta.findings)) meta.findings = [];
  return meta;
}

/** Parse only the frontmatter of a report file. Never reads the body. */
export async function readReportMeta(file: string): Promise<AssayMeta> {
  const raw = await fs.readFile(file, 'utf8');
  return parseReportMeta(raw, file);
}

export function parseReportMeta(raw: string, where = '<string>'): AssayMeta {
  split(raw); // fail fast and with a useful message if the block is malformed
  const parsed = matter(raw);
  return coerceMeta(parsed.data as Record<string, unknown>, where);
}

/** Read a report file whole: frontmatter, verbatim body, and the raw bytes. */
export async function readReport(file: string, reportsRoot?: string): Promise<ReportFile> {
  const raw = await fs.readFile(file, 'utf8');
  const { body } = split(raw);
  const meta = parseReportMeta(raw, file);
  const rel = reportsRoot ? path.relative(reportsRoot, file) : path.join(path.basename(path.dirname(file)), path.basename(file));
  return {
    meta,
    path: rel.split(path.sep).join('/'),
    subject: meta.subject,
    file: path.basename(file),
    body,
    raw,
  };
}

/**
 * Serialise meta + body without writing anything. Exposed so tests (and the importer's
 * dry-run) can assert on the exact bytes that would land on disk.
 */
export function renderReport(meta: AssayMeta, body: string): string {
  // gray-matter's stringify re-emits the delimiters and dumps the data with js-yaml,
  // preserving insertion order of the keys. It inserts exactly one newline after the
  // closing `---`, which `split()` above then removes again — hence the round-trip.
  return matter.stringify(body, orderMeta(meta));
}

/** ISO-8601 with `:` → `-`, so filenames sort lexically and survive every filesystem. */
export function timestampSlug(iso: string): string {
  return iso.replace(/:/g, '-');
}

/** `<Subject>/<ISO with ':' replaced by '-'>-<leg>.md` */
export function reportRelPath(subject: string, startedAt: string, leg: Leg): string {
  return `${subject}/${timestampSlug(startedAt)}-${leg}.md`;
}

export function reportRelPathFor(meta: AssayMeta): string {
  return reportRelPath(meta.subject, meta.started_at, meta.leg);
}

/**
 * Write a report under `dir` (the reports root). Returns the absolute path written.
 *
 * Files are never modified after creation in normal operation (IMPLEMENTATION.md §5), but
 * the importer is explicitly re-runnable, so an identical rewrite is allowed and a
 * differing one is reported to the caller rather than silently applied.
 */
export async function writeReport(
  dir: string,
  meta: AssayMeta,
  body: string,
  opts: { overwrite?: boolean } = {},
): Promise<{ path: string; rel: string; written: boolean }> {
  const rel = reportRelPathFor(meta);
  const abs = path.join(dir, rel);
  const next = renderReport(meta, body);

  let existing: string | null = null;
  try {
    existing = await fs.readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }

  if (existing !== null && existing === next) return { path: abs, rel, written: false };
  if (existing !== null && opts.overwrite === false) return { path: abs, rel, written: false };

  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Temp-file + rename: a crash mid-write can never leave a truncated report behind.
  const tmp = `${abs}.tmp-${process.pid}`;
  await fs.writeFile(tmp, next, 'utf8');
  await fs.rename(tmp, abs);
  return { path: abs, rel, written: true };
}

const META_ORDER = [
  'subject',
  'leg',
  'standard',
  'standard_version',
  'status',
  'verdict',
  'top_severity',
  'risk_score',
  'blocked_reason',
  'subject_ref',
  'commit',
  'images',
  'started_at',
  'finished_at',
];

/** Contract keys first, in contract order; unknown keys keep their relative order after. */
function orderMeta(meta: AssayMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of META_ORDER) if (key in meta) out[key] = meta[key];
  for (const key of Object.keys(meta)) {
    if (key === 'findings' || key in out) continue;
    out[key] = meta[key];
  }
  // `findings` last: it is the only long value, and a human scanning the head of a file
  // wants the scalars.
  out.findings = meta.findings ?? [];
  return out;
}

/** risk = 100·Critical + 10·Major + 1·Minor, summed over *failing* findings only. */
export function riskScore(findings: Finding[]): number {
  let risk = 0;
  for (const f of findings) {
    if (f.status !== 'fail') continue;
    risk += f.severity === 'critical' ? 100 : f.severity === 'major' ? 10 : f.severity === 'minor' ? 1 : 0;
  }
  return risk;
}
