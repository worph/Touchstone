/**
 * The differ has one job an operator will notice immediately if it gets it wrong: an edit to
 * one paragraph of a 400-line rubric must read as an edit to one paragraph. Everything here
 * pins some version of that, plus the two normalisation rules (CRLF, trailing newline) that
 * would otherwise report a whole file as rewritten.
 */

import { describe, expect, it } from 'vitest';

import { lineDiff, splitLines, toUnified } from './linediff.js';

const A = ['one', 'two', 'three', 'four', 'five'].join('\n');

describe('splitting', () => {
  it('folds CRLF, so a file saved once on Windows is not a whole-file rewrite', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('drops exactly one trailing newline, and keeps a blank line that means it', () => {
    expect(splitLines('a\n')).toEqual(['a']);
    expect(splitLines('a\n\n')).toEqual(['a', '']);
    expect(splitLines('')).toEqual([]);
  });
});

describe('diffing', () => {
  it('reports no hunks for identical text', () => {
    const d = lineDiff(A, A);
    expect(d.hunks).toEqual([]);
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it('sees a one-line change as one line, not as five', () => {
    const d = lineDiff(A, A.replace('three', 'THREE'));
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.hunks).toHaveLength(1);
    expect(toUnified(d)).toBe(
      ['@@ -1,5 +1,5 @@', ' one', ' two', '-three', '+THREE', ' four', ' five'].join('\n'),
    );
  });

  it('puts the removal before the addition, so a replaced line reads as one swap', () => {
    const ops = lineDiff(A, A.replace('three', 'THREE')).hunks[0]!.lines.map((l) => l.op);
    expect(ops).toEqual(['context', 'context', 'remove', 'add', 'context', 'context']);
  });

  it('numbers lines against the whole file, both sides', () => {
    const changed = lineDiff(A, A.replace('three', 'THREE'))
      .hunks[0]!.lines.filter((l) => l.op !== 'context');
    expect(changed.map((l) => [l.op, l.old, l.new])).toEqual([
      ['remove', 3, null],
      ['add', null, 3],
    ]);
  });

  it('handles an empty side without inventing context', () => {
    expect(lineDiff('', A).added).toBe(5);
    expect(lineDiff(A, '').removed).toBe(5);
  });

  /**
   * The reason hunks exist at all: two edits far apart must not drag four hundred untouched
   * lines of a rubric into the view between them.
   */
  it('splits distant edits into separate hunks and keeps near ones together', () => {
    const long = Array.from({ length: 60 }, (_, i) => `line ${i}`);
    const edited = [...long];
    edited[2] = 'CHANGED';
    edited[50] = 'ALSO CHANGED';
    const far = lineDiff(long.join('\n'), edited.join('\n'));
    expect(far.hunks).toHaveLength(2);

    const near = [...long];
    near[2] = 'CHANGED';
    near[5] = 'ALSO CHANGED';
    expect(lineDiff(long.join('\n'), near.join('\n')).hunks).toHaveLength(1);
  });

  it('shows three lines of context by default and honours a wider ask', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const edited = [...long];
    edited[20] = 'CHANGED';
    // A replaced line is two entries, `-old` then `+new`: 3 + 2 + 3.
    expect(lineDiff(long.join('\n'), edited.join('\n')).hunks[0]!.lines).toHaveLength(8);
    expect(
      lineDiff(long.join('\n'), edited.join('\n'), { context: 1 }).hunks[0]!.lines,
    ).toHaveLength(4);
  });

  it('finds an insertion rather than rewriting the tail', () => {
    const d = lineDiff(A, ['one', 'two', 'inserted', 'three', 'four', 'five'].join('\n'));
    expect(d.added).toBe(1);
    expect(d.removed).toBe(0);
  });

  it('is not coarse for anything the size of a real protocol', () => {
    const big = Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n');
    expect(lineDiff(big, big.replace('line 500', 'edited')).coarse).toBe(false);
  });
});
