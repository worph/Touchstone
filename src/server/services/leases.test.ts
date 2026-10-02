/**
 * The lease registry — what replaced "one run at a time" as the thing stopping two audits from
 * sharing a bench or a browser.
 */

import { describe, expect, it } from 'vitest';

import type { BenchHealth } from '../../shared/activity.js';
import { Leases } from './leases.js';
import type { PortHealth } from './ports.js';

const bench = (name: string, target = 'yundera'): BenchHealth =>
  ({ name, target, url: `https://${name}`, status: 'healthy' }) as BenchHealth;
const browser = (name: string): PortHealth =>
  ({ name, kind: 'browser', url: `http://${name}:9746/mcp`, status: 'healthy' }) as PortHealth;

function world(opts: { yundera?: string[]; foss?: string[]; browsers?: string[] }) {
  return new Leases({
    benches: (target) =>
      (target === 'foss' ? opts.foss ?? [] : opts.yundera ?? []).map((n) => bench(n, target)),
    browsers: () => (opts.browsers ?? []).map(browser),
  });
}

const BOTH = { bench: true, browser: true };

describe('Leases', () => {
  it('hands two runs two different benches and two different browsers', () => {
    const leases = world({ yundera: ['demo1', 'demo2'], browsers: ['b1', 'b2'] });
    const a = leases.reserve('yundera', BOTH, 'A');
    const b = leases.reserve('yundera', BOTH, 'B');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.lease.bench?.url).not.toBe(b.lease.bench?.url);
    expect(a.lease.browser?.url).not.toBe(b.lease.browser?.url);
  });

  /** Two benches and one browser is one run: the pair is the unit, not the bench. */
  it('refuses a second run when the browsers are all held, though a bench is free', () => {
    const leases = world({ yundera: ['demo1', 'demo2'], browsers: ['b1'] });
    expect(leases.reserve('yundera', BOTH, 'A').ok).toBe(true);
    expect(leases.reserve('yundera', BOTH, 'B')).toEqual({ ok: false, full: 'browser' });
  });

  it('keeps platforms apart: a busy FOSS bench does not stop a Yundera run', () => {
    const leases = world({ yundera: ['demo1'], foss: ['demofoss1'], browsers: ['b1', 'b2'] });
    const foss = leases.reserve('foss', BOTH, 'F');
    expect(foss.ok && foss.lease.bench?.name).toBe('demofoss1');
    expect(leases.reserve('foss', BOTH, 'F2')).toEqual({ ok: false, full: 'bench' });
    const yundera = leases.reserve('yundera', BOTH, 'Y');
    expect(yundera.ok && yundera.lease.bench?.name).toBe('demo1');
  });

  it('gives a pair back on release, and release is idempotent', () => {
    const leases = world({ yundera: ['demo1'], browsers: ['b1'] });
    const a = leases.reserve('yundera', BOTH, 'A');
    if (!a.ok) throw new Error('expected a lease');
    expect(leases.reserve('yundera', BOTH, 'B').ok).toBe(false);
    leases.release(a.lease.id);
    leases.release(a.lease.id);
    leases.release(undefined);
    expect(leases.reserve('yundera', BOTH, 'B').ok).toBe(true);
  });

  /**
   * An outage is not "busy". With nothing healthy the run is granted the half it can have, so
   * `resolveCapabilities` records the rest `*_unavailable` — what every run did before leases.
   */
  it('grants a lease without the half that has no healthy resource at all', () => {
    const leases = world({ yundera: [], browsers: ['b1'] });
    const got = leases.reserve('yundera', BOTH, 'A');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.lease.bench).toBeUndefined();
    expect(got.lease.browser?.name).toBe('b1');
  });

  it('reserves only what a run needs', () => {
    const leases = world({ yundera: ['demo1'], browsers: ['b1'] });
    const got = leases.reserve('yundera', { bench: false, browser: false }, 'static-only');
    expect(got.ok && got.lease.bench === undefined && got.lease.browser === undefined).toBe(true);
    expect(leases.capacity(['yundera'])).toEqual({ benches: { yundera: 1 }, browsers: 1 });
  });

  it('reports free and total per platform, browsers as one shared pool', () => {
    const leases = world({ yundera: ['demo1', 'demo2'], foss: ['demofoss1'], browsers: ['b1', 'b2'] });
    leases.reserve('foss', BOTH, 'F');
    expect(leases.usage(['yundera', 'foss'])).toEqual({
      benches: { yundera: { free: 2, total: 2 }, foss: { free: 0, total: 1 } },
      browsers: { free: 1, total: 2 },
    });
  });
});
