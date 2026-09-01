/**
 * Trial input validation and slugs.
 *
 * `store_url` is the one input this process itself dereferences, so the tests here are mostly
 * about what must be refused. Shape is checked here; *which hosts may be fetched* is a separate
 * question answered in `services/trialstore.test.ts`, and the two are deliberately not the same
 * check.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrialRecord } from '../../shared/trials.js';
import { isTrialSlug, TrialInputError, trialSlug, TrialStore, validateTrial } from './trials.js';

const URL_OK = 'https://github.com/Acme/AppStore/archive/refs/heads/pr-812.zip';
const OK = { store_url: URL_OK, subject: 'Widget' };

describe('validateTrial', () => {
  it('accepts a plain request and defaults the apps path', () => {
    expect(validateTrial(OK)).toEqual({
      store_url: URL_OK,
      apps_path: 'Apps',
      subject: 'Widget',
    });
  });

  it('trims slashes off the apps path rather than producing a double separator', () => {
    expect(validateTrial({ ...OK, apps_path: '/apps/' }).apps_path).toBe('apps');
  });

  it('normalises a leading slash rather than refusing it', () => {
    // The value names a directory *inside the archive* either way, so stripping is the
    // friendlier reading of what somebody meant and there is nowhere for it to escape to.
    expect(validateTrial({ ...OK, apps_path: '/etc' }).apps_path).toBe('etc');
  });

  const refused: [string, Record<string, unknown>][] = [
    ['a url that is not a url', { ...OK, store_url: 'not a url' }],
    ['a relative url', { ...OK, store_url: '/archive.zip' }],
    ['plain http', { ...OK, store_url: 'http://github.com/a/b/archive/main.zip' }],
    ['a file url', { ...OK, store_url: 'file:///etc/passwd' }],
    ['an apps path climbing out', { ...OK, apps_path: '../secrets' }],
    ['a subject with a slash', { ...OK, subject: 'a/b' }],
    ['a subject that is a traversal', { ...OK, subject: '..' }],
    ['nothing at all', {}],
  ];

  for (const [what, input] of refused) {
    it(`refuses ${what}`, () => {
      expect(() => validateTrial(input)).toThrow(TrialInputError);
    });
  }
});

describe('trialSlug', () => {
  it('is one safe path and URL segment', () => {
    const slug = trialSlug('Widget', '2026-08-20T19:00:00.000Z');

    expect(slug).toMatch(/^Widget@[0-9a-f]{8}-2026-08-20T19-00-00-000Z$/);
    // Neither separator may appear: `/` would make it two path segments, and `~` separates an
    // origin from a subject, which is exactly what the slug is standing in for.
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('~');
    expect(isTrialSlug(slug)).toBe(true);
  });

  it('distinguishes two trials of the same app at the same instant', () => {
    // The timestamp alone is not enough: two calls in one millisecond would collide, and a
    // collision here is one trial's reports overwriting another's.
    expect(trialSlug('Widget', '2026-08-20T19:00:00.000Z')).not.toBe(
      trialSlug('Widget', '2026-08-20T19:00:00.000Z'),
    );
  });

  it('flattens a subject that is not already one safe segment', () => {
    const slug = trialSlug('we/ird name', '2026-08-20T19:00:00.000Z');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain(' ');
    expect(isTrialSlug(slug)).toBe(true);
  });

  it('rejects anything it did not produce', () => {
    for (const bad of ['../etc', 'a/b', 'yundera~FileBrowser', 'no-at-sign', '']) {
      expect(isTrialSlug(bad)).toBe(false);
    }
  });
});

/**
 * Retention: a trial's row and its report directory live and die together.
 *
 * They did not, once. `MAX_TRIALS` capped the row and left the directory, so past a hundred
 * trials the oldest directories became orphaned — invisible in the UI, undeletable through it,
 * and carried in every backup and uninstall archive for good.
 */
describe('the queue, and the rows that predate it', () => {
  let dir: string;
  let store: TrialStore;

  const rowOf = (over: Partial<TrialRecord>): TrialRecord => ({
    slug: 'Widget@aaaa1111-2026-09-01T09-00-00-000Z',
    source_url: URL_OK,
    repo: 'Acme/AppStore',
    apps_path: 'Apps',
    subject: 'Widget',
    started_at: '2026-09-01T09:00:00.000Z',
    ...over,
  });

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-trial-queue-'));
    store = new TrialStore(dir, path.join(dir, 'trials'));
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /**
   * The upgrade hazard, pinned. A row written before trials were queued has `started_at`, no
   * `began_at` and no `queued_at` — byte-for-byte what a waiting trial looks like — so without
   * `queued_at` the first tick after the upgrade dispatches every trial the old code ever
   * stranded. There were two of them on the box the day this shipped.
   */
  it('does not read a pre-queue row as queued, and closes it at boot', async () => {
    await store.add(
      rowOf({
        slug: 'Hubs@eb0f2838-2026-08-23T17-56-55-138Z',
        subject: 'Hubs',
        started_at: '2026-08-23T17:56:55.138Z',
      }),
    );

    expect(store.queued()).toEqual([]);

    const closed = await store.reconcile('2026-09-01T10:00:00.000Z');
    expect(closed).toEqual(['Hubs@eb0f2838-2026-08-23T17-56-55-138Z']);
    const row = store.get('Hubs@eb0f2838-2026-08-23T17-56-55-138Z');
    expect(row?.outcome).toBe('error');
    expect(row?.finished_at).toBe('2026-09-01T10:00:00.000Z');
  });

  it('keeps a genuinely queued row across a restart', async () => {
    await store.add(rowOf({ queued_at: '2026-09-01T09:00:00.000Z' }));

    expect(store.queued().map((t) => t.slug)).toEqual(['Widget@aaaa1111-2026-09-01T09-00-00-000Z']);
    // It was never started, so a restart costs it nothing and it is still in the line.
    expect(await store.reconcile()).toEqual([]);
    expect(store.queued()).toHaveLength(1);
  });

  it('closes a row that was running when the process stopped', async () => {
    await store.add(
      rowOf({
        slug: 'Widget@bbbb2222-2026-09-01T09-00-00-000Z',
        queued_at: '2026-09-01T09:00:00.000Z',
        began_at: '2026-09-01T09:00:05.000Z',
      }),
    );

    expect(store.queued()).toEqual([]);
    expect(await store.reconcile()).toEqual(['Widget@bbbb2222-2026-09-01T09-00-00-000Z']);
    expect(store.get('Widget@bbbb2222-2026-09-01T09-00-00-000Z')?.outcome).toBe('error');
  });
});

describe('trial retention', () => {
  let dir: string;
  let root: string;
  let store: TrialStore;

  const rec = (slug: string, at: string): TrialRecord => ({
    slug,
    source_url: URL_OK,
    repo: 'Acme/AppStore',
    apps_path: 'Apps',
    subject: 'Widget',
    started_at: at,
  });

  /** A trial's reports, as the runner would have written them. */
  async function reportsFor(slug: string): Promise<void> {
    const d = path.join(root, slug, 'Widget');
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, '2026-08-21T00-00-00Z-static.md'), '---\nsubject: Widget\n---\n', 'utf8');
  }

  const exists = async (slug: string): Promise<boolean> =>
    fs.access(path.join(root, slug)).then(() => true, () => false);

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-trial-retention-'));
    root = path.join(dir, 'trials');
    await fs.mkdir(root, { recursive: true });
    store = new TrialStore(dir, root);
    await store.load();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('deletes the reports when the row is deleted', async () => {
    await store.add(rec('A@one', '2026-08-21T09:00:00.000Z'));
    await reportsFor('A@one');
    expect(await exists('A@one')).toBe(true);

    expect(await store.remove('A@one')).toBe(true);
    expect(await exists('A@one')).toBe(false);
  });

  it('deletes the reports of a row that falls off the end of the cap', async () => {
    // 101 trials: the oldest is evicted, and its directory must go with it.
    for (let i = 0; i <= 100; i++) {
      const slug = `A@r${i}`;
      await store.add(rec(slug, `2026-08-21T09:${String(i).padStart(2, '0')}:00.000Z`));
      await reportsFor(slug);
    }

    expect(store.list()).toHaveLength(100);
    expect(store.get('A@r0')).toBeUndefined();
    // The whole point: the row went and so did the bytes.
    expect(await exists('A@r0')).toBe(false);
    expect(await exists('A@r100')).toBe(true);
  });

  it('sweeps directories that have no row', async () => {
    await store.add(rec('A@keep', '2026-08-21T09:00:00.000Z'));
    await reportsFor('A@keep');
    await reportsFor('A@orphan'); // no row — what the old eviction left behind

    const swept = await store.sweepOrphans();

    expect(swept).toEqual(['A@orphan']);
    expect(await exists('A@orphan')).toBe(false);
    expect(await exists('A@keep')).toBe(true);
  });

  it('never removes a directory it did not mint', async () => {
    // An operator's own folder under trials/ is not a slug and must survive the sweep.
    await fs.mkdir(path.join(root, 'my-notes'), { recursive: true });
    const swept = await store.sweepOrphans();
    expect(swept).toEqual([]);
    expect(await exists('my-notes')).toBe(true);
  });

  it('sweeps nothing, quietly, when there is no trials directory', async () => {
    const bare = new TrialStore(dir, path.join(dir, 'absent'));
    await bare.load();
    expect(await bare.sweepOrphans()).toEqual([]);
  });
});
