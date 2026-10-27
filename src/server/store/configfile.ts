/**
 * Writes one setting into `config.yaml` — the only place a control's value lives (2026-10-27).
 *
 * Until then a control changed at runtime was an *override* in `state/controls.json` (and the
 * two `armed` switches in `schedule.json` / `workshop.json`), and an override beat the file for
 * ever: an operator who edited `config.yaml` saw nothing happen for those keys, and the page had
 * to explain why the live value disagreed with the file. Now the Settings, Automation and
 * Workshop pages write the file itself, so what it says is what runs — before and after a
 * restart.
 *
 * Three properties the writer keeps:
 *
 * - **The operator's file survives.** It is re-read on every write and edited as a YAML
 *   document, so comments, ordering and every other key are left as they were. Only the one key
 *   is written — a literal for anything else would pin an env-derived default for good (see
 *   `config.seed.test.ts`).
 * - **Writes do not interleave.** They run one after another, and each lands by rename.
 * - **The process agrees with the file.** The live `cfg` slice that the control rows read as
 *   "what config.yaml says" is updated with the write; a removed key falls back to the built-in
 *   default, exactly as the next boot would read it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import type { ControlValue } from '../../shared/controls.js';

/** A plain object tree — the parts of `TouchstoneConfig` a control can live in. */
type Tree = Record<string, unknown>;

/** Per process, so two writers of one file (the boot migration, then the app) never share a scratch name. */
let writeSeq = 0;

export interface ConfigFileOptions {
  /** `<dataDir>/config.yaml`. */
  file: string;
  /** The live config, updated in place so readers agree with the file. */
  live?: Tree;
  /** What a key falls back to when it is removed — the built-in defaults. */
  builtin?: Tree;
}

export class ConfigFile {
  readonly file: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: ConfigFileOptions) {
    this.file = opts.file;
  }

  /**
   * Set `key` (dotted, `scheduler.fresh_days`) to `value`, or remove it with `undefined` so the
   * built-in default applies. Resolves once the file is on disk.
   */
  set(key: string, value: ControlValue | undefined): Promise<void> {
    const run = this.chain.then(() => this.write(key.split('.'), value));
    // A failed write must not poison every later one; the caller of this one hears about it.
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** What `key` falls back to when `config.yaml` does not set it. */
  builtin(key: string): ControlValue | undefined {
    const v = lookup(this.opts.builtin, key.split('.'));
    return typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
  }

  private async write(keys: string[], value: ControlValue | undefined): Promise<void> {
    let raw = '';
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    // Typed as the editable document rather than the parsed one: this writes nodes into it.
    const doc = YAML.parseDocument(raw) as unknown as YAML.Document;
    if (doc.errors.length > 0) {
      // Refused rather than "repaired": rewriting a file we cannot read would throw away
      // whatever the operator was in the middle of writing.
      throw new Error(`config.yaml does not parse, so it was not changed: ${doc.errors[0]!.message}`);
    }
    if (!YAML.isMap(doc.contents)) doc.contents = doc.createNode({});

    if (value === undefined) {
      doc.deleteIn(keys);
    } else {
      let parent = doc.contents as YAML.YAMLMap;
      for (const k of keys.slice(0, -1)) {
        let node: unknown = parent.get(k, true);
        if (!YAML.isMap(node)) {
          // A block holding nothing but comments parses as null. Make it a map, and keep the
          // comments with it — they are usually the commented-out keys this one belongs among.
          const map = doc.createNode({}) as YAML.YAMLMap;
          if (node && YAML.isNode(node)) {
            map.commentBefore = node.commentBefore;
            map.comment = node.comment;
          }
          parent.set(k, map);
          node = map;
        }
        parent = node as YAML.YAMLMap;
      }
      parent.set(keys[keys.length - 1]!, value);
    }

    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}-${++writeSeq}`;
    try {
      await fs.writeFile(tmp, doc.toString({ lineWidth: 0 }), 'utf8');
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    this.updateLive(keys, value);
  }

  private updateLive(keys: string[], value: ControlValue | undefined): void {
    const live = this.opts.live;
    if (!live) return;
    const next = value === undefined ? lookup(this.opts.builtin, keys) : value;
    let node: Tree = live;
    for (const k of keys.slice(0, -1)) {
      const child = node[k];
      if (!child || typeof child !== 'object') return;
      node = child as Tree;
    }
    node[keys[keys.length - 1]!] = next;
  }
}

function lookup(tree: Tree | undefined, keys: string[]): unknown {
  let node: unknown = tree;
  for (const k of keys) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Tree)[k];
  }
  return node;
}
