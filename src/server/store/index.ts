/**
 * The in-memory index over `reports/**`.
 *
 * Built at boot by scanning the tree and parsing frontmatter *only* — the body is never
 * read here, and never will be: bodies are read lazily, per request, by the viewer.
 *
 * `state/index.json` is a cache keyed on (size, mtime) per file. The defining property of a
 * cache rather than a database is that deleting it is always safe, so nothing in this module
 * treats a missing, stale, truncated or garbage cache as an error: any doubt about an entry
 * and the file is re-parsed. A cache hit is only ever an optimisation.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AssayMeta, AssayRecord, Section } from '../../shared/types.js';
import { readReport, readReportMeta, ReportFormatError } from './reports.js';

/**
 * Bumped to 2 on 2026-08-20, when `leg` became `section`.
 *
 * The cache stores whole parsed records, so entries written by the previous build carry `leg`
 * and no `section` — and every lookup is by section now. A version bump discards them, which
 * is exactly what a cache is for: the files on disk are unchanged and are simply re-read.
 */
export const CACHE_VERSION = 2;

export interface BuildIndexOptions {
  /** Defaults to `<reportsRoot>/../state/index.json`. `null` disables the cache entirely. */
  cacheFile?: string | null;
  /** Called once per file that failed to parse, instead of throwing. */
  onError?: (file: string, err: unknown) => void;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  record: AssayRecord;
}

interface CacheFile {
  version: number;
  entries: Record<string, CacheEntry>;
}

export class ReportIndex {
  readonly reportsRoot: string;
  private readonly byPath = new Map<string, AssayRecord>();
  /** Files that could not be parsed, kept so a degraded UI can say so rather than lie. */
  readonly broken: { path: string; error: string }[] = [];

  constructor(reportsRoot: string, records: AssayRecord[] = []) {
    this.reportsRoot = reportsRoot;
    for (const r of records) this.byPath.set(r.path, r);
  }

  get size(): number {
    return this.byPath.size;
  }

  /** Every assay in the archive, newest first. */
  all(): AssayRecord[] {
    return [...this.byPath.values()].sort(byNewestFirst);
  }

  get(relPath: string): AssayRecord | undefined {
    return this.byPath.get(relPath);
  }

  /** Every subject that has at least one report on disk, alphabetically. */
  subjects(): string[] {
    return [...new Set([...this.byPath.values()].map((r) => r.subject))].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  /** All assays for one subject, newest first, every section interleaved. */
  forSubject(subject: string): AssayRecord[] {
    return [...this.byPath.values()].filter((r) => r.subject === subject).sort(byNewestFirst);
  }

  /**
   * Every section id present in the archive, in a stable order.
   *
   * Derived, never declared: the index cannot know which protocol files exist, and a section
   * that has been retired still has reports that must keep rendering. Callers that also want
   * sections with no assay yet union this with `sectionsOf(protocols)`.
   */
  sections(): Section[] {
    return [...new Set([...this.byPath.values()].map((r) => r.meta.section))].sort((a, b) =>
      a.localeCompare(b),
    );
  }

  /**
   * The latest `done` assay for a (subject, section) pair — the hallmark input.
   *
   * `blocked` and `running` assays are deliberately excluded: a blocked run is a statement
   * about the bench, never about the subject, so it must not displace the last real result.
   * Use `latestAny` when you want the current *state* including a block.
   */
  latest(subject: string, section: Section): AssayRecord | null {
    return (
      this.forSubject(subject).find((r) => r.meta.section === section && r.meta.status === 'done') ??
      null
    );
  }

  /** The most recent assay for a (subject, section) pair whatever its status. */
  latestAny(subject: string, section: Section): AssayRecord | null {
    return this.forSubject(subject).find((r) => r.meta.section === section) ?? null;
  }

  /**
   * One record per (subject, section) — the working set every cross-subject query runs over.
   * `status` defaults to `done`, which is what the Overview table wants.
   */
  latestPerSubjectSection(opts: { status?: 'done' | 'any' } = {}): AssayRecord[] {
    const pick = opts.status === 'any' ? this.latestAny.bind(this) : this.latest.bind(this);
    const sections = this.sections();
    const out: AssayRecord[] = [];
    for (const subject of this.subjects()) {
      for (const section of sections) {
        const rec = pick(subject, section);
        if (rec) out.push(rec);
      }
    }
    return out;
  }

  /**
   * The body of one report, addressed by `AssayRecord.path`. `null` when the file is gone.
   *
   * This is the only place a body is ever read, and it happens per request rather than at
   * boot — which is what keeps the index cheap and lets a file edited on disk show up on
   * reload. It also makes `ReportIndex` satisfy the domain's `AssayStore` interface as-is.
   */
  async read(relPath: string): Promise<{ meta: AssayMeta; body: string; raw: string } | null> {
    // Refuse to escape the reports root, however the caller mangled the path.
    const abs = path.resolve(this.reportsRoot, relPath);
    if (abs !== this.reportsRoot && !abs.startsWith(this.reportsRoot + path.sep)) return null;
    try {
      const file = await readReport(abs, this.reportsRoot);
      return { meta: file.meta, body: file.body, raw: file.raw };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /** Update in place after a write. */
  upsert(record: AssayRecord): void {
    this.byPath.set(record.path, record);
  }

  remove(relPath: string): void {
    this.byPath.delete(relPath);
  }

  /** Stable, comparable snapshot — two indexes are equal iff these are equal. */
  toJSON(): AssayRecord[] {
    return [...this.byPath.keys()].sort().map((k) => this.byPath.get(k)!);
  }
}

function byNewestFirst(a: AssayRecord, b: AssayRecord): number {
  const at = String(a.meta.started_at ?? '');
  const bt = String(b.meta.started_at ?? '');
  if (at !== bt) return bt.localeCompare(at);
  return a.path.localeCompare(b.path);
}

export function defaultCacheFile(reportsRoot: string): string {
  return path.join(path.dirname(reportsRoot), 'state', 'index.json');
}

/** Scan `reportsRoot` for `*.md`, one directory level per subject, returned sorted. */
async function scan(reportsRoot: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile() && e.name.endsWith('.md')) out.push(abs);
    }
  };
  await walk(reportsRoot);
  return out.sort();
}

async function loadCache(file: string): Promise<Map<string, CacheEntry>> {
  // Every failure mode here — missing, truncated, wrong version, hand-mangled — is a miss,
  // not an error. That is what makes `rm state/index.json` always safe.
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as CacheFile;
    if (!parsed || parsed.version !== CACHE_VERSION || typeof parsed.entries !== 'object') {
      return new Map();
    }
    return new Map(Object.entries(parsed.entries));
  } catch {
    return new Map();
  }
}

async function saveCache(file: string, entries: Map<string, CacheEntry>): Promise<void> {
  const payload: CacheFile = { version: CACHE_VERSION, entries: Object.fromEntries([...entries.entries()].sort()) };
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, file);
  } catch {
    // A cache we cannot write is a cache we do without.
  }
}

/**
 * Scan `reportsRoot`, parse frontmatter only, return the index.
 *
 * With the cache present this re-parses only files whose size or mtime changed. With the
 * cache absent it parses everything and produces an identical index — that equivalence is
 * asserted by a test, because it is the whole justification for having no database.
 */
export async function buildIndex(
  reportsRoot: string,
  opts: BuildIndexOptions = {},
): Promise<ReportIndex> {
  const cacheFile =
    opts.cacheFile === null ? null : (opts.cacheFile ?? defaultCacheFile(reportsRoot));
  const cache = cacheFile ? await loadCache(cacheFile) : new Map<string, CacheEntry>();
  const next = new Map<string, CacheEntry>();

  const index = new ReportIndex(reportsRoot);
  const files = await scan(reportsRoot);

  for (const abs of files) {
    const rel = path.relative(reportsRoot, abs).split(path.sep).join('/');
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      continue;
    }
    const hit = cache.get(rel);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs && hit.record) {
      index.upsert(hit.record);
      next.set(rel, hit);
      continue;
    }
    try {
      const meta = await readReportMeta(abs);
      const record: AssayRecord = {
        meta,
        path: rel,
        subject: meta.subject,
        file: path.basename(rel),
      };
      index.upsert(record);
      next.set(rel, { size: stat.size, mtimeMs: stat.mtimeMs, record });
    } catch (err) {
      const message = err instanceof ReportFormatError ? err.message : String(err);
      index.broken.push({ path: rel, error: message });
      if (opts.onError) opts.onError(abs, err);
    }
  }

  if (cacheFile) await saveCache(cacheFile, next);
  return index;
}
