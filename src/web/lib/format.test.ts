/**
 * `sectionLabel` — how a section id reads in a column header.
 *
 * Worth pinning because it is the one place the composite id is taken apart for display, and
 * because nothing else in the web tree can be tested: there is no renderer here, so a helper
 * that stayed inline in a component would have no coverage at all.
 */

import { describe, expect, it } from 'vitest';

import { sectionLabel } from './format';

describe('sectionLabel', () => {
  it('capitalises a plain section id', () => {
    expect(sectionLabel('static')).toBe('Static');
    expect(sectionLabel('currency')).toBe('Currency');
  });

  it('names the platform of a target-scoped section', () => {
    expect(sectionLabel('functional@foss')).toBe('Functional · foss');
  });

  /** The default target keeps the bare id, so its column reads exactly as it always did. */
  it('leaves the default target reading as the plain rubric', () => {
    expect(sectionLabel('functional')).toBe('Functional');
  });

  it('reads hyphens and underscores as spaces', () => {
    expect(sectionLabel('image-currency')).toBe('Image currency');
    expect(sectionLabel('image_currency@foss')).toBe('Image currency · foss');
  });

  /** Degenerate, but a column header must never render as an empty cell. */
  it('survives an id that is only a separator', () => {
    expect(sectionLabel('')).toBe('');
    expect(sectionLabel('functional@')).toBe('Functional');
  });
});
