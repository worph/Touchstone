/**
 * Where a control's override is kept: `state/controls.json`.
 *
 * Small and dumb on purpose. It holds values by key and knows nothing about what they mean —
 * the meaning, the range and the live object each one drives are `domain/controls.ts`'s.
 * That split is what lets a new control be one entry in an array rather than a new field
 * here, a new column on the wire and a migration for the file.
 *
 * Under `state/` because it is regenerable in the only sense that matters: deleting it
 * returns the instance to `config.yaml`, which is the documented way to undo every override
 * at once. It is the same bargain `state/schedule.json` makes with `armed`, and `armed`
 * deliberately stays there rather than moving here — the scheduler already persists it, and
 * two files claiming the same switch is how they come to disagree.
 */

import path from 'node:path';

import type { ControlValue } from '../../shared/controls.js';
import { readJson, writeJsonAtomic } from './state.js';

interface ControlsFile {
  controls: Record<string, ControlValue>;
}

export class ControlStore {
  readonly file: string;
  private values: Record<string, ControlValue> = {};

  constructor(opts: { stateDir: string }) {
    this.file = path.join(opts.stateDir, 'controls.json');
  }

  async load(): Promise<void> {
    const stored = await readJson<ControlsFile>(this.file, { controls: {} });
    const rows = stored?.controls;
    if (!rows || typeof rows !== 'object') return;
    // Filtered on read rather than trusted: the file is on a volume an operator can edit,
    // and a string where a number belongs would otherwise reach a setter as one.
    for (const [key, value] of Object.entries(rows)) {
      if (typeof value === 'number' || typeof value === 'boolean') this.values[key] = value;
    }
  }

  all(): Record<string, ControlValue> {
    return { ...this.values };
  }

  get(key: string): ControlValue | undefined {
    return this.values[key];
  }

  async set(key: string, value: ControlValue): Promise<void> {
    this.values[key] = value;
    await this.persist();
  }

  /** Forget the override, so the value falls back to what `config.yaml` says. */
  async clear(key: string): Promise<void> {
    if (!(key in this.values)) return;
    delete this.values[key];
    await this.persist();
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.file, { controls: this.values } satisfies ControlsFile);
  }
}
