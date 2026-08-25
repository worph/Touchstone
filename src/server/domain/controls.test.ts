/**
 * The controls, which are the one place `config.yaml` stops being the last word.
 *
 * The properties worth pinning are the ones that make this different from a settings blob:
 * a write reaches the *live* object rather than only the file, `config.yaml` stays the value
 * a fresh boot falls back to, a stored override is put back after a restart, and anything
 * that cannot be applied is refused loudly rather than swallowed.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReportIndex } from '../store/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import type { BenchProber } from '../services/bench.js';
import { EventLog } from '../services/events.js';
import { Scheduler } from '../scheduler/index.js';
import { ControlStore } from '../store/controls.js';
import {
  applyStoredControls,
  listControls,
  resetControl,
  setControl,
  type ControlDefaults,
  type ControlPorts,
} from './controls.js';

const CONSTANTS = { fresh_days: 7, stuck_days: 7, lease_min: 120, cooldown_min: 55, max_tries: 3 };

const DEFAULTS: ControlDefaults = {
  scheduler: { armed: false, tick_min: 60, ...CONSTANTS },
  runner: {
    enabled: false,
    busy_backoff_min: 10,
    agent_url: '',
    agent_tool: '',
    agent_via: 'direct',
    callback_url: '',
  },
  bench: {
    pool_url: '',
    board_url: '',
    min_remaining_min: 60,
    probe_interval_min: 5,
    probe_timeout_ms: 5000,
  },
};

let dir: string;
let events: EventLog;

function schedulerOf(): Scheduler {
  return new Scheduler({
    constants: { ...CONSTANTS },
    armed: false,
    tickMin: 60,
    stateDir: dir,
    index: {
      sections: () => ['static'],
      latest: () => null,
      latestAny: () => null,
      subjects: () => [],
    } as unknown as ReportIndex,
    registry: { list: () => [], isLive: true } as unknown as SubjectRegistry,
    events,
  });
}

/** A prober that only has to answer the one question the bench control asks of it. */
function proberOf(): BenchProber {
  let min = 60;
  return {
    get minRemainingMin() {
      return min;
    },
    minRemainingMinDefault: 60,
    setMinRemainingMin: (v: number) => {
      min = v;
    },
    clearMinRemainingMin: () => {
      min = 60;
    },
  } as unknown as BenchProber;
}

async function portsOf(over: Partial<ControlPorts> = {}): Promise<ControlPorts> {
  const controls = new ControlStore({ stateDir: dir });
  await controls.load();
  return {
    controls,
    defaults: DEFAULTS,
    scheduler: schedulerOf(),
    prober: proberOf(),
    events,
    ...over,
  };
}

function row(ports: ControlPorts, key: string) {
  return listControls(ports).find((r) => r.key === key);
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-controls-'));
  events = new EventLog(dir);
});

afterEach(async () => {
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('reading them', () => {
  it('reports the config value as both the value and the default until something changes it', async () => {
    const ports = await portsOf();
    expect(row(ports, 'scheduler.fresh_days')).toMatchObject({
      value: 7,
      default: 7,
      source: 'config',
      settable: true,
      unit: 'days',
    });
  });

  it('lists a control whose owner is not wired up, and refuses to set it', async () => {
    const ports = await portsOf({ scheduler: undefined });
    expect(row(ports, 'scheduler.fresh_days')).toMatchObject({ value: 7, settable: false });

    const result = await setControl(ports, 'scheduler.fresh_days', 14);
    expect(result.ok).toBe(false);
  });

  /** The whole point of the exercise: the operator's example, end to end. */
  it('changes the re-audit window without a restart', async () => {
    const ports = await portsOf();
    const result = await setControl(ports, 'scheduler.fresh_days', 14, 'chat');
    expect(result.ok && result.changed).toBe(true);
    // The live object, not just the row that came back.
    expect(ports.scheduler?.constants.fresh_days).toBe(14);
    expect(row(ports, 'scheduler.fresh_days')).toMatchObject({
      value: 14,
      default: 7,
      source: 'override',
    });
  });
});

describe('writing them', () => {
  it('survives a restart, because the override is on disk', async () => {
    const first = await portsOf();
    await setControl(first, 'scheduler.cooldown_min', 240);

    // A second boot: a new store over the same directory, a new scheduler on the config value.
    const second = await portsOf();
    expect(second.scheduler?.constants.cooldown_min).toBe(55);
    await applyStoredControls(second);
    expect(second.scheduler?.constants.cooldown_min).toBe(240);
    expect(row(second, 'scheduler.cooldown_min')).toMatchObject({ source: 'override', default: 55 });
  });

  it('puts the timer on the new cadence rather than only the number', async () => {
    const ports = await portsOf();
    await setControl(ports, 'scheduler.tick_min', 15);
    expect(ports.scheduler?.tickMinutes).toBe(15);
    expect(ports.scheduler?.snapshot().constants.tick_min).toBe(15);
  });

  it('refuses a value outside the range, and says what the range is', async () => {
    const ports = await portsOf();
    const result = await setControl(ports, 'scheduler.fresh_days', 4000);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('365');
    expect(ports.scheduler?.constants.fresh_days).toBe(7);
  });

  it('refuses a fraction, and a word where a number belongs', async () => {
    const ports = await portsOf();
    expect((await setControl(ports, 'scheduler.max_tries', 2.5)).ok).toBe(false);
    expect((await setControl(ports, 'scheduler.max_tries', 'often')).ok).toBe(false);
  });

  /** A number that arrived as a string is what somebody meant; refusing it teaches nobody. */
  it('takes a numeric string', async () => {
    const ports = await portsOf();
    expect((await setControl(ports, 'scheduler.fresh_days', '21')).ok).toBe(true);
    expect(ports.scheduler?.constants.fresh_days).toBe(21);
  });

  it('refuses a number for a switch', async () => {
    const ports = await portsOf();
    const result = await setControl(ports, 'scheduler.armed', 1);
    expect(result.ok).toBe(false);
  });

  it('refuses a key it does not have, and names the ones it does', async () => {
    const ports = await portsOf();
    const result = await setControl(ports, 'scheduler.armed_please', true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('scheduler.fresh_days');
  });

  it('writes nothing when the value is already what was asked for', async () => {
    const ports = await portsOf();
    const result = await setControl(ports, 'scheduler.fresh_days', 7);
    expect(result.ok && result.changed).toBe(false);
    expect(ports.controls?.get('scheduler.fresh_days')).toBeUndefined();
    expect(row(ports, 'scheduler.fresh_days')?.source).toBe('config');
  });

  it('records what moved, from what, and who moved it', async () => {
    const ports = await portsOf();
    await setControl(ports, 'scheduler.fresh_days', 14, 'chat');
    const entry = events.query({ code: 'CONTROL_CHANGED' })[0];
    expect(entry?.detail).toMatchObject({ key: 'scheduler.fresh_days', from: 7, to: 14, by: 'chat' });
  });
});

describe('putting one back', () => {
  it('drops the override and the stored value with it', async () => {
    const ports = await portsOf();
    await setControl(ports, 'scheduler.fresh_days', 14);
    const result = await resetControl(ports, 'scheduler.fresh_days');
    expect(result.ok && result.changed).toBe(true);
    expect(ports.scheduler?.constants.fresh_days).toBe(7);
    expect(ports.controls?.get('scheduler.fresh_days')).toBeUndefined();
    expect(row(ports, 'scheduler.fresh_days')?.source).toBe('config');
  });

  it('puts the timer back too', async () => {
    const ports = await portsOf();
    await setControl(ports, 'scheduler.tick_min', 15);
    await resetControl(ports, 'scheduler.tick_min');
    expect(ports.scheduler?.tickMinutes).toBe(60);
  });
});

describe('the two safety switches', () => {
  /**
   * `armed` is driven from here but persisted by the scheduler, which already has a file and
   * a page for it. The test that matters is that it is not *also* written here, because two
   * files holding one switch is how they come to disagree.
   */
  it('arms through the scheduler, and keeps the switch in the scheduler’s own file', async () => {
    const ports = await portsOf();
    const result = await setControl(ports, 'scheduler.armed', true, 'chat');
    expect(result.ok).toBe(true);
    expect(ports.scheduler?.armed).toBe(true);
    expect(ports.controls?.get('scheduler.armed')).toBeUndefined();
    expect(row(ports, 'scheduler.armed')).toMatchObject({ value: true, default: false, source: 'override' });

    expect(events.query({ code: 'SCHEDULER_ARMED' })).toHaveLength(1);
    // One row for one action: `setArmed` already announced it.
    expect(events.query({ code: 'CONTROL_CHANGED' })).toHaveLength(0);
  });

  it('reverts arming to what the config file says', async () => {
    const ports = await portsOf();
    await setControl(ports, 'scheduler.armed', true);
    await resetControl(ports, 'scheduler.armed');
    expect(ports.scheduler?.armed).toBe(false);
    expect(ports.scheduler?.snapshot().armed_source).toBe('config');
  });
});

describe('restoring at boot', () => {
  it('ignores a stored value that no longer passes its own check, and says so', async () => {
    const controls = new ControlStore({ stateDir: dir });
    await controls.load();
    await controls.set('scheduler.fresh_days', 9999);
    await controls.set('scheduler.made_up', 3);

    const ports = await portsOf({ controls });
    const applied = await applyStoredControls(ports);
    expect(applied.applied).toEqual([]);
    expect(ports.scheduler?.constants.fresh_days).toBe(7);

    expect(events.query({ code: 'CONTROL_IGNORED' })).toHaveLength(2);
  });

  it('applies the ones that are still good', async () => {
    const controls = new ControlStore({ stateDir: dir });
    await controls.load();
    await controls.set('scheduler.fresh_days', 14);
    await controls.set('bench.min_remaining_min', 90);

    const ports = await portsOf({ controls });
    const applied = await applyStoredControls(ports);
    expect(applied.applied).toHaveLength(2);
    expect(ports.scheduler?.constants.fresh_days).toBe(14);
    expect(ports.prober?.minRemainingMin).toBe(90);
  });
});
