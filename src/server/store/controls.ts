/**
 * The one-shot move of runtime overrides into `config.yaml` (2026-10-27).
 *
 * Until then a control changed from the Settings page lived in `state/controls.json`, and the
 * two `armed` switches in `state/schedule.json` and `state/workshop.json` — each beating the
 * file for ever. `config.yaml` is now the only home of a control (`store/configfile.ts`), so at
 * boot, before the config is read, whatever those three files still hold is written into it.
 * The instance then runs exactly as it did, and the file says why.
 *
 * Idempotent: `controls.json` is renamed `controls.json.migrated` and the two `armed` fields are
 * dropped from their files, so a second boot finds nothing to move.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { ControlValue } from '../../shared/controls.js';
import type { ConfigFile } from './configfile.js';
import { readJson, writeJsonAtomic } from './state.js';

export interface MigratedControl {
  key: string;
  value: ControlValue;
  from: 'controls.json' | 'schedule.json' | 'workshop.json';
}

export interface SkippedControl {
  key: string;
  value: unknown;
  reason: string;
}

export async function migrateStoredControls(opts: {
  stateDir: string;
  config: Pick<ConfigFile, 'set'>;
  /**
   * Why a value cannot be written for this key, or `''` — `controlValueProblem` in
   * `domain/controls.ts`. A refused value is left behind and reported, never written: the file
   * would otherwise boot the instance on a value the page itself refuses.
   */
  problem: (key: string, value: unknown) => string;
}): Promise<{ moved: MigratedControl[]; skipped: SkippedControl[] }> {
  const moved: MigratedControl[] = [];
  const skipped: SkippedControl[] = [];

  const controlsFile = path.join(opts.stateDir, 'controls.json');
  const stored = await readJson<{ controls?: Record<string, unknown> }>(controlsFile, {});
  const rows = stored?.controls && typeof stored.controls === 'object' ? stored.controls : {};
  for (const [key, value] of Object.entries(rows)) {
    // Checked rather than trusted: the file is on a volume an operator can edit.
    const reason = typeof value === 'number' || typeof value === 'boolean' ? opts.problem(key, value) : 'not a number or a switch';
    if (reason !== '') {
      skipped.push({ key, value, reason });
      continue;
    }
    await opts.config.set(key, value as ControlValue);
    moved.push({ key, value: value as ControlValue, from: 'controls.json' });
  }

  for (const [file, key] of [
    ['schedule.json', 'scheduler.armed'],
    ['workshop.json', 'workshop.armed'],
  ] as const) {
    const abs = path.join(opts.stateDir, file);
    const state = await readJson<Record<string, unknown> | null>(abs, null);
    if (!state || !('armed' in state)) continue;
    const armed = state.armed;
    if (typeof armed === 'boolean') {
      await opts.config.set(key, armed);
      moved.push({ key, value: armed, from: file });
    }
    const { armed: _gone, ...rest } = state;
    await writeJsonAtomic(abs, rest);
  }

  // Last, so a failure above leaves the source in place for the next boot to retry.
  await fs.rename(controlsFile, `${controlsFile}.migrated`).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
  return { moved, skipped };
}
