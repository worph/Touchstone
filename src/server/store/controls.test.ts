/**
 * The one-shot move of pre-2026-10-27 overrides into `config.yaml`. What is worth pinning: the
 * instance boots on exactly what it ran on before, a value the controls would refuse is not
 * written, and a second boot finds nothing to move.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { controlValueProblem } from '../domain/controls.js';
import { ConfigFile } from './configfile.js';
import { migrateStoredControls } from './controls.js';

let dir: string;
let stateDir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-migrate-controls-'));
  stateDir = path.join(dir, 'state');
  file = path.join(dir, 'config.yaml');
  await fs.mkdir(stateDir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const json = (name: string, value: unknown) => fs.writeFile(path.join(stateDir, name), JSON.stringify(value));
const read = async (name: string) => JSON.parse(await fs.readFile(path.join(stateDir, name), 'utf8'));
const migrate = () => migrateStoredControls({ stateDir, config: new ConfigFile({ file }), problem: controlValueProblem });

describe('migrateStoredControls', () => {
  /** yunderalabs on 2026-10-27, as found. */
  it('moves every override into config.yaml and clears it from state/', async () => {
    await fs.writeFile(file, '# ops notes\nscheduler:\n  armed: false\n  fresh_days: 7   # a week\nworkshop:\n  delivery: push\n');
    await json('controls.json', { controls: { 'scheduler.fresh_days': 14, 'workshop.auto_submit': true } });
    await json('schedule.json', { armed: true, subjects: { 'yundera~A': {} }, last_finished_at: 'x' });
    await json('workshop.json', { armed: true, proposals: [], memory: {} });

    const { moved, skipped } = await migrate();
    expect(moved.map((m) => `${m.key}=${m.value}`).sort()).toEqual([
      'scheduler.armed=true',
      'scheduler.fresh_days=14',
      'workshop.armed=true',
      'workshop.auto_submit=true',
    ]);
    expect(skipped).toEqual([]);

    const raw = await fs.readFile(file, 'utf8');
    expect(raw).toContain('# ops notes');
    expect(YAML.parse(raw)).toEqual({
      scheduler: { armed: true, fresh_days: 14 },
      workshop: { delivery: 'push', armed: true, auto_submit: true },
    });
    // Everything else in the state files survives; only the switch left.
    expect(await read('schedule.json')).toEqual({ subjects: { 'yundera~A': {} }, last_finished_at: 'x' });
    expect(await read('workshop.json')).toEqual({ proposals: [], memory: {} });
    await expect(fs.stat(path.join(stateDir, 'controls.json'))).rejects.toThrow();
    expect(await read('controls.json.migrated')).toMatchObject({ controls: { 'scheduler.fresh_days': 14 } });
  });

  it('does nothing on the next boot', async () => {
    await json('controls.json', { controls: { 'scheduler.fresh_days': 14 } });
    await json('schedule.json', { armed: true, subjects: {} });
    await migrate();
    const before = await fs.readFile(file, 'utf8');
    expect(await migrate()).toEqual({ moved: [], skipped: [] });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('leaves out a value the control would refuse, and an unknown key, and says so', async () => {
    await json('controls.json', {
      controls: { 'scheduler.fresh_days': 9999, 'scheduler.made_up': 3, 'scheduler.cooldown_min': 'soon', 'bench.min_remaining_min': 90 },
    });
    const { moved, skipped } = await migrate();
    expect(moved).toEqual([{ key: 'bench.min_remaining_min', value: 90, from: 'controls.json' }]);
    expect(skipped.map((s) => s.key).sort()).toEqual(['scheduler.cooldown_min', 'scheduler.fresh_days', 'scheduler.made_up']);
    expect(YAML.parse(await fs.readFile(file, 'utf8'))).toEqual({ bench: { min_remaining_min: 90 } });
  });

  it('is a no-op on an instance that never had an override', async () => {
    await json('schedule.json', { subjects: {} });
    expect(await migrate()).toEqual({ moved: [], skipped: [] });
    await expect(fs.stat(file)).rejects.toThrow();
  });
});
