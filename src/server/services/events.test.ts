import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { categoryOf, EventLog, type EventRecord } from './events.js';

let dir: string;
let log: EventLog;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-events-'));
  log = new EventLog(dir);
});

afterEach(async () => {
  await log.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('writing', () => {
  it('returns the row synchronously and persists it', async () => {
    const written = log.log({ level: 'info', code: 'SERVER_STARTED', message: 'Touchstone started' });
    expect(written.seq).toBe(1);
    await log.flush();
    const raw = await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8');
    expect(JSON.parse(raw.trim()) as EventRecord).toMatchObject({ code: 'SERVER_STARTED' });
  });

  it('derives the category from the code rather than storing an authored one', () => {
    expect(log.log({ level: 'info', code: 'BENCH_HEALTHY', message: 'ok' }).category).toBe('bench');
    expect(categoryOf('TICK_COMPLETED')).toBe('scheduler');
    expect(categoryOf('SOMETHING_NOBODY_DECLARED')).toBe('other');
  });

  /**
   * The log observes work; it must never break it. A read-only or full disk turns "we could
   * not write that the bench is down" into "we could not probe the bench" if this throws.
   */
  it('does not throw at the caller when the file cannot be written', async () => {
    const failures: string[] = [];
    const broken = new EventLog(path.join(dir, 'events.jsonl', 'nested-under-a-file'), {
      onWriteError: (_err, event) => failures.push(event.code),
    });
    await fs.writeFile(path.join(dir, 'events.jsonl'), 'not a directory', 'utf8');
    expect(() => broken.log({ level: 'error', code: 'BENCH_POOL_DOWN', message: 'down', detail: { benches: [] } })).not.toThrow();
    await broken.flush();
    expect(failures).toEqual(['BENCH_POOL_DOWN']);
  });

  it('still serves the row it could not write, because memory is the read path', async () => {
    const broken = new EventLog(path.join(dir, 'events.jsonl', 'nested'), { onWriteError: () => {} });
    await fs.writeFile(path.join(dir, 'events.jsonl'), 'not a directory', 'utf8');
    broken.log({ level: 'warn', code: 'IMPORT_FAILED', message: 'could not read', detail: { error: 'x' } });
    await broken.flush();
    expect(broken.query()).toHaveLength(1);
  });
});

describe('reading', () => {
  beforeEach(() => {
    log.log({ level: 'debug', code: 'PUSH_NO_DEVICES', message: 'nothing registered' });
    log.log({ level: 'info', code: 'BENCH_HEALTHY', message: 'bench ok', subject: 'Prowlarr' });
    log.log({ level: 'warn', code: 'BENCH_BOARD_DISAGREES', message: 'board disagrees', detail: { bench: 'a', board: 'Ready', probe: 'auth' } });
    log.log({ level: 'error', code: 'BENCH_AUTH_FAILED', message: 'refused', detail: { bench: 'a', url: 'u', status: 401 } });
  });

  it('is newest first', () => {
    expect(log.query().map((e) => e.seq)).toEqual([4, 3, 2, 1]);
  });

  it('filters by level as a floor, not an equality', () => {
    expect(log.query({ level: 'warn' }).map((e) => e.level)).toEqual(['error', 'warn']);
  });

  it('filters by category and by subject', () => {
    expect(log.query({ category: 'notify' })).toHaveLength(1);
    expect(log.query({ subject: 'prowlarr' })).toHaveLength(1);
  });

  it('serves the tail after a sequence number, which is how the page polls', () => {
    expect(log.query({ since: 2 }).map((e) => e.seq)).toEqual([4, 3]);
  });

  it('counts unread errors and nothing else, which is what the badge shows', () => {
    expect(log.errorsSince(0)).toBe(1);
    expect(log.errorsSince(4)).toBe(0);
  });

  it('lists the subjects it has seen, for the filter menu', () => {
    expect(log.subjects()).toEqual(['Prowlarr']);
  });
});

describe('across a restart', () => {
  it('reloads the tail and continues the sequence rather than restarting it', async () => {
    log.log({ level: 'info', code: 'SERVER_STARTED', message: 'first boot' });
    log.log({ level: 'info', code: 'SERVER_STARTED', message: 'still up' });
    await log.flush();

    const next = new EventLog(dir);
    await next.load();
    expect(next.query()).toHaveLength(2);
    expect(next.lastSeq).toBe(2);
    expect(next.log({ level: 'info', code: 'SERVER_STARTED', message: 'second boot' }).seq).toBe(3);
    await next.flush();
  });

  it('reads what it can from a log torn by a hard kill', async () => {
    log.log({ level: 'info', code: 'SERVER_STARTED', message: 'up' });
    await log.flush();
    await fs.appendFile(path.join(dir, 'events.jsonl'), '{"seq":2,"level":"in', 'utf8');

    const next = new EventLog(dir);
    await next.load();
    expect(next.query()).toHaveLength(1);
  });

  it('trims the file once it outgrows its cap, keeping the newest', async () => {
    const small = new EventLog(dir, { maxLines: 10 });
    for (let i = 0; i < 24; i++) {
      small.log({ level: 'info', code: 'SERVER_STARTED', message: `row ${i}` });
    }
    await small.flush();
    const lines = (await fs.readFile(path.join(dir, 'events.jsonl'), 'utf8')).trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(15);
    expect(lines.at(-1)).toContain('row 23');
  });
});

describe('routing hook', () => {
  it('hands every appended row to the subscriber', () => {
    const seen: string[] = [];
    log.subscribe((event) => seen.push(event.code));
    log.log({ level: 'info', code: 'SERVER_STARTED', message: 'up' });
    expect(seen).toEqual(['SERVER_STARTED']);
  });

  it('does not let a failing subscriber break the write', () => {
    // The default handler would console.error here; the point of the test is the caller,
    // so the noise is captured rather than printed.
    const quiet = new EventLog(dir, { onWriteError: () => {} });
    log = quiet;
    quiet.subscribe(() => {
      throw new Error('beacon is down');
    });
    expect(() => quiet.log({ level: 'info', code: 'SERVER_STARTED', message: 'up' })).not.toThrow();
    expect(quiet.query()).toHaveLength(1);
  });
});
