/**
 * The controls — the configuration that can change while the app runs.
 *
 * The properties worth pinning: a write reaches the *live* object and `config.yaml` together
 * (since 2026-10-27 the file is a control's only home, so a restart reads back what was set),
 * a reset removes the key so the built-in default applies, and anything that cannot be applied
 * is refused loudly rather than swallowed.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import type { ReportIndex } from '../store/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import type { BenchProber } from '../services/bench.js';
import { EventLog } from '../services/events.js';
import { Scheduler } from '../scheduler/index.js';
import { ConfigFile } from '../store/configfile.js';
import {
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

function schedulerOf(config?: ConfigFile): Scheduler {
  return new Scheduler({
    constants: { ...CONSTANTS },
    armed: false,
    ...(config ? { saveArmed: (armed: boolean) => config.set('scheduler.armed', armed) } : {}),
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

function configPath(): string {
  return path.join(dir, 'config.yaml');
}

/** What the file on disk says now, parsed — `undefined` when it was never written. */
async function onDisk(): Promise<Record<string, Record<string, unknown>> | undefined> {
  const raw = await fs.readFile(configPath(), 'utf8').catch(() => null);
  return raw === null ? undefined : (YAML.parse(raw) ?? {});
}

async function portsOf(over: Partial<ControlPorts> = {}): Promise<ControlPorts> {
  // A live copy for the writer to keep in step, as `index.ts` hands it the booted config.
  const live = structuredClone(DEFAULTS);
  const config = new ConfigFile({
    file: configPath(),
    live: live as unknown as Record<string, unknown>,
    builtin: DEFAULTS as unknown as Record<string, unknown>,
  });
  return {
    config,
    defaults: live,
    scheduler: schedulerOf(config),
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
  it('changes the re-audit window without a restart, and in the file', async () => {
    const ports = await portsOf();
    const result = await setControl(ports, 'scheduler.fresh_days', 14, 'chat');
    expect(result.ok && result.changed).toBe(true);
    // The live object, not just the row that came back.
    expect(ports.scheduler?.constants.fresh_days).toBe(14);
    expect((await onDisk())?.scheduler?.fresh_days).toBe(14);
    // The file and the process agree, so there is nothing to call an override.
    expect(row(ports, 'scheduler.fresh_days')).toMatchObject({
      value: 14,
      default: 14,
      source: 'config',
    });
  });
});

describe('writing them', () => {
  it('survives a restart, because the value is in config.yaml', async () => {
    const first = await portsOf();
    await setControl(first, 'scheduler.cooldown_min', 240);
    await setControl(first, 'bench.min_remaining_min', 90);
    // What the next boot's `loadConfig` reads.
    const file = await onDisk();
    expect(file?.scheduler?.cooldown_min).toBe(240);
    expect(file?.bench?.min_remaining_min).toBe(90);
    expect(file?.scheduler).not.toHaveProperty('fresh_days');
  });

  it('keeps what the operator wrote in the file — comments, order, other keys', async () => {
    await fs.writeFile(
      configPath(),
      '# my notes\nscheduler:\n  armed: false   # off until Monday\n  cooldown_min: 55\nrunner:\n  enabled: true\n',
    );
    const ports = await portsOf();
    await setControl(ports, 'scheduler.cooldown_min', 30);
    const raw = await fs.readFile(configPath(), 'utf8');
    expect(raw).toContain('# my notes');
    expect(raw).toContain('# off until Monday');
    expect(YAML.parse(raw)).toEqual({ scheduler: { armed: false, cooldown_min: 30 }, runner: { enabled: true } });
  });

  it('puts the live value back when the file cannot be written', async () => {
    const ports = await portsOf({
      config: {
        file: configPath(),
        set: async () => {
          throw new Error('read-only volume');
        },
        builtin: () => undefined,
      },
    });
    const result = await setControl(ports, 'scheduler.fresh_days', 14);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('read-only volume');
    expect(ports.scheduler?.constants.fresh_days).toBe(7);
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
    expect(await onDisk()).toBeUndefined();
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
  it('takes the key out of the file and runs on the built-in default', async () => {
    const ports = await portsOf();
    await setControl(ports, 'scheduler.fresh_days', 14);
    const result = await resetControl(ports, 'scheduler.fresh_days');
    expect(result.ok && result.changed).toBe(true);
    expect(ports.scheduler?.constants.fresh_days).toBe(7);
    expect((await onDisk())?.scheduler).not.toHaveProperty('fresh_days');
    expect(row(ports, 'scheduler.fresh_days')).toMatchObject({ value: 7, default: 7, source: 'config' });
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
   * `armed` is driven from here but written by the scheduler, because the Automation page
   * flips it through `setArmed` without coming through here. Either way it lands in the one
   * file, and not in `state/schedule.json` as it did before 2026-10-27.
   */
  it('arms through the scheduler, which writes the switch into config.yaml', async () => {
    const ports = await portsOf();
    const result = await setControl(ports, 'scheduler.armed', true, 'chat');
    expect(result.ok).toBe(true);
    expect(ports.scheduler?.armed).toBe(true);
    expect((await onDisk())?.scheduler?.armed).toBe(true);
    expect(row(ports, 'scheduler.armed')).toMatchObject({ value: true, default: true, source: 'config' });
    await ports.scheduler?.tick();
    const schedule = JSON.parse(await fs.readFile(path.join(dir, 'schedule.json'), 'utf8'));
    expect(schedule).not.toHaveProperty('armed');

    expect(events.query({ code: 'SCHEDULER_ARMED' })).toHaveLength(1);
    // One row for one action: `setArmed` already announced it.
    expect(events.query({ code: 'CONTROL_CHANGED' })).toHaveLength(0);
  });

  it('resets arming to the built-in default and out of the file', async () => {
    const ports = await portsOf();
    await setControl(ports, 'scheduler.armed', true);
    await resetControl(ports, 'scheduler.armed');
    expect(ports.scheduler?.armed).toBe(false);
    expect(ports.scheduler?.snapshot().armed_source).toBe('config');
    expect((await onDisk())?.scheduler).not.toHaveProperty('armed');
  });
});
