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
  /**
   * The protocol id, and — for a leaf — **the section id**: the value that lands in an
   * assay's frontmatter, names its file and labels its column. There is no separate
   * registry of sections; adding `data/protocols/security.md` adds a section.
   */
  id: string;
  name: string;
  version: number;
  /** `orchestrator` composes; a `leaf` is one section of the work. */
  kind: 'orchestrator' | 'leaf';
  /**
   * Where this section sits in the run: report order, file order, and which section carries
   * the run's headline verdict (the lowest `order` does). Defaults to 100, ties broken by id.
   */
  order?: number;
  /**
   * What this section cannot run without — `bench`, `browser`, and whatever comes next.
   *
   * This is what replaced `depth: static | full`. The runner does not know that "functional"
   * means "needs a demo instance"; it reads this, probes those capabilities, and records the
   * sections it cannot satisfy as `blocked`. A section that requires nothing always runs.
   */
  requires?: string[];
  /**
   * The fixed steps this section reports as it goes, if it has any — the functional leaf's
   * A/C/D/E8…G. Declared here rather than in code so the track the UI draws, the list the
   * prompt asks for and the ids the ledger accepts are one list in one place.
   */
  phases?: { id: string; label?: string }[];
  /**
   * Headings in the agent's narrative report that belong to this section, as case-insensitive
   * regular expression sources. Used only to split the prose into per-section bodies; the
   * record itself comes from the ledger, not from these.
   */
  report_headings?: string[];
  /** @deprecated The section id is `id`. Read for files written before the rename. */
  leg?: string;
  /** @deprecated Superseded by `requires: [bench, browser]`. */
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

function normaliseRequires(parsed: Record<string, unknown>): string[] {
  const declared = Array.isArray(parsed.requires) ? parsed.requires.map((r) => String(r)) : null;
  if (declared) return declared.filter(Boolean);
  return parsed.requires_bench === true ? ['bench', 'browser'] : [];
}

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
      // `requires_bench: true` predates capabilities and meant exactly "a demo instance and
      // a browser to drive it", so it widens to both rather than to `bench` alone.
      requires: normaliseRequires(parsed),
      ...(typeof parsed.leg === 'string' ? { leg: parsed.leg } : {}),
    },
    body: raw.slice(m[0].length).trim(),
  };
}

export function serialiseProtocol(meta: ProtocolMeta, body: string): string {
  // Key order is stable so an edit that changes only the body produces a one-hunk diff.
  const ordered: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'version', 'kind', 'order', 'requires', 'phases', 'report_headings', 'requirements', 'imported_from', 'imported_at']) {
    if (meta[key] !== undefined) ordered[key] = meta[key];
  }
  for (const [k, v] of Object.entries(meta)) if (!(k in ordered)) ordered[k] = v;
  return `---\n${YAML.stringify(ordered).trim()}\n---\n\n${body.trim()}\n`;
}

/**
 * One section of the protocol, resolved from a leaf file — the shape the runner, the ledger
 * and the prompt all take. Nothing downstream reads `ProtocolMeta` directly, so a field
 * added to the frontmatter has exactly one place to be interpreted.
 */
export interface ProtocolSection {
  id: string;
  name: string;
  order: number;
  /** Capabilities this section needs before it can be attempted. */
  requires: string[];
  /** Its fixed steps, in protocol order. Empty for a section that has none. */
  phases: { id: string; label: string }[];
  /** Regex sources matching this section's headings in the agent's narrative. */
  headings: string[];
  requirements: { id: string; text: string; requires?: string }[];
  version: number;
  body: string;
}

/**
 * The sections a set of protocol files declares, in run order.
 *
 * Order is explicit (`order:`, defaulting to 100, id as the tie-break) rather than the
 * directory's alphabetical accident: the first section carries the run's headline verdict,
 * and `functional.md` sorting before `static.md` would silently move it.
 */
export function sectionsOf(protocols: readonly Protocol[]): ProtocolSection[] {
  return protocols
    .filter((p) => p.meta.kind === 'leaf')
    .map((p) => ({
      id: p.meta.id,
      name: p.meta.name,
      order: Number.isFinite(Number(p.meta.order)) ? Number(p.meta.order) : 100,
      requires: p.meta.requires ?? [],
      phases: (p.meta.phases ?? [])
        .filter((ph) => ph?.id)
        .map((ph) => ({ id: String(ph.id), label: String(ph.label ?? ph.id) })),
      headings: (p.meta.report_headings ?? []).map((h) => String(h)),
      requirements: p.meta.requirements ?? [],
      version: p.meta.version,
      body: p.body,
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
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
