/**
 * Origins: the config entry, and the URL built from it.
 *
 * Both tests here are regressions for bugs that were *silent* — they produce a wrong answer
 * rather than an error, which is why they are worth pinning.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN } from '../../shared/subject.js';
import { resolveOrigins } from './config.js';
import { appsUrlFor } from './registry.js';

describe('resolveOrigins', () => {
  it('re-adds the default origin when config replaced the list', () => {
    // The trap: `merge()` replaces arrays wholesale, so an operator adding a store by writing
    // `origins: [{id: acme, ...}]` deletes the Yundera one. Every report written before this
    // setting existed resolves to `DEFAULT_ORIGIN`, so the whole archive would become subjects
    // of a store that is not configured — unschedulable, and with nothing said about it.
    const out = resolveOrigins([{ id: 'acme', repo: 'Acme/AppStore' }]);

    expect(out.map((o) => o.id)).toEqual([DEFAULT_ORIGIN, 'acme']);
    expect(out.find((o) => o.id === DEFAULT_ORIGIN)?.repo).toBe('Yundera/AppStore');
  });

  it('keeps an explicitly configured default rather than duplicating it', () => {
    const out = resolveOrigins([
      { id: DEFAULT_ORIGIN, repo: 'Someone/Fork', ref: 'next', apps_path: 'apps' },
    ]);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo: 'Someone/Fork', ref: 'next', apps_path: 'apps' });
  });

  it('fills in the ref and apps path, and drops entries it could not fetch from', () => {
    const out = resolveOrigins([
      { id: 'acme', repo: 'Acme/AppStore' },
      { id: 'no-repo' },
      { id: 'off', repo: 'Acme/Other', enabled: false },
      { id: 'acme', repo: 'Acme/Duplicate' },
    ]);

    expect(out.map((o) => o.id)).toEqual([DEFAULT_ORIGIN, 'acme']);
    expect(out[1]).toMatchObject({ ref: 'main', apps_path: 'Apps' });
  });

  it('survives a missing or malformed origins block', () => {
    for (const raw of [undefined, null, 'nonsense', []]) {
      expect(resolveOrigins(raw).map((o) => o.id)).toEqual([DEFAULT_ORIGIN]);
    }
  });
});

describe('appsUrlFor', () => {
  it('pins the ref', () => {
    // Without `?ref=`, the contents API answers for the repo's default branch whatever the
    // origin says — so an origin pinned to a branch would audit main's list of apps and never
    // say so. A wrong answer, not an error.
    expect(appsUrlFor({ repo: 'Acme/AppStore', ref: 'pr-812', apps_path: 'Apps' })).toBe(
      'https://api.github.com/repos/Acme/AppStore/contents/Apps?ref=pr-812',
    );
  });

  it('tolerates a slashed apps path and encodes a slashed ref', () => {
    expect(appsUrlFor({ repo: 'Acme/AppStore', ref: 'release/1.2', apps_path: '/Apps/' })).toBe(
      'https://api.github.com/repos/Acme/AppStore/contents/Apps?ref=release%2F1.2',
    );
  });
});
