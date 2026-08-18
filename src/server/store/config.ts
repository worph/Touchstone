/**
 * Configuration: `data/config.yaml` plus `data/standards/*.yaml`.
 *
 * Both are optional. The MVP has to run on a laptop straight after `git clone`, so every
 * value has a default and an absent file is a normal state, not a degraded one. Only the
 * things that genuinely cannot be guessed — bench credentials, notification routing — have
 * no default, and none of those are used in MVP-0.
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
