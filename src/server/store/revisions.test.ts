/**
 * The history has to be right about two things above all: it must not record an edit that did
 * not happen, and it must not miss one that did — including one made on the volume with an
 * editor, which is the case the old `version:` integer could never see.
 *
 * The rest of these pin the degraded paths. A box whose data directory has gone read-only
 * still has to run audits (invariant 7), so every failure here is a warning and an empty
 * array, never a throw.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { shortSha } from '../../shared/standard.js';
import { HISTORY_DIR, RevisionStore } from './revisions.js';

let dir: string;
let store: RevisionStore;
let warnings: string[];

const STATIC = `---
id: static
name: Static Review Protocol
kind: leaf
---

# Static Review Protocol

Evaluate every statically verifiable item.
`;

const CURRENCY = '#!/bin/sh\necho \'{"requirements":[]}\'\n';

/** A clock that advances a second per call, so `at` is ordered and comparable. */
function ticker(): () => Date {
  let t = Date.parse('2026-08-23T09:00:00Z');
  return () => {
    t += 1000;
    return new Date(t);
  };
}

const logPath = () => path.join(dir, HISTORY_DIR, 'log.jsonl');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-revisions-'));
  await fs.writeFile(path.join(dir, 'static.md'), STATIC, 'utf8');
  await fs.writeFile(path.join(dir, 'currency.sh'), CURRENCY, 'utf8');
  warnings = [];
  store = new RevisionStore(dir, { now: ticker(), onWarn: (m) => warnings.push(m) });
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the first sweep', () => {
  it('records what is already there as seeded, rubric and script alike', async () => {
    const written = await store.sweep();
    expect(written.map((r) => [r.file, r.source, r.parent])).toEqual([
      ['currency.sh', 'seed', null],
      ['static.md', 'seed', null],
    ]);
    expect(written.map((r) => r.seq)).toEqual([1, 2]);
  });

  /**
   * A file that appeared because the image seeded it was not edited by anybody, so nothing
   * the sweep merely finds gets somebody's reason attached to it. Only the file a save names
   * is claimed — and a save can name a file the log has never seen, which is what happens
   * when an operator drops in a new rubric and edits it before the next restart.
   */
  it('claims only the file a save names, and seeds the rest', async () => {
    const written = await store.sweep({ save: { file: 'static.md', message: 'why' } });
    expect(written.map((r) => [r.file, r.source, r.message])).toEqual([
      ['currency.sh', 'seed', null],
      ['static.md', 'save', 'why'],
    ]);
  });

  it('writes the bytes beside the log line, named by seq and short hash', async () => {
    const [, statik] = await store.sweep();
    const file = path.join(dir, HISTORY_DIR, 'static.md', `0002-${shortSha(statik!.sha256)}.md`);
    expect(await fs.readFile(file, 'utf8')).toBe(STATIC);
  });
});

describe('a later sweep', () => {
  beforeEach(async () => {
    await store.sweep();
  });

  it('records nothing when nothing changed', async () => {
    expect(await store.sweep()).toEqual([]);
    expect((await store.all()).length).toBe(2);
  });

  /** The case the integer could not see: somebody edited the file over SSH. */
  it('catches an edit made outside the app, and records no reason for it', async () => {
    await fs.writeFile(path.join(dir, 'static.md'), `${STATIC}\nAnd one more rule.\n`, 'utf8');
    const [rev] = await store.sweep();
    expect(rev?.source).toBe('observed');
    expect(rev?.message).toBeNull();
    expect(rev?.parent).toBe((await store.forFiles(['static.md']))[1]?.sha256);
  });

  /**
   * A save is the cheapest moment to notice that the script beside the rubric moved too — but
   * the operator saved one file, and only that one carries their reason.
   */
  it('credits the saved file and no other, while still recording the rest', async () => {
    await fs.writeFile(path.join(dir, 'static.md'), `${STATIC}\nEdited.\n`, 'utf8');
    await fs.writeFile(path.join(dir, 'currency.sh'), `${CURRENCY}# also edited\n`, 'utf8');
    const written = await store.sweep({ save: { file: 'static.md', message: 'tightened §7' } });
    expect(written.map((r) => [r.file, r.source, r.message])).toEqual([
      ['currency.sh', 'observed', null],
      ['static.md', 'save', 'tightened §7'],
    ]);
  });

  it('records a protocol added after the fact', async () => {
    await fs.writeFile(path.join(dir, 'security.md'), '---\nid: security\n---\n\n# Security\n', 'utf8');
    expect((await store.sweep()).map((r) => [r.file, r.source])).toEqual([['security.md', 'seed']]);
  });

  it('gives back the exact bytes for a hash, by prefix or in full', async () => {
    const before = (await store.forFiles(['static.md']))[0]!;
    await fs.writeFile(path.join(dir, 'static.md'), 'replaced\n', 'utf8');
    await store.sweep();

    expect((await store.get(before.sha256))?.text).toBe(STATIC);
    expect((await store.get(shortSha(before.sha256)))?.text).toBe(STATIC);
    expect(await store.get('not-a-hash')).toBeNull();
    expect(await store.get('0'.repeat(64))).toBeNull();
  });

  /**
   * A file put back the way it was carries the identity it had then, so one hash names two
   * rows with different parents. Content is addressed by hash; an event by seq.
   */
  it('keeps two rows apart when a file is restored to an earlier state', async () => {
    const original = (await store.forFiles(['static.md']))[0]!;
    await fs.writeFile(path.join(dir, 'static.md'), 'changed\n', 'utf8');
    await store.sweep();
    await fs.writeFile(path.join(dir, 'static.md'), STATIC, 'utf8');
    const [restored] = await store.sweep();

    expect(restored?.sha256).toBe(original.sha256);
    expect(restored?.parent).not.toBe(original.parent);
    // By hash: the earliest, which is the right answer for "what did it say".
    expect((await store.get(original.sha256))?.revision.seq).toBe(original.seq);
    // By seq: this row, which is the right answer for "what changed here".
    expect((await store.at(restored!.seq))?.revision.parent).toBe(restored!.parent);
    expect((await store.at(restored!.seq))?.text).toBe(STATIC);
    expect(await store.at(9999)).toBeNull();
  });

  it('orders newest first, across files', async () => {
    await fs.writeFile(path.join(dir, 'currency.sh'), `${CURRENCY}# edited\n`, 'utf8');
    await store.sweep();
    const all = await store.all();
    expect(all[0]?.file).toBe('currency.sh');
    expect(all.map((r) => r.seq)).toEqual([3, 2, 1]);
  });
});

describe('when the world is broken', () => {
  it('skips a corrupt log line and keeps the rest', async () => {
    await store.sweep();
    const raw = await fs.readFile(logPath(), 'utf8');
    await fs.writeFile(logPath(), `${raw.split('\n')[0]}\nnot json at all\n${raw.split('\n')[1]}\n`);

    const fresh = new RevisionStore(dir, { onWarn: (m) => warnings.push(m) });
    expect((await fresh.all()).length).toBe(2);
    expect(warnings.some((w) => w.includes('could not be read'))).toBe(true);
  });

  it('warns and records nothing when the protocol directory is gone', async () => {
    const missing = new RevisionStore(path.join(dir, 'nowhere'), {
      onWarn: (m) => warnings.push(m),
    });
    expect(await missing.sweep()).toEqual([]);
    expect(missing.failed).toContain('could not be read');
  });

  it('warns once per condition rather than on every sweep', async () => {
    const missing = new RevisionStore(path.join(dir, 'nowhere'), {
      onWarn: (m) => warnings.push(m),
    });
    await missing.sweep();
    await missing.sweep();
    expect(warnings).toHaveLength(1);
  });

  /** Two sweeps racing must not interleave: seq is assigned under the same lock as the append. */
  it('serialises concurrent sweeps', async () => {
    await fs.writeFile(path.join(dir, 'static.md'), 'first\n', 'utf8');
    const [a, b] = await Promise.all([store.sweep(), store.sweep()]);
    expect([...a, ...b]).toHaveLength(2);
    expect((await store.all()).map((r) => r.seq).sort()).toEqual([1, 2]);
  });
});

describe('what it refuses to look at', () => {
  it('ignores its own directory and anything that is not a protocol', async () => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'nope\n', 'utf8');
    await fs.mkdir(path.join(dir, 'subdir'), { recursive: true });
    expect((await store.sweep()).map((r) => r.file)).toEqual(['currency.sh', 'static.md']);

    // The second sweep sees `.history` on disk and must still record nothing.
    expect(await store.sweep()).toEqual([]);
  });

  it('will not read a snapshot for a log line naming a path', async () => {
    await store.sweep();
    const forged = { ...(await store.all())[0]!, file: '../escape.md' };
    await fs.appendFile(logPath(), `${JSON.stringify(forged)}\n`, 'utf8');
    const fresh = new RevisionStore(dir);
    expect((await fresh.all()).every((r) => !r.file.includes('..'))).toBe(true);
  });
});
