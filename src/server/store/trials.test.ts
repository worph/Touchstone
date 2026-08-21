/**
 * Trial input validation and slugs.
 *
 * `repo`, `ref` and `apps_path` arrive in an HTTP body and are interpolated into a prompt the
 * agent runs `gh` against. This is the one place a caller chooses what repository gets read,
 * so the tests here are mostly about what must be refused.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TrialRecord } from '../../shared/trials.js';
import { isTrialSlug, TrialInputError, trialSlug, TrialStore, validateTrial } from './trials.js';

const OK = { repo: 'Acme/AppStore', ref: 'pr-812', subject: 'Widget' };

describe('validateTrial', () => {
  it('accepts a plain request and defaults the apps path', () => {
    expect(validateTrial(OK)).toEqual({
      repo: 'Acme/AppStore',
      ref: 'pr-812',
      apps_path: 'Apps',
      subject: 'Widget',
    });
  });

  it('accepts a slashed ref, which git allows', () => {
    expect(validateTrial({ ...OK, ref: 'release/1.2' }).ref).toBe('release/1.2');
  });

  it('trims slashes off the apps path rather than producing a double separator', () => {
    expect(validateTrial({ ...OK, apps_path: '/apps/' }).apps_path).toBe('apps');
  });

  it('normalises a leading slash rather than refusing it', () => {
    // The value is interpolated into `gh api repos/<repo>/contents/<apps_path>`, so a leading
    // slash makes it a path *inside the repo* either way. Stripping is the friendlier reading
    // of what somebody meant, and there is nowhere for it to escape to.
    expect(validateTrial({ ...OK, apps_path: '/etc' }).apps_path).toBe('etc');
  });

  const refused: [string, Record<string, unknown>][] = [
    ['a repo that is not owner/name', { ...OK, repo: 'AppStore' }],
    ['a repo with a path in it', { ...OK, repo: 'Acme/AppStore/../../etc' }],
    ['an absolute repo', { ...OK, repo: '/etc/passwd' }],
    ['a ref climbing out', { ...OK, ref: '../../etc/passwd' }],
    ['a ref with a dotdot segment', { ...OK, ref: 'release/../main' }],
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
    const slug = trialSlug(validateTrial(OK), '2026-08-20T19:00:00.000Z');

    expect(slug).toBe('Acme-AppStore@pr-812-2026-08-20T19-00-00-000Z');
    // Neither separator may appear: `/` would make it two path segments, and `~` separates an
    // origin from a subject, which is exactly what the slug is standing in for.
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('~');
    expect(isTrialSlug(slug)).toBe(true);
  });

  it('distinguishes two runs of the same ref', () => {
    const v = validateTrial(OK);
    expect(trialSlug(v, '2026-08-20T19:00:00.000Z')).not.toBe(
      trialSlug(v, '2026-08-20T20:00:00.000Z'),
    );
  });

  it('flattens a slashed ref into the segment', () => {
    const slug = trialSlug(validateTrial({ ...OK, ref: 'release/1.2' }), '2026-08-20T19:00:00.000Z');
    expect(slug).not.toContain('/');
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
describe('trial retention', () => {
  let dir: string;
  let root: string;
  let store: TrialStore;

  const rec = (slug: string, at: string): TrialRecord => ({
    slug,
    repo: 'Acme/AppStore',
    ref: 'pr-1',
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
