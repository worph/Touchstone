/**
 * A line diff, in the shape a unified diff has.
 *
 * Written here rather than pulled from npm for one reason worth stating: the only thing this
 * app ever diffs is two revisions of a protocol file — a few hundred lines of markdown, or a
 * shell script of the same order. That is an afternoon of LCS, and a dependency is a thing
 * somebody has to keep current on an image that must build for `amd64` **and** `arm64`.
 *
 * It lives in `src/shared/` because both halves want it: the server computes the hunks for
 * `GET /protocols/:id/revisions/:sha/diff`, and the page renders them. Nothing here touches
 * the filesystem, so it is a pure unit test away from being correct.
 */

/** What happened to one line. `context` is a line both sides agree on. */
export type DiffOp = 'context' | 'add' | 'remove';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the OLD text; null on an added line. */
  old: number | null;
  /** 1-based line number in the NEW text; null on a removed line. */
  new: number | null;
}

/** One run of changes plus its surrounding context, addressed like a `@@` header. */
export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export interface Diff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  /**
   * True when the two texts were too large to align line by line and the changed middle is
   * reported as one wholesale replacement instead.
   *
   * Not an error and not a truncation — every line is still present. It is here so the page
   * can say "too large to align" rather than implying that a 4 000-line rewrite touched
   * nothing in common.
   */
  coarse: boolean;
}

/** Lines of context either side of a change. Three is what `diff -u` shows. */
const CONTEXT = 3;

/**
 * The point past which the O(n·m) table stops being free.
 *
 * Four million cells is a 2 000×2 000-line diff, an order of magnitude above the largest
 * protocol in the tree. Past it we say so rather than spending a second of the event loop.
 */
const MAX_CELLS = 4_000_000;

/**
 * Split for diffing: CRLF folded, and a single trailing newline dropped.
 *
 * Without the fold, a file saved once on Windows reads as every line changed. Without the
 * drop, a text ending in `\n` carries a phantom empty last line that shows up as an edit the
 * moment the other side lacks it.
 */
export function splitLines(text: string): string[] {
  const flat = text.replace(/\r\n/g, '\n');
  if (flat === '') return [];
  return (flat.endsWith('\n') ? flat.slice(0, -1) : flat).split('\n');
}

export function lineDiff(before: string, after: string, opts: { context?: number } = {}): Diff {
  const context = Math.max(0, opts.context ?? CONTEXT);
  const a = splitLines(before);
  const b = splitLines(after);
  const { lines, coarse } = align(a, b);

  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === 'add') added += 1;
    else if (l.op === 'remove') removed += 1;
  }

  return { hunks: hunksOf(lines, context), added, removed, coarse };
}

/**
 * Every line of both texts, in order, tagged.
 *
 * Common prefix and suffix are peeled off first. That is not only a speed-up: an edit to one
 * paragraph of a 400-line rubric leaves a handful of lines to align, which keeps the table
 * small enough that the coarse path is reached only by a genuine rewrite.
 */
function align(a: string[], b: string[]): { lines: DiffLine[]; coarse: boolean } {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;

  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail += 1;
  }

  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const lines: DiffLine[] = [];

  for (let i = 0; i < head; i += 1) {
    lines.push({ op: 'context', text: a[i]!, old: i + 1, new: i + 1 });
  }

  const coarse = (midA.length + 1) * (midB.length + 1) > MAX_CELLS;
  if (coarse) {
    // Everything in the middle is reported as removed then added. Honest, and the only
    // answer that does not depend on a table we have declined to build.
    midA.forEach((text, i) => lines.push({ op: 'remove', text, old: head + i + 1, new: null }));
    midB.forEach((text, i) => lines.push({ op: 'add', text, old: null, new: head + i + 1 }));
  } else {
    lines.push(...lcsWalk(midA, midB, head));
  }

  for (let i = 0; i < tail; i += 1) {
    lines.push({
      op: 'context',
      text: a[a.length - tail + i]!,
      old: a.length - tail + i + 1,
      new: b.length - tail + i + 1,
    });
  }

  return { lines, coarse };
}

/**
 * Longest common subsequence over lines, walked into a tagged sequence.
 *
 * `offset` is how many identical lines were peeled off the front, so the line numbers this
 * emits are numbers in the whole file rather than in the slice.
 */
function lcsWalk(a: string[], b: string[], offset: number): DiffLine[] {
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * w + j] =
        a[i] === b[j]
          ? dp[(i + 1) * w + (j + 1)]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + (j + 1)]!);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'context', text: a[i]!, old: offset + i + 1, new: offset + j + 1 });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j]! >= dp[i * w + (j + 1)]!) {
      // Removals before additions on a tie, so a replaced line reads `-old` then `+new`.
      out.push({ op: 'remove', text: a[i]!, old: offset + i + 1, new: null });
      i += 1;
    } else {
      out.push({ op: 'add', text: b[j]!, old: null, new: offset + j + 1 });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ op: 'remove', text: a[i]!, old: offset + i + 1, new: null });
    i += 1;
  }
  while (j < b.length) {
    out.push({ op: 'add', text: b[j]!, old: null, new: offset + j + 1 });
    j += 1;
  }
  return out;
}

/** Group the tagged lines into hunks, dropping context runs longer than `2 * context`. */
function hunksOf(lines: DiffLine[], context: number): DiffHunk[] {
  const changed = lines
    .map((l, i) => (l.op === 'context' ? -1 : i))
    .filter((i) => i >= 0);
  if (changed.length === 0) return [];

  const ranges: { from: number; to: number }[] = [];
  for (const i of changed) {
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    const last = ranges[ranges.length - 1];
    // `<= last.to + 1` merges two runs whose context windows touch: a one-line island of
    // context between two edits belongs in the same hunk, not in a hunk of its own.
    if (last && from <= last.to + 1) last.to = Math.max(last.to, to);
    else ranges.push({ from, to });
  }

  return ranges.map((r) => {
    const slice = lines.slice(r.from, r.to + 1);
    const olds = slice.filter((l) => l.old !== null);
    const news = slice.filter((l) => l.new !== null);
    return {
      old_start: olds[0]?.old ?? 0,
      old_lines: olds.length,
      new_start: news[0]?.new ?? 0,
      new_lines: news.length,
      lines: slice,
    };
  });
}

/** Render a diff the way `diff -u` would, for a log line or a copy-paste. */
export function toUnified(diff: Diff): string {
  const out: string[] = [];
  for (const h of diff.hunks) {
    out.push(`@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`);
    for (const l of h.lines) {
      out.push((l.op === 'add' ? '+' : l.op === 'remove' ? '-' : ' ') + l.text);
    }
  }
  return out.join('\n');
}
