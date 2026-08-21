/**
 * Trial input validation and slugs.
 *
 * `repo`, `ref` and `apps_path` arrive in an HTTP body and are interpolated into a prompt the
 * agent runs `gh` against. This is the one place a caller chooses what repository gets read,
 * so the tests here are mostly about what must be refused.
 */

import { describe, expect, it } from 'vitest';

import { isTrialSlug, TrialInputError, trialSlug, validateTrial } from './trials.js';

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
