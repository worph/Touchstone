import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { appendJsonl, readJson, readJsonl, trimJsonl, writeJsonAtomic } from './state.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-state-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the append-only log file', () => {
  it('reads back what it appended', async () => {
    const file = path.join(dir, 'events.jsonl');
    await appendJsonl(file, { seq: 1, message: 'one' });
    await appendJsonl(file, { seq: 2, message: 'two' });
    expect(await readJsonl(file)).toEqual([
      { seq: 1, message: 'one' },
      { seq: 2, message: 'two' },
    ]);
  });

  /**
   * The expected corruption, and the reason the whole format is line-delimited: a process
   * killed mid-append leaves a truncated last line. Everything written before it is still
   * good, and refusing to load it would mean losing the log at exactly the moment — a hard
   * kill — when it is being read to find out what happened.
   */
  it('drops a torn trailing line and keeps everything before it', async () => {
    const file = path.join(dir, 'events.jsonl');
    await appendJsonl(file, { seq: 1, message: 'one' });
    await appendJsonl(file, { seq: 2, message: 'two' });
    await fs.appendFile(file, '{"seq":3,"messa', 'utf8');

    const skipped: string[] = [];
    const rows = await readJsonl<{ seq: number }>(file, { onSkip: (line) => skipped.push(line) });
    expect(rows.map((r) => r.seq)).toEqual([1, 2]);
    expect(skipped).toHaveLength(1);
  });

  it('skips a mangled line in the middle without losing the rest', async () => {
    const file = path.join(dir, 'events.jsonl');
    await appendJsonl(file, { seq: 1 });
    await fs.appendFile(file, 'someone opened this in an editor\n', 'utf8');
    await appendJsonl(file, { seq: 3 });
    expect((await readJsonl<{ seq: number }>(file)).map((r) => r.seq)).toEqual([1, 3]);
  });

  it('is empty, not an error, when the file has never been written', async () => {
    expect(await readJsonl(path.join(dir, 'nothing.jsonl'))).toEqual([]);
  });

  it('returns only the tail when a limit is given', async () => {
    const file = path.join(dir, 'events.jsonl');
    for (let i = 1; i <= 50; i++) await appendJsonl(file, { seq: i });
    const rows = await readJsonl<{ seq: number }>(file, { limit: 5 });
    expect(rows.map((r) => r.seq)).toEqual([46, 47, 48, 49, 50]);
  });

  it('trims to the newest entries', async () => {
    const file = path.join(dir, 'events.jsonl');
    for (let i = 1; i <= 20; i++) await appendJsonl(file, { seq: i });
    expect(await trimJsonl(file, 5)).toBe(5);
    expect((await readJsonl<{ seq: number }>(file)).map((r) => r.seq)).toEqual([16, 17, 18, 19, 20]);
  });
});

describe('atomically rewritten json', () => {
  it('round-trips', async () => {
    const file = path.join(dir, 'alerts.json');
    await writeJsonAtomic(file, [{ key: 'bench.auth' }]);
    expect(await readJson(file, [])).toEqual([{ key: 'bench.auth' }]);
  });

  it('leaves no temp file behind', async () => {
    const file = path.join(dir, 'alerts.json');
    await writeJsonAtomic(file, { a: 1 });
    expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });

  /** Deleting `state/` must always be safe, so every read failure is the fallback. */
  it('falls back rather than throwing on a missing or garbage file', async () => {
    expect(await readJson(path.join(dir, 'gone.json'), 'fallback')).toBe('fallback');
    const broken = path.join(dir, 'broken.json');
    await fs.writeFile(broken, '{"half":', 'utf8');
    expect(await readJson(broken, 'fallback')).toBe('fallback');
  });
});

/**
 * Found by a test that failed about one run in three, in a different file each time. The
 * temp name carried only the pid, so two overlapping writes to the same file — a bench probe
 * and the alert it raises, a tick and the result it records — shared one scratch path and the
 * second lost its contents to an `ENOENT` rename.
 */
describe('two writes to one file at the same time', () => {
  it('does not lose either of them', async () => {
    const file = path.join(dir, 'race.json');
    await Promise.all(
      Array.from({ length: 25 }, (_, i) => writeJsonAtomic(file, { i })),
    );
    const back = await readJson<{ i: number }>(file, { i: -1 });
    expect(back.i).toBeGreaterThanOrEqual(0);
  });

  it('leaves no scratch files behind', async () => {
    const file = path.join(dir, 'clean.json');
    await Promise.all(Array.from({ length: 10 }, (_, i) => writeJsonAtomic(file, { i })));
    const left = (await fs.readdir(dir)).filter((f) => f.includes('.tmp-'));
    expect(left).toEqual([]);
  });
});
