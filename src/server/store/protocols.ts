/**
 * The protocol — local markdown files that Touchstone owns, reads and edits.
 *
 * **This used to live in Docmost and that was the biggest undocumented dependency in the
 * system.** The rubric the agent grades against was three wiki pages (`In2NAGjv0h`,
 * `LPwfKYUVig`, `7HxjTwe63H`) fetched at run time; Touchstone held a slug and a version
 * number. Two consequences nobody had written down:
 *
 * - **You could not edit the standard from the app that enforces it.** The one thing an
 *   operator most needs to change lived somewhere else entirely.
 * - **The "exit Docmost" plan would have stranded it.** Freezing the wiki and deleting the
 *   importer would have left every audit fetching a page we had stopped maintaining.
 *
 * So the protocol is a file now, exported once on 2026-08-19 and amended in place to drop the
 * publish-to-wiki instructions it carried. `imported_from` in the frontmatter records where
 * each one came from; nothing reads it, it is provenance.
 *
 * The whole text is embedded in the prompt rather than fetched, which also removes an entire
 * class of failure: an audit can no longer error because a wiki was slow.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface ProtocolMeta {
  id: string;
  name: string;
  version: number;
  /** `orchestrator` composes; a `leaf` is one half of the work. */
  kind: 'orchestrator' | 'leaf';
  leg?: 'static' | 'functional';
  /** Whether this protocol's checks need a live instance — what gates on the bench pool. */
  requires_bench?: boolean;
  /**
   * The canonical requirement ids this protocol names, handed to the agent by
   * `list_requirements` so it maps rather than invents.
   *
   * Not a second rubric. For the static leaf the meaning of each item still comes from the
   * repo's own `CONTRIBUTING.md`; this is a stable vocabulary so the same check has the same
   * name across runs and across apps. An item found that is not here is recorded anyway and
   * marked `unlisted`, which is how the list gets corrected.
   */
  requirements?: { id: string; text: string; requires?: string }[];
  /** Where it came from, when it was not written here. Provenance only. */
  imported_from?: string;
  imported_at?: string;
  [key: string]: unknown;
}

export interface Protocol {
  meta: ProtocolMeta;
  /** The prose, verbatim. This is what the agent is given. */
  body: string;
  /** `<id>.md`, relative to the protocols directory. */
  file: string;
  bytes: number;
  modified_at: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseProtocol(raw: string, file: string): { meta: ProtocolMeta; body: string } {
  const m = FRONTMATTER.exec(raw);
  if (!m) {
    // A file with no frontmatter is still a protocol — it just has no version to report.
    // Refusing to load it would make a hand-written one impossible to start.
    return { meta: { id: path.basename(file, '.md'), name: path.basename(file, '.md'), version: 0, kind: 'leaf' }, body: raw.trim() };
  }
  const parsed = (YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  const id = String(parsed.id ?? path.basename(file, '.md'));
  return {
    meta: {
      ...parsed,
      id,
      name: String(parsed.name ?? id),
      version: Number(parsed.version ?? 0) || 0,
      kind: parsed.kind === 'orchestrator' ? 'orchestrator' : 'leaf',
      ...(parsed.leg === 'static' || parsed.leg === 'functional' ? { leg: parsed.leg } : {}),
    },
    body: raw.slice(m[0].length).trim(),
  };
}

export function serialiseProtocol(meta: ProtocolMeta, body: string): string {
  // Key order is stable so an edit that changes only the body produces a one-hunk diff.
  const ordered: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'version', 'kind', 'leg', 'requires_bench', 'requirements', 'imported_from', 'imported_at']) {
    if (meta[key] !== undefined) ordered[key] = meta[key];
  }
  for (const [k, v] of Object.entries(meta)) if (!(k in ordered)) ordered[k] = v;
  return `---\n${YAML.stringify(ordered).trim()}\n---\n\n${body.trim()}\n`;
}

export class ProtocolStore {
  constructor(private readonly dir: string) {}

  get directory(): string {
    return this.dir;
  }

  async list(): Promise<Protocol[]> {
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.md')).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: Protocol[] = [];
    for (const name of names) {
      const loaded = await this.readFile(name);
      if (loaded) out.push(loaded);
    }
    // Orchestrator first: it is the one that composes the others, and it is what an operator
    // opens first when they want to change how a verdict is reached.
    return out.sort((a, b) =>
      a.meta.kind === b.meta.kind ? a.meta.id.localeCompare(b.meta.id) : a.meta.kind === 'orchestrator' ? -1 : 1,
    );
  }

  async get(id: string): Promise<Protocol | null> {
    if (!isSafeId(id)) return null;
    return this.readFile(`${id}.md`);
  }

  /**
   * Replace a protocol's body, bumping its version.
   *
   * The version bump is automatic and not optional: every assay records the standard and
   * version it was graded against, so an edit that left the number alone would make two
   * different rubrics indistinguishable in the archive.
   */
  async save(id: string, body: string, opts: { bumpVersion?: boolean } = {}): Promise<Protocol | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const meta: ProtocolMeta = {
      ...existing.meta,
      version: opts.bumpVersion === false ? existing.meta.version : existing.meta.version + 1,
    };
    const file = path.join(this.dir, existing.file);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(file, serialiseProtocol(meta, body), 'utf8');
    return this.get(id);
  }

  private async readFile(name: string): Promise<Protocol | null> {
    const file = path.join(this.dir, name);
    try {
      const [raw, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
      const { meta, body } = parseProtocol(raw, name);
      return { meta, body, file: name, bytes: raw.length, modified_at: stat.mtime.toISOString() };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }
}

/** No slashes, no dots, no climbing out of the protocols directory. */
export function isSafeId(id: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id);
}
