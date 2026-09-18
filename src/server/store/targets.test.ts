/**
 * `targets()` — how many platforms this installation audits on, and what the absent case means.
 *
 * Every test here is a regression for something *silent*. `config.yaml` is hand-edited on live
 * volumes, so the file that is already on a box has to keep meaning what it meant before pools
 * existed — and the failure mode of getting that wrong is not an error, it is an installation
 * that boots cleanly and never leases a bench again.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TARGET, targets, type TouchstoneConfig } from './config.js';

/** Only the fields `benchPools` reads. The rest of the config is irrelevant to it. */
function cfg(
  over: Partial<TouchstoneConfig['bench']> & { targets?: TouchstoneConfig['targets'] } = {},
  benches: TouchstoneConfig['benches'] = [],
) {
  const { targets: declared, ...bench } = over;
  return {
    benches,
    ...(declared ? { targets: declared } : {}),
    bench: {
      pool_url: 'https://app.nasselle.com/demo/api/demos',
      board_url: 'https://app.nasselle.com/demo/admin/manage',
      min_remaining_min: 60,
      probe_interval_min: 5,
      probe_timeout_ms: 8000,
      ...bench,
    },
  } as unknown as TouchstoneConfig;
}

describe('targets', () => {
  /**
   * The back-compatibility guarantee, and the reason the feature is shaped this way: no
   * `pools:` key is not "no pools", it is the single demo pool described by the four fields
   * that have always been there.
   */
  it('reads a config with no targets as the one platform it has always been', () => {
    const out = targets(cfg({}, [{ name: 'demostaging1', url: 'https://d1.example' }]));

    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(DEFAULT_TARGET);
    expect(out[0]!.pool_url).toBe('https://app.nasselle.com/demo/api/demos');
    expect(out[0]!.min_remaining_min).toBe(60);
    expect(out[0]!.benches.map((b) => b.name)).toEqual(['demostaging1']);
  });

  /** And it keeps reading the roster already on disk, with every `healthy_at` in it. */
  it('leaves the default target on the state file it already wrote', () => {
    expect(targets(cfg())[0]!.state_file).toBe('benches.json');
  });

  /**
   * The trap this whole arrangement exists to avoid, at the configuration layer.
   *
   * A second pool inheriting `bench.pool_url` would discover the *demo* roster and hand a
   * Yundera box to a FOSS audit. The resulting report names a real host and carries a real
   * verdict about the wrong platform, which is indistinguishable from a correct one — so a
   * pool that names no source of benches gets none, and its sections are recorded blocked.
   */
  it('never lets a second target inherit the demo platform\'s roster', () => {
    const out = targets(
      cfg(
        { targets: [{ id: 'yundera' }, { id: 'foss' }] },
        [{ name: 'demostaging1', url: 'https://d1.example' }],
      ),
    );

    expect(out).toHaveLength(2);
    expect(out[1]!.pool_url).toBe('');
    expect(out[1]!.benches).toEqual([]);
    expect(out[1]!.state_file).toBe('benches.foss.json');
  });

  /** A fixed box that is never wiped has no countdown, and wants no runway guard. */
  it('takes a target\'s own runway guard over the global one', () => {
    const out = targets(
      cfg({
        targets: [
          { id: 'yundera' },
          {
            id: 'foss',
            pool: {
              min_remaining_min: 0,
              benches: [{ name: 'demofoss1', url: 'https://demofoss1.nsl.sh' }],
            },
          },
        ],
      }),
    );

    expect(out.map((t) => t.min_remaining_min)).toEqual([60, 0]);
    // The explicitly-listed default target still inherits the top-level fields, so writing it
    // out in full is not a way to accidentally turn discovery off.
    expect(out[0]!.pool_url).toBe('https://app.nasselle.com/demo/api/demos');
    expect(out[0]!.state_file).toBe('benches.json');
  });

  /**
   * The default is **positional**, not a magic id: an installation whose platforms are called
   * something else entirely still has one, and it is the one whose sections keep their bare ids.
   */
  it('treats the first entry as the default, whatever it is called', () => {
    const out = targets(cfg({ targets: [{ id: 'house' }, { id: 'foss' }] }));
    expect(out[0]!.state_file).toBe('benches.json');
    expect(out[0]!.pool_url).toBe('https://app.nasselle.com/demo/api/demos');
    expect(out[1]!.state_file).toBe('benches.foss.json');
  });

  it('falls back to the id for a target that names no label', () => {
    const out = targets(cfg({ targets: [{ id: 'foss' }] }));
    expect(out[0]!.label).toBe('foss');
  });
});
