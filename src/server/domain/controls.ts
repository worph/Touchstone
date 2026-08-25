/**
 * The controls — what an administrator may change about this instance while it is running,
 * and the only place that knows what each one means.
 *
 * `config.yaml` is loaded once at boot and handed to the services as values, so the
 * Configuration page shows it and refuses to write it (`routes/settings.ts` explains why: a
 * save button there would change a file without changing behaviour). That was the right
 * answer for the file and the wrong answer for the operator, who reasonably wants to say
 * "re-audit every fortnight instead of every week" without an SSH session and a restart.
 *
 * A control is the exception, and the bar for being one is mechanical rather than editorial:
 * **something live has to read the value again later.** `scheduler.fresh_days` is read on
 * every tick, so it qualifies; `runner.agent_url` is captured when the Runner is built, so it
 * does not, and listing it here would recreate exactly the lie the settings page avoids.
 * Nothing enumerates controls anywhere else — the routes, the chat tools and the page all
 * render this array, the same way the chat's catalogue is rendered from `CHAT_TOOLS`.
 *
 * Two rules hold this together:
 *
 * 1. **`config.yaml` stays the default.** An override lives in `state/controls.json`, so
 *    deleting that file returns the instance to what the file asks for. Every row carries
 *    both values and which one is in force, because "why is this 14 when the file says 7"
 *    has to be answerable from the page rather than from a changelog.
 * 2. **A control is not a verdict.** Invariant 6 is about who may write an outcome, and
 *    nothing here writes one: these change *when* and *whether* audits happen, never what
 *    one concluded. `scheduler.armed` and `runner.enabled` are the two safety switches and
 *    are deliberately in the set — a chat that can start one audit but not arm the loop is
 *    an odd place to stop — but each change is a logged event with a `by`, which is what
 *    makes "who turned this off" answerable later.
 */

import type { ControlRow, ControlValue } from '../../shared/controls.js';
import type { TouchstoneConfig } from '../store/config.js';
import type { ControlStore } from '../store/controls.js';
import type { Scheduler } from '../scheduler/index.js';
import type { Runner } from '../runner/index.js';
import type { BenchProber } from '../services/bench.js';
import type { EventLog } from '../services/events.js';

/**
 * The three blocks of `config.yaml` a control can come from.
 *
 * A slice of the real config rather than a copy of its numbers: the defaults a row reports
 * have to be the ones the process actually booted with, and a second literal would drift the
 * first time somebody changed a default in `store/config.ts`.
 */
export type ControlDefaults = Pick<TouchstoneConfig, 'scheduler' | 'runner' | 'bench'>;

export interface ControlPorts {
  /** Where an override is kept. Absent, controls are readable and every write is refused. */
  controls?: ControlStore;
  /** What `config.yaml` said. Absent, a row reports its live value as its own default. */
  defaults?: ControlDefaults;
  scheduler?: Scheduler;
  runner?: Runner;
  prober?: BenchProber;
  events?: EventLog;
}

interface ControlDef {
  key: string;
  label: string;
  group: string;
  kind: 'number' | 'boolean';
  unit?: string;
  min?: number;
  max?: number;
  description: string;
  effect: string;
  /** The live value, or undefined when the object that owns it is not wired up. */
  read: (ports: ControlPorts) => ControlValue | undefined;
  /** What `config.yaml` asked for. Falls back to the live value when there is no config. */
  fallback: (ports: ControlPorts) => ControlValue | undefined;
  /** Put the value into the live object. Called on a write and again after a restart. */
  apply: (ports: ControlPorts, value: ControlValue) => void | Promise<void>;
  /** Drop the runtime override, so the live object returns to the config value. */
  revert: (ports: ControlPorts) => void | Promise<void>;
  /**
   * True when the owning object persists its own override.
   *
   * `scheduler.armed` is the only one: the scheduler has written it to
   * `state/schedule.json` since the Automation page's switch existed, and moving it here
   * would leave two files claiming the same switch with no rule about which wins. So this
   * layer drives it and lets the scheduler keep it — and skips the log line too, because
   * `setArmed` already writes `SCHEDULER_ARMED`.
   */
  ownPersistence?: true;
}

const SCHEDULER = 'Automated mode';
const RUNNER = 'The runner';
const BENCH = 'Demo benches';

/** Scheduler constants, whose setter takes a patch of the same shape. */
function constant(
  key: 'fresh_days' | 'stuck_days' | 'lease_min' | 'cooldown_min' | 'max_tries',
  rest: Omit<ControlDef, 'key' | 'group' | 'kind' | 'read' | 'fallback' | 'apply' | 'revert'>,
): ControlDef {
  return {
    key: `scheduler.${key}`,
    group: SCHEDULER,
    kind: 'number',
    read: (p) => p.scheduler?.constants[key],
    fallback: (p) => p.defaults?.scheduler[key] ?? p.scheduler?.constantsDefault[key],
    apply: (p, v) => p.scheduler?.setConstants({ [key]: Number(v) }),
    revert: (p) => p.scheduler?.clearConstant(key),
    ...rest,
  };
}

export const CONTROLS: ControlDef[] = [
  {
    key: 'scheduler.armed',
    label: 'Automated mode',
    group: SCHEDULER,
    kind: 'boolean',
    description: 'Whether the loop claims apps and dispatches audits, or only decides and logs.',
    effect:
      'Takes effect immediately. Stopping is only "claim nothing further" — an audit already running finishes and records.',
    ownPersistence: true,
    read: (p) => p.scheduler?.armed,
    fallback: (p) => p.defaults?.scheduler.armed ?? p.scheduler?.snapshot().armed_default,
    apply: async (p, v) => {
      await p.scheduler?.setArmed(v === true, 'control');
    },
    revert: async (p) => {
      await p.scheduler?.clearArmed('control');
    },
  },
  {
    key: 'scheduler.tick_min',
    label: 'Decides every',
    group: SCHEDULER,
    kind: 'number',
    unit: 'minutes',
    min: 1,
    max: 1440,
    description: 'How often the loop looks at the backlog and decides whether to start anything.',
    effect: 'Replaces the running timer, so the next decision is at the new cadence.',
    read: (p) => p.scheduler?.tickMinutes,
    fallback: (p) => p.defaults?.scheduler.tick_min,
    apply: (p, v) => p.scheduler?.setTickMinutes(Number(v)),
    revert: (p) => {
      const to = p.defaults?.scheduler.tick_min;
      if (typeof to === 'number') p.scheduler?.setTickMinutes(to);
    },
  },
  constant('cooldown_min', {
    label: 'Waits between audits',
    unit: 'minutes',
    min: 0,
    max: 10_080,
    description: 'How long the loop waits after one audit finishes before starting the next.',
    effect:
      'Applied on the next decision, and to the countdown already showing — it is measured from the last finish, so lowering it can make an audit due at once.',
  }),
  constant('fresh_days', {
    label: 'Re-audits after',
    unit: 'days',
    min: 0,
    max: 365,
    description:
      'How old an app’s last result may be before it re-enters the backlog. The one number that decides whether "continuous" means a carousel or a monthly sweep.',
    effect:
      'Applied on the next decision. Raising it empties the backlog of apps audited more recently than the new figure; lowering it fills it.',
  }),
  constant('stuck_days', {
    label: 'Un-parks after',
    unit: 'days',
    min: 0,
    max: 365,
    description:
      'How long an app that failed its tries is left alone before the loop is allowed to try it again.',
    effect: 'Applied on the next decision, to apps already parked as well as to future ones.',
  }),
  constant('lease_min', {
    label: 'Claim expires after',
    unit: 'minutes',
    min: 5,
    max: 1440,
    description:
      'How long a claim is held before the loop assumes the audit died and reclaims the app.',
    effect:
      'Applied on the next decision. Shorter than a real audit takes and the loop reclaims runs that are still going, which costs the app a try.',
  }),
  constant('max_tries', {
    label: 'Gives up after',
    unit: 'tries',
    min: 1,
    max: 20,
    description:
      'Consecutive errored attempts before an app is parked. Infra conditions do not count — those restore the app untouched.',
    effect: 'Applied on the next decision. Lowering it does not park apps already over the new figure until they fail again.',
  }),
  {
    key: 'runner.enabled',
    label: 'Runner',
    group: RUNNER,
    kind: 'boolean',
    description:
      'Whether audits run at all. A separate switch from automated mode on purpose: it gates hand-run and chat-started audits too.',
    effect:
      'Takes effect on the next job. An audit already in flight finishes and records — the flag is read when a job arrives.',
    read: (p) => p.runner?.enabled,
    fallback: (p) => p.defaults?.runner.enabled ?? p.runner?.enabledDefault,
    apply: (p, v) => p.runner?.setEnabled(v === true),
    revert: (p) => p.runner?.clearEnabled(),
  },
  {
    key: 'runner.busy_backoff_min',
    label: 'Retries a busy agent after',
    group: RUNNER,
    kind: 'number',
    unit: 'minutes',
    min: 0,
    max: 240,
    description:
      'How long to wait before the single retry when the agent answers "busy". n8n waits ten.',
    effect: 'Applied to the next audit that meets a busy agent.',
    read: (p) => p.runner?.busyBackoffMin,
    fallback: (p) => p.defaults?.runner.busy_backoff_min ?? p.runner?.busyBackoffMinDefault,
    apply: (p, v) => p.runner?.setBusyBackoffMin(Number(v)),
    revert: (p) => p.runner?.clearBusyBackoff(),
  },
  {
    key: 'bench.min_remaining_min',
    label: 'Bench needs runway of',
    group: BENCH,
    kind: 'number',
    unit: 'minutes',
    min: 0,
    max: 1440,
    description:
      'How much time a demo instance must have left before a functional audit may claim it. Benches are wiped on a schedule, and an audit that loses its box mid-install records the loss against the app.',
    effect:
      'Applied on the next decision and to the bench gate the Automation page reports right away.',
    read: (p) => p.prober?.minRemainingMin,
    fallback: (p) => p.defaults?.bench.min_remaining_min ?? p.prober?.minRemainingMinDefault,
    apply: (p, v) => p.prober?.setMinRemainingMin(Number(v)),
    revert: (p) => p.prober?.clearMinRemainingMin(),
  },
];

export function controlDef(key: string): ControlDef | undefined {
  return CONTROLS.find((c) => c.key === key);
}

function rowFor(def: ControlDef, ports: ControlPorts): ControlRow | undefined {
  const value = def.read(ports);
  if (value === undefined) {
    // The owning object is not wired up in this build. Still listed, so the page can say so
    // rather than silently showing a shorter list than the documentation describes.
    const fallback = def.fallback(ports);
    if (fallback === undefined) return undefined;
    return { ...describe(def), value: fallback, default: fallback, source: 'config', settable: false };
  }
  const fallback = def.fallback(ports) ?? value;
  // `armed` keeps its override in the scheduler's own file, so the store cannot answer for
  // it; the honest test for every control is the same one — is the live value the file's?
  const overridden = def.ownPersistence
    ? value !== fallback
    : ports.controls?.get(def.key) !== undefined;
  return {
    ...describe(def),
    value,
    default: fallback,
    source: overridden ? 'override' : 'config',
    settable: true,
  };
}

function describe(def: ControlDef): Omit<ControlRow, 'value' | 'default' | 'source' | 'settable'> {
  return {
    key: def.key,
    label: def.label,
    group: def.group,
    kind: def.kind,
    ...(def.unit ? { unit: def.unit } : {}),
    ...(def.min === undefined ? {} : { min: def.min }),
    ...(def.max === undefined ? {} : { max: def.max }),
    description: def.description,
    effect: def.effect,
  };
}

/** Every control, in the order they are declared — which is the order the page renders. */
export function listControls(ports: ControlPorts): ControlRow[] {
  return CONTROLS.map((def) => rowFor(def, ports)).filter((row): row is ControlRow => !!row);
}

export type ControlResult =
  | { ok: true; row: ControlRow; changed: boolean }
  | { ok: false; error: string };

/**
 * Check a value against what the control says it accepts.
 *
 * Returns the coerced value, because the wire hands us whatever JSON carried: a number that
 * arrived as `"14"` is what a person meant, and refusing it teaches nobody anything. What is
 * refused is a value out of range or of the wrong kind, and the message says the range —
 * a caller that is a language model has to be able to fix the call from the refusal alone.
 */
function coerce(def: ControlDef, raw: unknown): { ok: true; value: ControlValue } | { ok: false; error: string } {
  if (def.kind === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (raw === 'true' || raw === 'false') return { ok: true, value: raw === 'true' };
    return { ok: false, error: `${def.key} is a switch — pass true or false.` };
  }
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return { ok: false, error: `${def.key} is a number${def.unit ? ` of ${def.unit}` : ''}.` };
  if (!Number.isInteger(n)) return { ok: false, error: `${def.key} is a whole number${def.unit ? ` of ${def.unit}` : ''}.` };
  if (def.min !== undefined && n < def.min) {
    return { ok: false, error: `${def.key} cannot be below ${def.min}${def.unit ? ` ${def.unit}` : ''}.` };
  }
  if (def.max !== undefined && n > def.max) {
    return { ok: false, error: `${def.key} cannot be above ${def.max}${def.unit ? ` ${def.unit}` : ''}.` };
  }
  return { ok: true, value: n };
}

function unknownControl(key: string): ControlResult {
  return {
    ok: false,
    error: `There is no control called "${key}". These exist: ${CONTROLS.map((c) => c.key).join(', ')}.`,
  };
}

/**
 * Change one control, and record that it changed.
 *
 * The write order is deliberate: apply first, persist second. A setter that throws must not
 * leave a stored override the next boot would apply — the file would then be the only record
 * of a value the process never ran on.
 */
export async function setControl(
  ports: ControlPorts,
  key: string,
  raw: unknown,
  by = 'operator',
): Promise<ControlResult> {
  const def = controlDef(key);
  if (!def) return unknownControl(key);
  if (def.read(ports) === undefined) {
    return { ok: false, error: `${key} cannot be changed here — the part of the app that owns it is not running.` };
  }
  const parsed = coerce(def, raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const before = def.read(ports) as ControlValue;
  if (before === parsed.value) {
    // Already what was asked for. Nothing written and nothing logged: a row in the event log
    // saying a value changed from 14 to 14 is noise in the one place that has to stay
    // readable, and the caller is told plainly instead.
    const row = rowFor(def, ports);
    return row ? { ok: true, row, changed: false } : unknownControl(key);
  }

  await def.apply(ports, parsed.value);
  if (!def.ownPersistence) await ports.controls?.set(key, parsed.value);

  // `armed` is not logged here — `setArmed` already writes SCHEDULER_ARMED, and two rows for
  // one action is how a log stops being read.
  if (!def.ownPersistence) {
    ports.events?.log({
      level: 'info',
      code: 'CONTROL_CHANGED',
      message: `${def.label} is now ${describeValue(def, parsed.value)} (was ${describeValue(def, before)})`,
      detail: { key, from: before, to: parsed.value, by, config_default: def.fallback(ports) ?? parsed.value },
    });
  }
  const row = rowFor(def, ports);
  return row ? { ok: true, row, changed: true } : unknownControl(key);
}

/** Drop the override, back to `config.yaml`. */
export async function resetControl(ports: ControlPorts, key: string, by = 'operator'): Promise<ControlResult> {
  const def = controlDef(key);
  if (!def) return unknownControl(key);
  if (def.read(ports) === undefined) {
    return { ok: false, error: `${key} cannot be changed here — the part of the app that owns it is not running.` };
  }
  const before = def.read(ports) as ControlValue;
  await def.revert(ports);
  await ports.controls?.clear(key);
  const row = rowFor(def, ports);
  const after = def.read(ports) as ControlValue;
  if (before !== after && !def.ownPersistence) {
    ports.events?.log({
      level: 'info',
      code: 'CONTROL_RESET',
      message: `${def.label} is back to what config.yaml says, ${describeValue(def, after)} (was ${describeValue(def, before)})`,
      detail: { key, from: before, to: after, by },
    });
  }
  return row ? { ok: true, row, changed: before !== after } : unknownControl(key);
}

/**
 * Put every stored override back into the live objects — called once, at boot.
 *
 * A value that no longer passes its own check is dropped rather than applied: the ranges are
 * this file's and can tighten, and `state/controls.json` is on a volume an operator can edit.
 * Dropping it silently would be worse than either, so it is logged.
 */
export async function applyStoredControls(ports: ControlPorts): Promise<{ applied: string[] }> {
  const stored = ports.controls?.all() ?? {};
  const applied: string[] = [];
  for (const [key, value] of Object.entries(stored)) {
    const def = controlDef(key);
    const reason = !def
      ? 'no such control'
      : def.read(ports) === undefined
        ? 'nothing to apply it to'
        : ((parsed) => (parsed.ok ? '' : parsed.error))(coerce(def, value));
    if (!def || reason !== '') {
      ports.events?.log({
        level: 'warn',
        code: 'CONTROL_IGNORED',
        message: `A stored setting for ${key} was not applied`,
        detail: { key, value, reason },
      });
      continue;
    }
    await def.apply(ports, value);
    applied.push(key);
  }
  return { applied };
}

function describeValue(def: ControlDef, value: ControlValue): string {
  if (def.kind === 'boolean') return value ? 'on' : 'off';
  return def.unit ? `${value} ${def.unit}` : String(value);
}
