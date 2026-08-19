/**
 * Configuration: `data/config.yaml` plus `data/standards/*.yaml`.
 *
 * Both are optional. Touchstone has to run on a laptop straight after `git clone`, so every
 * value has a default and an absent file is a normal state, not a degraded one. Only the
 * things that genuinely cannot be guessed — bench credentials, notification routing — have
 * no default.
 *
 * From P2 the file is also *seeded* on first boot (`ensureConfigFile`), because the moment
 * something needs a credential, "there is no file and you have to know what to write in it"
 * stops being a defensible default. The seeded file is inert: every value in it equals the
 * built-in default, the scheduler is disarmed and the runner is disabled, so writing it
 * changes nothing about what the app does.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import YAML from 'yaml';

import type { Severity } from '../../shared/types.js';

/** Repo root, resolved from this file so cwd never matters. */
export const REPO_ROOT = fileURLToPath(new NodeURL('../../../', import.meta.url));

export interface Standard {
  id: string;
  name: string;
  version: number;
  leg: 'static' | 'functional';
  /** `depth` to pass the assay agent. Static runs one leaf; `full` runs both. */
  depth: 'static' | 'full';
  /** Docmost slugs the agent fetches the rubric from. Touchstone never copies it. */
  source: { orchestrator?: string; protocol?: string };
  /** Anything else the file declares — bench selection policy, and whatever comes next. */
  [key: string]: unknown;
}

/**
 * One demo instance a functional assay can install into.
 *
 * Normally empty: the pool is *discovered* from `bench.pool_url`, because the instances are
 * wiped daily and n8n's own prompt forbids hardcoding a host. This list is an override for
 * testing against a fixed box. No credentials — the demo gate is OIDC and issues a session
 * without asking for a password, which `services/bench.ts` explains.
 */
export interface BenchEntry {
  name: string;
  url: string;
  enabled?: boolean;
}

export interface OutletEntry {
  kind: 'telegram' | 'discord';
  target?: string;
  label?: string;
  enabled?: boolean;
}

export interface TouchstoneConfig {
  dataDir: string;
  reportsRoot: string;
  stateDir: string;
  standardsDir: string;
  /** Where the importer reads from. */
  docmost: {
    beaconUrl: string;
    rollupSlug: string;
    /** Raw pages are cached here so a re-import is offline and cheap. */
    cacheDir: string;
  };
  standards: {
    static: { name: string; version: number };
    functional: { name: string; version: number };
  };
  /**
   * The five constants of `Pick next target`, at the values n8n runs today. P3 ports the
   * scheduler against these; changing one here changes both systems' behaviour to differ,
   * which is precisely what shadow mode is there to detect.
   */
  scheduler: {
    /** Off. P3 ships dry-run; this flag is what arms it, and it stays false until reviewed. */
    armed: boolean;
    tick_min: number;
    fresh_days: number;
    stuck_days: number;
    lease_min: number;
    cooldown_min: number;
    max_tries: number;
  };
  /** Off. P4 ships the runner disabled; validation is a single hand-run assay, never a loop. */
  runner: {
    enabled: boolean;
    depth: 'static' | 'full';
  };
  benches: BenchEntry[];
  bench: {
    /** The pool API the roster is discovered from. Empty disables discovery. */
    pool_url: string;
    /** The human-readable board, linked from the UI. Never read as a gate. */
    board_url: string;
    /** Runway a bench needs before a functional assay may claim it — n8n's `> 1h` rule. */
    min_remaining_min: number;
    probe_interval_min: number;
    probe_timeout_ms: number;
  };
  importer: {
    enabled: boolean;
    interval_min: number;
  };
  notify: {
    outlets: OutletEntry[];
    /** Contact address on the VAPID JWT. Push services reject a missing or bogus one. */
    push_subject: string;
  };
  [key: string]: unknown;
}

function defaults(dataDir: string): TouchstoneConfig {
  return {
    dataDir,
    reportsRoot: path.join(dataDir, 'reports'),
    stateDir: path.join(dataDir, 'state'),
    standardsDir: path.join(dataDir, 'standards'),
    docmost: {
      beaconUrl: process.env.TOUCHSTONE_BEACON_URL ?? 'http://localhost:3000/mcp/',
      rollupSlug: process.env.TOUCHSTONE_ROLLUP_SLUG ?? 'B5ZBicxRSn',
      cacheDir: path.join(dataDir, 'cache', 'docmost'),
    },
    standards: {
      static: { name: 'Static Review Protocol', version: 3 },
      functional: { name: 'Functional Review Protocol', version: 2 },
    },
    scheduler: {
      armed: false,
      tick_min: 60,
      fresh_days: 7,
      stuck_days: 7,
      lease_min: 120,
      cooldown_min: 55,
      max_tries: 3,
    },
    runner: { enabled: false, depth: 'full' },
    benches: [],
    bench: {
      pool_url: process.env.TOUCHSTONE_POOL_URL ?? 'https://app.nasselle.com/demo/api/demos',
      board_url: process.env.TOUCHSTONE_BOARD_URL ?? 'https://app.nasselle.com/demo/admin/manage',
      min_remaining_min: 60,
      probe_interval_min: 5,
      probe_timeout_ms: 8000,
    },
    importer: { enabled: true, interval_min: 15 },
    notify: { outlets: [], push_subject: 'mailto:touchstone@yundera.local' },
  };
}

/** Shallow-merge a parsed YAML object over the defaults, one level into plain objects. */
function merge<T extends Record<string, unknown>>(base: T, over: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === null || v === undefined) continue;
    const cur = out[k];
    if (isPlainObject(cur) && isPlainObject(v)) out[k] = merge(cur, v);
    else out[k] = v;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function resolveDataDir(dataDir?: string): string {
  return path.resolve(dataDir ?? process.env.TOUCHSTONE_DATA_DIR ?? path.join(REPO_ROOT, 'data'));
}

/** Load `<dataDir>/config.yaml`, falling back to defaults when it is absent or empty. */
export async function loadConfig(dataDir?: string): Promise<TouchstoneConfig> {
  const dir = resolveDataDir(dataDir);
  const base = defaults(dir);
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, 'config.yaml'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return base;
  }
  const parsed = YAML.parse(raw) as unknown;
  if (!isPlainObject(parsed)) return base;
  const cfg = merge(base, parsed);
  // Paths in config.yaml may be relative to the data dir.
  cfg.reportsRoot = path.resolve(dir, cfg.reportsRoot);
  cfg.stateDir = path.resolve(dir, cfg.stateDir);
  cfg.standardsDir = path.resolve(dir, cfg.standardsDir);
  cfg.docmost.cacheDir = path.resolve(dir, cfg.docmost.cacheDir);
  return cfg;
}

/**
 * Load every `*.yaml` under the standards dir.
 *
 * A standard is a pointer and a version, not a copy of the rubric: the assay agent fetches
 * the protocol from Docmost at run time, and holding a second copy here would only be a
 * second thing to drift. What Touchstone needs is the version, because every assay records
 * which version judged it (ARCHITECTURE.md principle 6).
 *
 * An absent directory yields an empty list rather than an error — the read API works fine
 * without it; only the runner needs a standard.
 */
export async function loadStandards(standardsDir: string): Promise<Standard[]> {
  let names: string[];
  try {
    names = (await fs.readdir(standardsDir)).filter((n) => /\.ya?ml$/i.test(n)).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return [];
  }
  const out: Standard[] = [];
  for (const name of names) {
    const parsed = YAML.parse(await fs.readFile(path.join(standardsDir, name), 'utf8')) as unknown;
    if (!isPlainObject(parsed)) continue;
    const leg = parsed.leg === 'functional' ? 'functional' : 'static';
    out.push({
      ...parsed,
      id: String(parsed.id ?? name.replace(/\.ya?ml$/i, '')),
      name: String(parsed.name ?? parsed.id ?? name),
      version: Number(parsed.version ?? 1),
      leg,
      depth: parsed.depth === 'full' ? 'full' : 'static',
      source: isPlainObject(parsed.source) ? (parsed.source as Standard['source']) : {},
    });
  }
  return out;
}

/**
 * The seeded `data/config.yaml`.
 *
 * Written verbatim, comments and all, because the comments *are* the interface: this file
 * is how an operator learns that the scheduler exists and is off, and that a bench needs
 * credentials before a functional assay can run. Every value here equals the default in
 * `defaults()`, so seeding is a no-op behaviourally — deleting the file leaves the app
 * running identically.
 */
export const CONFIG_TEMPLATE = `# Touchstone configuration.
#
# Seeded on first boot. Every value below is the built-in default, so deleting this file
# changes nothing — it exists so the settings that DO need you (bench credentials, notify
# outlets) have an obvious place to go.

# ── the scheduler ───────────────────────────────────────────────────────────────────────
# The five constants of n8n's \`Pick next target\`, at the values it runs today. Do not
# change them while shadow mode is being compared against the live loop.
scheduler:
  # Dry-run until this is true: the scheduler decides and logs, and dispatches nothing.
  armed: false
  tick_min: 60
  fresh_days: 7      # a verdict older than this makes the subject eligible again
  stuck_days: 7      # how long a subject that exhausted its tries stays parked
  lease_min: 120     # an in-progress claim expires after this
  cooldown_min: 55   # minimum gap between finishing one assay and starting the next
  max_tries: 3       # consecutive errored attempts before parking

# ── the runner ──────────────────────────────────────────────────────────────────────────
# Disabled until reviewed. Two systems auditing the same app contend for one Claude Code
# endpoint — n8n's PR Review workflow shares it and is not being replaced.
runner:
  enabled: false
  depth: full        # static | full

# ── benches ──────────────────────────────────────────────────────────────────
# The demo instances a functional assay installs into. Leave this EMPTY: the pool is
# discovered from \`bench.pool_url\` below, because the instances are wiped daily and n8n's
# own prompt forbids hardcoding a host — "one mid-cleanup still serves a login page but
# silently fails to install". Fill it in only to pin a fixed box for testing.
benches: []
# benches:
#   - name: demostaging1
#     url: https://demostaging1.inojob.com

bench:
  # The pool API behind the management board — the machine-readable half of the source the
  # n8n agent is told to read. Empty disables discovery, leaving only \`benches\` above.
  pool_url: https://app.nasselle.com/demo/api/demos
  # The same board a person opens. Linked from the UI, and its claim is shown beside our
  # own probe: it reported "Ready" for the whole of the 2026-08-05 outage, so Touchstone
  # displays the disagreement rather than trusting either source.
  board_url: https://app.nasselle.com/demo/admin/manage
  # A functional assay may not claim a bench with less runway than this. n8n requires more
  # than an hour so the daily cleanup cannot wipe a run mid-audit — a full run includes an
  # uninstall-then-reinstall. Shorter than the assay is worse than no bench at all.
  min_remaining_min: 60
  probe_interval_min: 5
  probe_timeout_ms: 8000

# ── the transitional data feed ──────────────────────────────────────────────────────────
# n8n still owns the loop and rewrites its Docmost roll-up every tick, so re-reading it is
# how Touchstone stays current with ZERO changes to n8n. Turn this off once P3 is armed.
importer:
  enabled: true
  interval_min: 15

# ── notification ────────────────────────────────────────────────────────────────────────
# Outlets go through the local Beacon aggregator. \`target\` is a Telegram chat id or a
# Discord channel id; omit it to use the bridge's own default destination.
notify:
  outlets: []
  # outlets:
  #   - kind: telegram
  #     label: ops
  #     target: ""
  push_subject: mailto:touchstone@yundera.local
`;

/**
 * Write `data/config.yaml` if it is not there. Returns the path when it seeded one.
 *
 * Uses `wx`, so two processes racing at boot cannot produce a half-written file or clobber
 * an operator's edits — an existing file is never touched, whatever is in it.
 */
export async function ensureConfigFile(dataDir?: string): Promise<string | null> {
  const dir = resolveDataDir(dataDir);
  const file = path.join(dir, 'config.yaml');
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(file, CONFIG_TEMPLATE, { encoding: 'utf8', flag: 'wx' });
    return file;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    // A read-only data dir is a real deployment (a mounted archive), and the app runs fine
    // on defaults, so this is reported by the caller rather than thrown at boot.
    throw err;
  }
}
