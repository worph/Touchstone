/**
 * Controls — the configuration an operator may change **while Touchstone is running**.
 *
 * `config.yaml` is read once at boot and handed to the services as values, which is why
 * `routes/settings.ts` serves it read-only and says so: a save button there would change a
 * file without changing behaviour. A *control* is the deliberate exception — one value whose
 * owner is a live object with a setter, so writing it takes effect on the next tick rather
 * than on the next restart.
 *
 * The set is small and closed on purpose. A control has to be a value something reads *again*
 * later; anything read once at construction (a root directory, the agent's address) is not
 * one, and pretending otherwise is the lie the settings page already refuses to tell.
 *
 * Every control keeps its `config.yaml` value as `default`: an override lives in
 * `state/controls.json`, so deleting that file returns the instance to what the file asks
 * for — the same relationship `state/schedule.json`'s `armed` has, and for the same reason.
 */

export type ControlValue = number | boolean;

export type ControlKind = 'number' | 'boolean';

export interface ControlRow {
  /** `scheduler.fresh_days` — the path in `config.yaml`, so the two names never diverge. */
  key: string;
  /** A person's name for it, for the page. */
  label: string;
  /** Which block of the app it belongs to: the loop, the runner, the benches. */
  group: string;
  kind: ControlKind;
  /** `days`, `minutes`, `tries` — rendered after the number, never parsed. */
  unit?: string;
  /** What the running process is using right now. */
  value: ControlValue;
  /** What `config.yaml` says, which is what a fresh boot falls back to. */
  default: ControlValue;
  /** Whether the live value came from the file or from someone changing it here. */
  source: 'config' | 'override';
  min?: number;
  max?: number;
  /** One sentence: what the number means. */
  description: string;
  /** One sentence: what changes when it changes, and when it takes effect. */
  effect: string;
  /**
   * False when the thing that owns this value is not wired up in this build.
   *
   * The row is still listed — "there is no scheduler here" is a better answer than a control
   * that silently vanishes — but a write is refused rather than accepted and dropped.
   */
  settable: boolean;
}

export interface ControlsResponse {
  controls: ControlRow[];
  /** Where an override is kept, so the page can say how to undo every one of them at once. */
  file: string | null;
}
