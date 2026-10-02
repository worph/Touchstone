/**
 * The operator's wishlist — `data/wishlist/*.md`, one file per app to integrate.
 *
 * **Operator-authored on the volume**, like the KB and `config.yaml`, and for the same reason
 * no route and no tool writes one: an admin MCP that authenticates nobody must not be able to
 * queue a new app for the bot account to propose (docs/auto-app-pr.md §9).
 *
 * A wish is identified by its file and versioned by its bytes: the workshop remembers the
 * sha256 it last tried, and editing the file is how a person says "try again".
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import type { Wish } from '../../shared/workshop.js';
import { REPO_ROOT } from './config.js';
import { isAppDirName } from './trials.js';

export const WISHLIST_SEED_DIR =
  process.env.TOUCHSTONE_WISHLIST_SEED_DIR ?? path.join(REPO_ROOT, 'seed', 'wishlist');

export const WORKSHOP_SEED_DIR =
  process.env.TOUCHSTONE_WORKSHOP_SEED_DIR ?? path.join(REPO_ROOT, 'seed', 'workshop');

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Parse one wish file. A problem is reported on the row rather than thrown. */
export function parseWish(raw: string, file: string): Wish {
  const sha256 = createHash('sha256').update(raw).digest('hex');
  const m = FRONTMATTER.exec(raw);
  let meta: Record<string, unknown> = {};
  let problem: string | undefined;
  if (!m) {
    problem = 'no frontmatter — a wish needs at least `name:` and `image:`';
  } else {
    try {
      const parsed = YAML.parse(m[1]!) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
      else problem = 'the frontmatter is not a mapping';
    } catch (err) {
      problem = `the frontmatter is not valid YAML: ${(err as Error).message.split('\n')[0]}`;
    }
  }
  const name = String(meta.name ?? '').trim();
  const image = String(meta.image ?? '').trim();
  const order = typeof meta.order === 'number' && Number.isFinite(meta.order) ? meta.order : undefined;
  if (!problem && !name) problem = '`name:` is missing';
  if (!problem && !isAppDirName(name)) problem = `\`name: ${name}\` is not a usable app directory name`;
  if (!problem && !image) problem = '`image:` is missing';
  return {
    file,
    name,
    image,
    ...(order !== undefined ? { order } : {}),
    body: (m ? raw.slice(m[0].length) : raw).trim(),
    sha256,
    ...(problem ? { problem } : {}),
  };
}

export class WishlistStore {
  constructor(private readonly dir: string) {}

  get directory(): string {
    return this.dir;
  }

  /** Every wish on disk, in file order. Files starting with `_` are examples and skipped. */
  async list(): Promise<Wish[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.md') && !n.startsWith('_')).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Wish[] = [];
    for (const name of names) {
      const raw = await fs.readFile(path.join(this.dir, name), 'utf8').catch(() => null);
      if (raw === null) continue;
      out.push(parseWish(raw, name));
    }
    return out;
  }

  async get(file: string): Promise<Wish | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file)) return null;
    const raw = await fs.readFile(path.join(this.dir, file), 'utf8').catch(() => null);
    return raw === null ? null : parseWish(raw, file);
  }
}
