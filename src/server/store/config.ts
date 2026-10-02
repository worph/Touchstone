/**
 * Configuration: `data/config.yaml`.
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

import { DEFAULT_ORIGIN } from '../../shared/subject.js';
import { DEFAULT_TARGET } from '../../shared/target.js';
import type { Severity } from '../../shared/types.js';

/** Repo root, resolved from this file so cwd never matters. */
export const REPO_ROOT = fileURLToPath(new NodeURL('../../../', import.meta.url));

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

/** Re-exported so config readers need not know which module owns it. */
export { DEFAULT_TARGET };

/**
 * One **target** — a platform an app is audited on, and the pool of instances that serves it.
 *
 * This is the axis the archive was missing. A capability (`bench`, `browser`) says *what kind of
 * resource* a section needs; a target says *which platform the verdict is about*, which is a
 * property of the finding rather than of the machine. Until 2026-09-18 one string was both, plus
 * the pool as well, and the code had to sniff a `bench.` prefix to tell them apart.
 *
 * A target owns a **bench** pool. `browsers:` stays global: a sidecar drives whatever host it is
 * pointed at, so there is nothing platform-shaped about it. If one ever is, `targets[].browsers`
 * is where it goes.
 */
export interface TargetEntry {
  /** Stable, and load-bearing: it names the state file, the alert keys and every assay's `target`. */
  id: string;
  /** Shown wherever a column or a pool is named. Defaults to the id. */
  label?: string;
  /**
   * Where this target's instances come from.
   *
   * `pool_url` discovers them (the demo pool is wiped daily, so a hardcoded host goes stale);
   * `benches` pins them. A pinned box has no cleanup countdown to read, which `isLeasable`
   * already treats as claimable, so such a target wants `min_remaining_min: 0`.
   */
  pool?: {
    pool_url?: string;
    board_url?: string;
    min_remaining_min?: number;
    benches?: BenchEntry[];
  };
}

/** One target, with every default resolved — what the probers and the routes are handed. */
export interface ResolvedTarget {
  id: string;
  label: string;
  pool_url: string;
  board_url: string;
  min_remaining_min: number;
  benches: BenchEntry[];
  /** `state/benches.json` for the default target, so an existing roster is not orphaned. */
  state_file: string;
}

/**
 * The targets this installation audits on, defaults resolved and back-compatibility applied.
 *
 * `config.yaml` is hand-edited on live volumes, so **"no `targets:` key" has to keep meaning
 * exactly what it meant before there was one**: a single platform, described by `bench.pool_url`
 * and friends, with the top-level `benches:` list as its override. That is not a migration —
 * nothing is rewritten — it is the absent case having a definition.
 *
 * The **first entry is the default target**, and it is the one whose sections keep their bare
 * ids and whose roster keeps `state/benches.json`.
 */
export function targets(cfg: TouchstoneConfig): ResolvedTarget[] {
  const declared = cfg.targets ?? [];
  const entries: TargetEntry[] = declared.length > 0 ? declared : [{ id: DEFAULT_TARGET }];

  return entries.map((target, i) => {
    const isDefault = i === 0;
    const pool = target.pool ?? {};
    return {
      id: target.id,
      label: target.label ?? target.id,
      // The top-level `bench:` fields describe the default target and nothing else. A second
      // target that inherited `pool_url` would discover the *demo* roster and lease a Yundera
      // box for a FOSS audit — a report naming a real host, carrying a real verdict, about the
      // wrong platform, and indistinguishable from a correct one.
      pool_url: pool.pool_url ?? (isDefault ? cfg.bench.pool_url : ''),
      board_url: pool.board_url ?? (isDefault ? cfg.bench.board_url : ''),
      min_remaining_min: pool.min_remaining_min ?? cfg.bench.min_remaining_min,
      benches: pool.benches ?? (isDefault ? cfg.benches : []),
      // Positional rather than keyed on the id: an operator who lists the demo pool explicitly
      // and calls it something else is still describing the roster already on disk, and
      // orphaning it would drop every `healthy_at` across the upgrade.
      state_file: isDefault ? 'benches.json' : `benches.${target.id}.json`,
    };
  });
}

/**
 * One app store Touchstone audits — a repo, a ref, and the directory the apps live in.
 *
 * This is the thing that was five hardcoded strings until 2026-08-20. Several may be listed;
 * subjects are then identified as `<id>~<name>` and their reports live under `reports/<id>/`.
 *
 * `id` is not free-form for the default entry: `DEFAULT_ORIGIN` is a **code** constant because
 * a report written before origins existed has its `origin` filled in on read, so renaming the
 * default would re-interpret the whole legacy archive. An origin with that id must exist, and
 * `resolveOrigins` below enforces it.
 */
export interface OriginEntry {
  id: string;
  /** `owner/name` on GitHub. */
  repo: string;
  /** The branch or tag audited, and the one recorded in every assay's `subject_ref`. */
  ref: string;
  /** Where the apps live in that repo. `Apps` in the Yundera store. */
  apps_path: string;
  /**
   * A cold-start list for this store, used only until the contents API answers once.
   *
   * The Yundera store's list is `DEFAULT_APPS` in `store/registry.ts` and deliberately stays
   * in code: that file's own comment explains that it is a copy of what n8n falls back to and
   * that a difference in it is a difference in what the two systems audit. This field is for
   * *other* origins, and for overriding.
   */
  seed?: string[];
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
  /** The app stores audited. Never empty — see `resolveOrigins`. */
  origins: OriginEntry[];
  reportsRoot: string;
  /**
   * Where trials are written — `<dataDir>/trials`.
   *
   * A sibling of `reports/`, never inside it: the report index scans `reports/**` and anything
   * under it becomes a subject the scheduler can pick.
   */
  trialsRoot: string;
  /**
   * Where an upload session's files are written — `<dataDir>/uploads`.
   *
   * A sibling of `trials/` rather than a child, for the same reason `trials/` is a sibling of
   * `reports/`: a trial's own directory is scanned as a report tree, so a workspace of app
   * source underneath one would be read as assay files that failed to parse.
   */
  uploadsRoot: string;
  stateDir: string;
  /** The rubric, as local markdown Touchstone owns and edits — and what versions itself. */
  protocolsDir: string;
  /**
   * The knowledge base: reference material handed to the agent beside the rubric.
   *
   * A sibling of `protocols/` rather than a folder inside it — the protocol directory is
   * scanned for sections and for executors, and a page that is neither has no business being
   * read by that scan. See `store/kb.ts`.
   */
  kbDir: string;
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
    /** Minutes to wait before the single retry when the agent answers 409. n8n waits 10. */
    busy_backoff_min: number;
    /**
     * Where the agent lives. The default is the address n8n posts to from inside the
     * yunderalabs stack; anywhere else — a dev container, a laptop — has to say so, and
     * reaching it through a Beacon aggregator means naming the namespaced tool too.
     */
    agent_url: string;
    agent_tool: string;
    /** `direct` as n8n calls it, or `beacon` to go through an aggregator's `call` tool. */
    agent_via: 'direct' | 'beacon';
    /**
     * How the agent reaches *us* to record requirements as it works.
     *
     * This is the one place the dependency arrow points inward, so it is named rather than
     * guessed: an agent that cannot reach it simply does not report incrementally, and the
     * run falls back to the single JSON blob at the end.
     */
    callback_url: string;
  };
  /**
   * The browser sidecars the functional leg drives — row D6.
   *
   * Ours, not the shared box-wide one: that browser is busy with other work and an audit
   * whose tab was stolen mid-install records the theft against the app. One entry per
   * functional worker; the pool is bounded by the bench pool in practice.
   */
  browsers: { name: string; url: string; enabled?: boolean }[];
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
  /**
   * **The platforms an app is audited on.** One entry per target; the first is the default.
   *
   * Absent — which is every installation before this existed, and every one that only ever
   * audits on Yundera — means the `bench:` block above describes the single target, and
   * `targets()` synthesises exactly that. So an untouched `config.yaml` boots identically and
   * nothing on a volume has to be edited to keep working.
   *
   * Top-level rather than under `bench:` because a target is not a bench setting: it is the
   * axis a verdict is about, and the pool that serves it is one of its properties.
   */
  targets?: TargetEntry[];
  /**
   * The operator's tools, served over MCP at `/api/v1/mcp/admin` — `routes/mcp-admin.ts`.
   *
   * Off, and off is the honest default: it is meant to sit behind a beaconify sidecar and be
   * aggregated by a Beacon that has no identity model, so enabling it is a statement about
   * the box rather than about Touchstone. Disabled, the route is not registered at all.
   */
  admin_mcp: {
    enabled: boolean;
    /** Bearer, checked when set. Beaconify can inject it with `BEACONIFY_AUTH`. */
    token: string;
    /** Serve only the tools that report. `run_assay` is the one this drops. */
    read_only: boolean;
  };
  /**
   * Upload sessions — the files a trial audits when there is no ref to fetch them from.
   *
   * The caps are the whole of the local risk assessment. What an upload can *do* was settled
   * elsewhere (a bench is a shared, publicly reachable demo instance with published
   * credentials, so an uploaded compose grants nothing an anonymous visitor lacked); what it
   * costs is bytes on Touchstone's own disk, on the box that is also running the audits.
   */
  /**
   * Trials, and the one thing a trial cannot work out for itself.
   *
   * A trial saves the archive it audited and serves it back for a bench to install, which is
   * what makes the bytes judged and the bytes running the same thing. The bench fetches it
   * **over the public internet**, so Touchstone has to know its own external address, and it
   * cannot infer one: the request that starts a trial arrives on the internal network under a
   * service name no bench can resolve.
   *
   * Empty means trials stay static-only. Since 2026-08-22 that is the **only** reason a trial
   * is not a full audit — it is recorded `store_url_unconfigured` and the blocked report names
   * this setting, rather than describing a limitation of trials.
   */
  trials: {
    /** e.g. `https://touchstone-yunderalabs.nsl.sh`. No trailing slash. */
    public_base_url: string;
  };
  uploads: {
    /** Refused past this, per file. */
    max_file_bytes: number;
    /** Refused past this, summed over one session. */
    max_total_bytes: number;
    /** How long a session stays writable, and how long its files survive. */
    ttl_min: number;
  };
  /**
   * The GitHub identity the **workshop** opens pull requests as — `services/github.ts`.
   *
   * A fine-grained token on the origin's organisation, pushing to `touchstone/…` branches of
   * the origin repo itself (no fork: a fine-grained token cannot open a PR on a repo owned by
   * somebody else). Empty means the workshop is unconfigured and nothing it does can reach
   * GitHub. Never handed to an agent — see docs/auto-app-pr.md §3.
   */
  github: {
    /** `TOUCHSTONE_GITHUB_TOKEN` when unset here. Masked by `redactConfig` (key name). */
    token: string;
    /** The account the token must belong to. A token for anybody else is an alert. */
    login: string;
    /** Commit author name — D8: the person is accountable, the name says a machine wrote it. */
    commit_name: string;
    /** Empty means the account's noreply address. */
    commit_email: string;
  };
  /**
   * The workshop: proposals to fix, update or add an app, validated by trials and opened as
   * pull requests — docs/auto-app-pr.md. Every number here is a default a control overrides.
   */
  workshop: {
    /** The origin that receives pull requests. No other origin is ever proposed against. */
    origin: string;
    /** Safety switch, default off — automatic selection and submission. */
    armed: boolean;
    /** D2: at most this many PRs opened in any rolling 24 hours. 0 is a dry run. */
    prs_per_day: number;
    /** Authoring + validation rounds before a proposal is given up. */
    max_rounds: number;
    /** Hard limit on one authoring session. */
    session_minutes: number;
    /**
     * The reading that measures image currency — what a `currency` proposal is about. Named
     * rather than recognised, because nothing in code may enumerate sections (invariant 2).
     * Empty disables currency proposals.
     */
    currency_section: string;
  };
  /** Proposal working copies and their evidence — `<dataDir>/workshop`. */
  workshopDir: string;
  /** The operator's wishlist — `<dataDir>/wishlist/*.md`, one file per wish. */
  wishlistDir: string;
  notify: {
    outlets: OutletEntry[];
    /**
     * The Beacon aggregator the outlets are reached through. It lived under `docmost:` until
     * 2026-08-19, which was only ever an accident of what was built first — notifications and
     * the wiki share nothing but a transport.
     */
    beacon_url: string;
    /** Contact address on the VAPID JWT. Push services reject a missing or bogus one. */
    push_subject: string;
  };
  [key: string]: unknown;
}

function defaults(dataDir: string): TouchstoneConfig {
  return {
    dataDir,
    origins: [{ id: DEFAULT_ORIGIN, repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' }],
    reportsRoot: path.join(dataDir, 'reports'),
    trialsRoot: path.join(dataDir, 'trials'),
    uploadsRoot: path.join(dataDir, 'uploads'),
    stateDir: path.join(dataDir, 'state'),
    protocolsDir: path.join(dataDir, 'protocols'),
    kbDir: path.join(dataDir, 'kb'),
    workshopDir: path.join(dataDir, 'workshop'),
    wishlistDir: path.join(dataDir, 'wishlist'),
    scheduler: {
      armed: false,
      tick_min: 60,
      fresh_days: 14,
      stuck_days: 7,
      lease_min: 120,
      cooldown_min: 55,
      max_tries: 3,
    },
    runner: {
      enabled: false,
      busy_backoff_min: 10,
      agent_url: process.env.TOUCHSTONE_AGENT_URL ?? 'http://beacon-backend:9300/mcp',
      agent_tool: process.env.TOUCHSTONE_AGENT_TOOL ?? 'claude-code__query_claude',
      agent_via: process.env.TOUCHSTONE_AGENT_VIA === 'beacon' ? 'beacon' : 'direct',
      callback_url: process.env.TOUCHSTONE_CALLBACK_URL ?? 'http://touchstone:8080/api/v1/mcp',
    },
    browsers: process.env.TOUCHSTONE_BROWSER_URL
      ? [{ name: 'browser-1', url: process.env.TOUCHSTONE_BROWSER_URL }]
      : [{ name: 'browser-1', url: 'http://touchstone-browser:9746/mcp' }],
    benches: [],
    bench: {
      pool_url: process.env.TOUCHSTONE_POOL_URL ?? 'https://app.nasselle.com/demo/api/demos',
      board_url: process.env.TOUCHSTONE_BOARD_URL ?? 'https://app.nasselle.com/demo/admin/manage',
      min_remaining_min: 60,
      probe_interval_min: 5,
      probe_timeout_ms: 8000,
    },
    admin_mcp: {
      // `on`, `1`, `true` — anything else, including absent, is off.
      enabled: /^(on|1|true|yes)$/i.test(process.env.TOUCHSTONE_ADMIN_MCP ?? ''),
      token: process.env.TOUCHSTONE_ADMIN_MCP_TOKEN ?? '',
      read_only: /^(on|1|true|yes)$/i.test(process.env.TOUCHSTONE_ADMIN_MCP_READ_ONLY ?? ''),
    },
    trials: {
      public_base_url: (process.env.TOUCHSTONE_PUBLIC_BASE_URL ?? '').replace(/\/+$/, ''),
    },
    uploads: {
      max_file_bytes: 2 * 1024 * 1024,
      max_total_bytes: 8 * 1024 * 1024,
      ttl_min: 120,
    },
    github: {
      token: process.env.TOUCHSTONE_GITHUB_TOKEN ?? '',
      login: process.env.TOUCHSTONE_GITHUB_LOGIN ?? '',
      commit_name: 'Mael (Touchstone)',
      commit_email: '',
    },
    workshop: {
      origin: DEFAULT_ORIGIN,
      armed: false,
      prs_per_day: 1,
      max_rounds: 3,
      session_minutes: 90,
      currency_section: 'currency',
    },
    notify: {
      outlets: [],
      beacon_url: process.env.TOUCHSTONE_BEACON_URL ?? 'http://localhost:3000/mcp/',
      push_subject: 'mailto:touchstone@yundera.local',
    },
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
  cfg.trialsRoot = path.resolve(dir, cfg.trialsRoot);
  cfg.uploadsRoot = path.resolve(dir, cfg.uploadsRoot);
  cfg.workshopDir = path.resolve(dir, cfg.workshopDir);
  cfg.wishlistDir = path.resolve(dir, cfg.wishlistDir);
  cfg.stateDir = path.resolve(dir, cfg.stateDir);
  cfg.origins = resolveOrigins(cfg.origins);
  return cfg;
}

/**
 * `Yundera/AppStore@main:Apps/OpenClaw` — the one string that says exactly what was judged.
 *
 * `domain/fixreport.ts` already parses this back into its three parts, and the subject page
 * prints it verbatim, so it has been the archive's record of provenance since before origins
 * existed. It was *defaulted* until 2026-08-20 and is now *written*: with several stores, a
 * report that does not name its own repo and ref cannot be checked against anything.
 */
export function subjectRefOf(origin: OriginEntry, subject: string): string {
  const path = origin.apps_path.replace(/^\/+|\/+$/g, '');
  return `${origin.repo}@${origin.ref}:${path}/${subject}`;
}

/**
 * Normalise `origins:`, and guarantee the default one survives.
 *
 * `merge()` above replaces arrays **wholesale** rather than merging them element-wise — which
 * is right for `benches` and `outlets`, and a trap here. An operator adding a second store by
 * writing `origins: [{id: acme, ...}]` would otherwise silently *delete* the Yundera origin,
 * and because `DEFAULT_ORIGIN` is what every pre-existing report resolves to, the entire
 * archive would become subjects of a store that is no longer configured: unschedulable, and
 * quietly so. Re-adding it is a better answer than failing to boot, because the archive keeps
 * working either way; what matters is that the situation is impossible rather than silent.
 *
 * Also drops entries that are disabled or too incomplete to fetch from, so a half-written
 * entry cannot produce a registry that reads as "backlog empty".
 */
export function resolveOrigins(raw: unknown): OriginEntry[] {
  const list = Array.isArray(raw) ? (raw as Partial<OriginEntry>[]) : [];
  const out: OriginEntry[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const id = String(entry?.id ?? '').trim();
    const repo = String(entry?.repo ?? '').trim();
    if (!id || !repo || entry?.enabled === false || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      repo,
      ref: String(entry?.ref ?? 'main').trim() || 'main',
      apps_path: String(entry?.apps_path ?? 'Apps').trim() || 'Apps',
      ...(Array.isArray(entry?.seed) ? { seed: entry.seed.map(String) } : {}),
    });
  }
  if (!seen.has(DEFAULT_ORIGIN)) {
    out.unshift({ id: DEFAULT_ORIGIN, repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' });
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
export function configTemplate(cfg: TouchstoneConfig): string {
  const origin = cfg.origins[0]!;
  const browser = cfg.browsers[0];
  return `# Touchstone configuration.
#
# Seeded on first boot. Every value below is the built-in default, so deleting this file
# changes nothing — it exists so the settings that DO need you (bench credentials, notify
# outlets) have an obvious place to go.

# ── the stores ──────────────────────────────────────────────────────────────────────────
# What gets audited. Each origin is one repo at one ref; subjects from it are identified as
# <id>~<app> and their reports live under data/reports/<id>/.
#
# The \`yundera\` entry is special: every report written before this setting existed resolves
# to it, so it is re-added automatically if you leave it out. Add stores, do not replace it.
origins:
  - id: ${origin.id}
    repo: ${origin.repo}
    ref: ${origin.ref}
    apps_path: ${origin.apps_path}
# Adding a second store needs no code change. Two stores may ship the same app name; they are
# two subjects, two rows and two report folders.
#   - id: acme
#     repo: Acme/AppStore
#     ref: main
#     apps_path: Apps
#     # A cold-start list, used until the GitHub contents API answers once. The Yundera store's
#     # equivalent lives in code, because it must not drift from the copy n8n falls back to.
#     seed: []

# ── the scheduler ───────────────────────────────────────────────────────────────────────
# The five constants of n8n's \`Pick next target\`, at the values it runs today. Do not
# change them while shadow mode is being compared against the live loop.
scheduler:
  # Dry-run until this is true: the scheduler decides and logs, and dispatches nothing.
  armed: false
  tick_min: 60
  fresh_days: 14     # a verdict older than this makes the subject eligible again. Raised from
                     # 7 on 2026-08-25: a rubric edit and a changed compose now make a subject
                     # eligible on their own, so the calendar is the backstop rather than the
                     # main trigger and does not have to run as hot.
  stuck_days: 7      # how long a subject that exhausted its tries stays parked
  lease_min: 120     # an in-progress claim expires after this
  cooldown_min: 55   # minimum gap between finishing one assay and starting the next
  max_tries: 3       # consecutive errored attempts before parking

# ── the runner ──────────────────────────────────────────────────────────────────────────
# Disabled until reviewed. Two systems auditing the same app contend for one Claude Code
# endpoint — n8n's PR Review workflow shares it and is not being replaced.
runner:
  enabled: false
  # There is no depth. An audit covers every section that data/protocols/*.md declares, and a
  # section whose requires: cannot be satisfied — no demo bench, no browser — is recorded
  # blocked rather than narrowing the run.
  #
  # The wait before the one retry when the agent answers 409. PR Review stays in n8n on the
  # same endpoint, so a busy agent is routine and costs the app nothing either way.
  busy_backoff_min: 10
  # The agent endpoint. This default is the address n8n posts to from inside the yunderalabs
  # stack. Anywhere else — a dev container, a laptop — has to point at a Beacon aggregator
  # and name the namespaced tool:
  #   agent_url: http://host.docker.internal:3000/mcp/
  #   agent_tool: beacon-yunderalabs.claude-code__query_claude
  agent_url: ${cfg.runner.agent_url}
  agent_tool: ${cfg.runner.agent_tool}
  agent_via: ${cfg.runner.agent_via}   # direct | beacon
  # Where the agent calls BACK to record each requirement as it settles it. The only place
  # anything reaches inward, so it is named rather than guessed. An agent that cannot reach
  # it just does not report incrementally; the run falls back to one JSON object at the end.
  callback_url: ${cfg.runner.callback_url}

# ── the browser ──────────────────────────────────────────────────────────────
# The sidecars the functional leg drives. Touchstone's own, never the shared box-wide
# \`browsermcp\`: that one is busy with other work, and an audit whose tab was stolen
# mid-install records the theft against the app.
#
# The profile is EPHEMERAL by design — there is no volume in the compose file. A session
# surviving from a previous assay makes an unprotected app look protected, which is a false
# pass on the very check that catches auth bypass.
#
# One audit runs per free (bench, browser) pair, so this list is half of how many run at once:
# two benches and one browser is one audit at a time. Add a sidecar to run another.
browsers:
  - name: ${browser ? browser.name : 'browser-1'}
    url: ${browser ? browser.url : 'http://touchstone-browser-1:9746/mcp'}

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
  pool_url: ${cfg.bench.pool_url}
  # The same board a person opens. Linked from the UI, and its claim is shown beside our
  # own probe: it reported "Ready" for the whole of the 2026-08-05 outage, so Touchstone
  # displays the disagreement rather than trusting either source.
  board_url: ${cfg.bench.board_url}
  # A functional assay may not claim a bench with less runway than this. n8n requires more
  # than an hour so the daily cleanup cannot wipe a run mid-audit — a full run includes an
  # uninstall-then-reinstall. Shorter than the assay is worse than no bench at all.
  min_remaining_min: 60
  probe_interval_min: 5
  probe_timeout_ms: 8000

# ── the operator tools, over MCP ────────────────────────────────────────────────────────
# Touchstone's own administration — the same tools the chat on the front page uses — served
# at /api/v1/mcp/admin so an agent can ask them. Seven tools: six read what is written down
# (the archive, a fix brief, the log, the backlog, the schedule), and run_assay starts an
# audit. None of them can write a verdict; that is invariant 6 and it does not move.
#
# Off by default, and off is the point. This is meant to be announced to a Beacon aggregator,
# and Beacon trusts every announcement and authenticates nobody — so anything that can reach
# it can call what is registered there. Everything else Touchstone serves is behind the SSO
# sidecar.
# Disabled, the route is not registered at all: there is no address to find.
admin_mcp:
  enabled: ${cfg.admin_mcp.enabled}
  # A bearer, checked on every call when set. A beaconify sidecar can inject it
  # (BEACONIFY_AUTH) so the caller never holds it.
  token: "${cfg.admin_mcp.token}"
  # Serve only the tools that report. Drops run_assay — and refuses it if asked for anyway,
  # since a hidden tool is not an absent one.
  read_only: ${cfg.admin_mcp.read_only}

# ── trials ──────────────────────────────────────────────────────────────────────────────
# Touchstone's own address, as a demo bench on the public internet would reach it — e.g.
# https://touchstone-<your domain>. A trial saves the archive it audited and serves it back
# here for the bench to install, which is what makes the bytes judged and the bytes running the
# same thing. Touchstone cannot infer it: the request that starts a trial arrives on the
# internal network under a service name no bench can resolve.
#
# LEAVE IT EMPTY AND TRIALS ARE STATIC-ONLY — the functional section records
# store_url_unconfigured and the blocked report names this setting. That is the only
# remaining reason a trial is not a full audit.
trials:
  public_base_url: "${cfg.trials.public_base_url}"

# ── upload sessions ─────────────────────────────────────────────────────────────────────
# One of the two ways to name a store: PUT an app's files into a session and the trial zips
# them, so the fix loop needs no commit and no push. The other way is a store zip URL, which
# must be a GitHub archive — see services/trialstore.ts for why that allowlist exists.
# These caps are about disk on this box, not about what an upload may contain.
uploads:
  max_file_bytes: ${cfg.uploads.max_file_bytes}
  max_total_bytes: ${cfg.uploads.max_total_bytes}
  # A session stays writable this long, and its files are swept once it lapses.
  ttl_min: ${cfg.uploads.ttl_min}

# ── the workshop: pull requests ─────────────────────────────────────────────────────────
# Touchstone can propose a fix, a version update or a wishlist app as a pull request on the
# origin below — validated by trials first, at most \`prs_per_day\` a day, never merged by
# itself. docs/auto-app-pr.md is the design.
#
# The token is a fine-grained PAT, resource owner = the origin's organisation, repository =
# the AppStore only, permissions Contents RW + Pull requests RW + Metadata R. It pushes only
# \`touchstone/…\` branches; the code refuses any other ref. It is never shown to an agent.
# Prefer TOUCHSTONE_GITHUB_TOKEN in the environment over writing it here.
github:
  # token: ""
  login: "${cfg.github.login}"
  commit_name: "${cfg.github.commit_name}"
  # Empty = the account's noreply address.
  commit_email: ""

workshop:
  origin: ${cfg.workshop.origin}
  # Safety switch. Off: nothing is picked or submitted automatically; an operator can still
  # press Propose and Open PR. Settable at runtime from the Workshop page only.
  armed: false
  # At most this many PRs in any rolling 24 hours. 0 = build and validate, never submit.
  prs_per_day: ${cfg.workshop.prs_per_day}
  max_rounds: ${cfg.workshop.max_rounds}
  session_minutes: ${cfg.workshop.session_minutes}
  # The reading a "currency" proposal is about. Empty disables them.
  currency_section: ${cfg.workshop.currency_section}

# ── notification ────────────────────────────────────────────────────────────────────────
# Outlets go through the local Beacon aggregator. \`target\` is a Telegram chat id or a
# Discord channel id; omit it to use the bridge's own default destination.
notify:
  outlets: []
  # outlets:
  #   - kind: telegram
  #     label: ops
  #     target: ""
  push_subject: ${cfg.notify.push_subject}
`;
}

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
    // Seeded from the **resolved** defaults, which is what makes the environment mean anything.
    // This file is merged *over* the defaults on every later boot, so a template carrying
    // literals silently shadowed every `TOUCHSTONE_*` variable the moment it was written: a
    // container could set the agent, the browser and the callback and be overruled by its own
    // seed file on first boot. Three of those were wrong on the first real deployment, and the
    // callback one failed silently — runs completed while every incremental record went to a
    // login page.
    await fs.writeFile(file, configTemplate(defaults(dir)), { encoding: 'utf8', flag: 'wx' });
    return file;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return null;
    // A read-only data dir is a real deployment (a mounted archive), and the app runs fine
    // on defaults, so this is reported by the caller rather than thrown at boot.
    throw err;
  }
}

/**
 * Names that mean "this value is a credential".
 *
 * Matched on the key rather than the value, because a secret is not recognisable by looking
 * at it. `admin_mcp.token` is the only one today, but `config.yaml` is merged over the
 * defaults with an index signature — an operator may put anything in it, and the config page
 * would otherwise publish it to anyone who can load the SPA.
 */
const SECRET_KEY = /token|secret|password|passwd|credential|api[_-]?key|(^|_)key$/i;

/** What replaces a secret that is set. Deliberately says *that* it is set — an empty
 *  credential and a hidden one are different problems, and the page is for diagnosing. */
export const REDACTED = '••••••••';

/**
 * A copy of the config safe to hand to the browser.
 *
 * Structure and non-secret values verbatim; anything whose key looks like a credential
 * becomes `REDACTED` when it is set and stays empty when it is not. Recursive, because the
 * index signature means the shape below the known keys is whatever the operator wrote.
 */
export function redactConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => redactConfig(v));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY.test(k) && typeof v === 'string') out[k] = v ? REDACTED : '';
    else out[k] = redactConfig(v);
  }
  return out;
}
