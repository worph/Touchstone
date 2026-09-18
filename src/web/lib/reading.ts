/**
 * Readings — what a section that *measures* produces, as the pages need it.
 *
 * A reading is an assay like any other; what makes it one is `scores: false` in its
 * frontmatter, written by whichever executor produced it. Everything here is deliberately
 * blind to what is being measured: a badge is a dozen characters, a row is a bag of values,
 * and a column is a key with a label. The Overview draws a column per reading section it
 * finds in the archive, so a second scripted check — a licence sweep, an asset probe — needs
 * no change on this side of the wire.
 *
 * The one thing that is not blind is `kind: 'since'`, and it is a formatting hint rather than
 * knowledge: a cell that holds a date is drawn as an age, so *"400 days behind"* stays true
 * between assays instead of freezing at whatever it was when the check last ran.
 */
import type { AssayRecord, SubjectState } from '@shared/types';

export type ReadingState = 'ok' | 'warn' | 'bad' | 'unknown';

export interface Reading {
  section: string;
  record: AssayRecord;
  /** The cell text, exactly as the executor wrote it. */
  badge: string;
  state: ReadingState;
  summary?: string;
  /** The check ran and could not find out. Never rendered as `ok`. */
  blocked: boolean;
}

/**
 * True when this record **measures** rather than judges.
 *
 * `scores: false` used to be the whole test, and it was right while it had one meaning. It now
 * has two:
 *
 * 1. *this section measures rather than judges* — `currency`, a script that reports image ages
 *    and draws a badge and a table;
 * 2. *this platform is being measured before it is allowed to judge* — a target shipped
 *    non-scoring so that its first sweep cannot publish verdicts in app authors' names.
 *
 * Only the first is a reading. A non-scoring **agent** section still produces a verdict, a
 * severity and findings; classified as a reading it would be drawn by `ReadingBadge`, which
 * reads `meta.badge` — absent on an agent section, so the column would be a blank cell where a
 * verdict belongs.
 *
 * What separates them is that a reading *produces a badge*, which in practice means a scripted
 * executor. `executor` is the durable half of that pair: a reading whose run was blocked has no
 * badge yet still belongs in its own column, which is why this does not simply test `badge`.
 */
export function isReading(record: AssayRecord | null | undefined): boolean {
  if (record?.meta.scores !== false) return false;
  return record.meta.executor !== undefined || record.meta.badge !== undefined;
}

/**
 * Which sections in this set of rows carry a **verdict**, in a stable order.
 *
 * The mirror of `readingSections`, and derived from the archive for the same reason: a section
 * gets a column the moment one of its assays exists, and nothing here has to be told its name.
 * That is what lets a rubric audited on a second platform appear as its own column with no edit
 * to any page — and, equally, what keeps it *absent* until something has actually been audited
 * there, rather than showing an empty column for a platform nothing has run on yet.
 *
 * `static` and `functional` are seeded so the two columns the table has always drawn survive an
 * empty archive; `domain/hallmark.ts` seeds the same pair into every row for the same reason.
 */
export function verdictSectionsOf(rows: readonly SubjectState[]): string[] {
  const ids = new Set<string>(['static', 'functional']);
  for (const row of rows) {
    for (const [id, rec] of Object.entries(row.sections ?? {})) {
      if (rec && !isReading(rec)) ids.add(id);
    }
  }
  // Protocol order is not on the wire, so: the two named columns first, then the rest by id —
  // which puts `functional@foss` directly after `functional`, where a reader expects it.
  return [...ids].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Which verdict sections are **provisional** — the platform is being measured before it is
 * allowed to judge.
 *
 * A non-scoring *agent* section still reaches a verdict; what it does not do is move the
 * hallmark or enter a backlog. That is a fact about the column, not about any row, so the
 * header says it once rather than each of seventy-nine cells repeating it.
 */
export function provisionalSections(rows: readonly SubjectState[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const [id, rec] of Object.entries(row.sections ?? {})) {
      if (rec && !isReading(rec) && rec.meta.scores === false) ids.add(id);
    }
  }
  return ids;
}

function rank(id: string): number {
  return id === 'static' ? 0 : id === 'functional' ? 1 : 2;
}

/** Which sections in this set of rows are readings, in a stable order. */
export function readingSections(rows: readonly SubjectState[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    for (const [id, rec] of Object.entries(row.sections ?? {})) {
      if (isReading(rec)) ids.add(id);
    }
  }
  return [...ids].sort();
}

export function readingOf(s: SubjectState, section: string): Reading | null {
  const record = s.sections?.[section];
  if (!record || !isReading(record)) return null;
  const blocked = record.meta.status === 'blocked';
  const badge = typeof record.meta.badge === 'string' ? record.meta.badge : blocked ? 'unknown' : '—';
  const declared = record.meta.badge_state;
  const state: ReadingState =
    blocked
      ? 'unknown'
      : declared === 'ok' || declared === 'warn' || declared === 'bad' || declared === 'unknown'
        ? declared
        : 'unknown';
  return {
    section,
    record,
    badge,
    state,
    ...(typeof record.meta.summary === 'string' ? { summary: record.meta.summary } : {}),
    blocked,
  };
}

/**
 * Sort order for a reading column: worst first when descending.
 *
 * `unknown` sits between `ok` and `warn` deliberately. It is not good news — we could not
 * find out — but it must not outrank a measurement that actually found something wrong.
 */
const STATE_RANK: Record<ReadingState, number> = { ok: 0, unknown: 1, warn: 2, bad: 3 };

export function readingRank(s: SubjectState, section: string): number {
  const reading = readingOf(s, section);
  if (!reading) return -1;
  return STATE_RANK[reading.state];
}

/** Whole days between an ISO date and now. Negative clamps to 0; unparseable is null. */
export function daysSince(iso: unknown, now: number = Date.now()): number | null {
  if (typeof iso !== 'string' || iso === '') return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

export interface ReadingColumn {
  key: string;
  label: string;
  align?: 'left' | 'right';
  /** The value is an ISO date and should be drawn as an age. */
  kind?: 'since';
}

export type ReadingRow = Record<string, string | number | boolean | null>;

/** The columns a reading asked for, or the union of its rows' keys when it asked for none. */
export function readingColumns(record: AssayRecord): ReadingColumn[] {
  const declared = record.meta.columns;
  if (Array.isArray(declared) && declared.length > 0) {
    return declared.map((c) => ({
      key: String(c.key),
      label: String(c.label ?? c.key),
      ...(c.align === 'right' ? { align: 'right' as const } : {}),
      ...((c as { kind?: string }).kind === 'since' ? { kind: 'since' as const } : {}),
    }));
  }
  const rows = readingRows(record);
  return [...new Set(rows.flatMap((r) => Object.keys(r)))].map((key) => ({ key, label: key }));
}

export function readingRows(record: AssayRecord): ReadingRow[] {
  const rows = record.meta.rows;
  return Array.isArray(rows) ? (rows as ReadingRow[]) : [];
}
