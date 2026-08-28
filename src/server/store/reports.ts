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

import { DEFAULT_ORIGIN, subjectKey } from '../../shared/subject.js';
import type { AssayMeta, AssayRecord, Section } from '../../shared/types.js';

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
  for (const key of ['subject', 'status'] as const) {
    if (typeof data[key] !== 'string') {
      throw new ReportFormatError(`${where}: frontmatter is missing required key \`${key}\``);
    }
  }
  // `section` is the key; `leg` is what every file written before 2026-08-20 calls it. Filling
  // it here is what lets the whole archive be read as sections without rewriting a single
  // report — nothing downstream ever has to ask which spelling a file used.
  if (typeof data.section !== 'string' || data.section === '') {
    if (typeof data.leg !== 'string' || data.leg === '') {
      throw new ReportFormatError(`${where}: frontmatter is missing required key \`section\``);
    }
    data.section = data.leg;
  }
  // `origin` is the same move, one rename later: every assay written before stores were a
  // configured value belongs to the one store there was. Defaulting it *here* rather than
  // deriving it from the directory is what makes the archive layout a namespace rather than an
  // identity — a file that has not been moved into `reports/<origin>/` yet still reads
  // correctly, which is what lets the boot migration be cosmetic instead of load-bearing.
  if (typeof data.origin !== 'string' || data.origin === '') data.origin = DEFAULT_ORIGIN;
  // Everything else is passed through as-is. Unknown keys ride along untouched; this is a
  // widening cast, not a validation pass — the archive may legitimately be ahead of us.
  return data as unknown as AssayMeta;
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

/**
 * Read a report file whole: frontmatter, verbatim body, and the raw bytes.
 *
 * `reportsRoot` is **required**. It used to be optional, with a fallback that rebuilt the
 * relative path out of `basename(dirname(file))` — one directory level, which was true when a
 * report lived at `<Subject>/<file>` and became a quiet lie the moment it lived at
 * `<origin>/<Subject>/<file>`: the origin would be dropped and `path` would name a file that is
 * not there. Every caller already passed a root, so requiring it trades a latent runtime bug for
 * a compile error.
 */
export async function readReport(file: string, reportsRoot: string): Promise<ReportFile> {
  const raw = await fs.readFile(file, 'utf8');
  const { body } = split(raw);
  const meta = parseReportMeta(raw, file);
  const rel = path.relative(reportsRoot, file);
  return {
    ...recordFor(meta, rel.split(path.sep).join('/')),
    body,
    raw,
  };
}

/**
 * Build the index record for one report — the single definition of that shape.
 *
 * Two places used to construct it independently: `buildIndex`'s scan and the runner's `upsert`
 * after a write. Two copies of "how a record is derived from a file" is one copy too many when
 * the derivation grows a key, so both call this.
 */
export function recordFor(meta: AssayMeta, rel: string): AssayRecord {
  const origin = typeof meta.origin === 'string' && meta.origin ? meta.origin : DEFAULT_ORIGIN;
  return {
    meta,
    path: rel,
    subject: subjectKey(origin, meta.subject),
    origin,
    name: meta.subject,
    file: rel.split('/').pop() ?? rel,
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

/**
 * `<origin>/<Subject>/<ISO with ':' replaced by '-'>-<section>.md`
 *
 * The single place the archive layout is decided. The origin level is a **namespace, not a
 * uniqueness rule**: two stores may both ship a `FileBrowser`, and they are two subjects with
 * two directories rather than one row that silently merges both stores' verdicts.
 */
export function reportRelPath(
  origin: string,
  subject: string,
  startedAt: string,
  section: Section,
): string {
  return `${origin}/${subject}/${timestampSlug(startedAt)}-${section}.md`;
}

export function reportRelPathFor(meta: AssayMeta): string {
  const origin = typeof meta.origin === 'string' && meta.origin ? meta.origin : DEFAULT_ORIGIN;
  return reportRelPath(origin, meta.subject, meta.started_at, meta.section);
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
  'origin',
  'section',
  'standard',
  'standard_sha256',
  // Legacy, still in every file written before 2026-08-23. Kept immediately behind its
  // replacement so an old file rewritten today keeps a key order a diff can follow.
  'standard_version',
  // Beside the standard's hash: both say what the run was reading, and a reader who sees one
  // has to see the other to know which document a conclusion came from.
  'kb_sha256',
  'status',
  'verdict',
  'top_severity',
  'risk_score',
  // Kept adjacent to `risk_score`: all three are about the same number's scope and
  // provenance, and a reader who sees one has to see the others to read it correctly.
  'risk_score_computed',
  'combined_score_of',
  'combined_score_on',
  'blocked_reason',
  'subject_ref',
  'commit',
  'images',
  'executor',
  'executor_sha256',
  'scores',
  'badge',
  'badge_state',
  'summary',
  'started_at',
  'finished_at',
  'bench_host',
  'bench_build',
];

/** Contract keys first, in contract order; unknown keys keep their relative order after. */
function orderMeta(meta: AssayMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of META_ORDER) if (key in meta) out[key] = meta[key];
  for (const key of Object.keys(meta)) {
    if (key in out) continue;
    out[key] = meta[key];
  }
  return out;
}
