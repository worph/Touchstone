/**
 * The archive is not rewritten when the identity scheme changes, so both branches of this
 * label are live at once and will be for as long as the oldest report is kept.
 */

import { describe, expect, it } from 'vitest';

import { shortSha, standardLabel } from './standard.js';

describe('standardLabel', () => {
  it('prefers the revision, at twelve characters', () => {
    expect(
      standardLabel({ standard: 'Static Review Protocol', standard_sha256: 'a'.repeat(64) }),
    ).toBe(`Static Review Protocol @${'a'.repeat(12)}`);
  });

  it('falls back to the integer a pre-cutover assay recorded', () => {
    expect(standardLabel({ standard: 'Static Review Protocol', standard_version: 7 })).toBe(
      'Static Review Protocol v7',
    );
  });

  /** A record carrying both is a new one with legacy baggage: the hash is the true identity. */
  it('ignores the legacy number when a revision is present', () => {
    expect(
      standardLabel({ standard: 'S', standard_sha256: 'b'.repeat(64), standard_version: 7 }),
    ).toBe(`S @${'b'.repeat(12)}`);
  });

  it('says something rather than nothing when neither is recorded', () => {
    expect(standardLabel({ standard: 'S' })).toBe('S');
    expect(standardLabel({})).toBe('the standard');
  });

  it('shortens to the same length the executor hash has always used', () => {
    expect(shortSha('9c1b3f2a4d5567890')).toBe('9c1b3f2a4d55');
  });
});
