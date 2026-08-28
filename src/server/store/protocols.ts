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

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

import { REPO_ROOT } from './config.js';

export interface ProtocolMeta {
  /**
   * The protocol id, and — for a leaf — **the section id**: the value that lands in an
   * assay's frontmatter, names its file and labels its column. There is no separate
   * registry of sections; adding `data/protocols/security.md` adds a section.
   */
  id: string;
  name: string;
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
   * **Who performs this section** — `agent` (the default, and every section before 2026-08-22)
   * or the name of a `*.sh` file sitting beside this protocol.
   *
   * There is no third form, and deliberately no inline script and no path: a check is either
   * a rubric a model reads or a file an operator can open, edit and diff in the same directory
   * as the rubric that declares it. The alternative we rejected was a `builtin:` registry of
   * TypeScript checks compiled into the image — which would have put the one thing most likely
   * to need changing (a registry URL, a threshold, a tag-comparison rule) back behind a
   * rebuild, the exact mistake that keeping the rubric in Docmost was.
   *
   * **Nothing a model can reach may write one.** `ProtocolStore.save` writes `${id}.md` and
   * `PUT /protocols/:id` is the only editor; a `.sh` is therefore unreachable from any route,
   * which is what keeps invariant 6 from widening out of "a model cannot post a verdict" into
   * "a model cannot post code". See `isSafeExecutor`.
   */
  executor?: string;
  /**
   * Whether this section's risk counts toward the subject's — default **true**, which is
   * every section that existed before this field.
   *
   * A section that measures rather than judges sets it false: `currency` reports that an
   * image is 400 days behind, and that is worth showing and is not non-compliance. Summing it
   * into the hallmark would silently re-rank the whole Overview, and ageing `age_days` off it
   * would make an app that was measured look like an app that was audited.
   */
  scores?: boolean;
  /**
   * The knobs this section's executor reads — thresholds, ignore lists, anything the operator
   * should be able to change without touching the procedure.
   *
   * Handed to a script executor verbatim on stdin. It lives here rather than in the script so
   * that **the policy versions itself**: it is inside the bytes the file's hash covers, every
   * assay records that hash, and "what counted as behind in July" stays answerable.
   */
  policy?: Record<string, unknown>;
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
  requirements?: {
    id: string;
    text: string;
    requires?: string;
    /**
     * Present, this requirement is also an **ordered step** in the section's phase plan, and
     * this is its short label on the track. Absent, it is judged but not sequenced — which is
     * every item on the static checklist.
     */
    phase?: string;
  }[];
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
  /**
   * **This protocol's version** — the sha256 of the whole file, frontmatter included.
   *
   * Frontmatter included because `policy:` lives up there: a threshold changed in the header
   * changes what the check does, and a hash over the prose alone would call two different
   * rubrics the same thing.
   *
   * It replaced an integer the file carried and `save()` incremented. The integer only ever
   * moved when somebody used the editor, it moved whether or not the content changed, and —
   * the fatal one — it resolved to nothing: the archive said `v7` and no v7 survived
   * anywhere. See `store/revisions.ts`, which is what makes this dereferenceable.
   */
  sha256: string;
  /** Size on disk, in bytes. */
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
    // A file with no frontmatter is still a protocol — it is identified by its bytes like
    // every other one. Refusing to load it would make a hand-written one impossible to start.
    return { meta: { id: path.basename(file, '.md'), name: path.basename(file, '.md'), kind: 'leaf' }, body: raw.trim() };
  }
  const parsed = (YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  const id = String(parsed.id ?? path.basename(file, '.md'));
  // A `version:` left over from before the hash is dropped on the way in, so nothing
  // downstream can display a number that stopped meaning anything. It survives on disk until
  // the file is next saved, which is deliberate: this reads protocols, it does not rewrite
  // them behind an operator's back.
  delete parsed.version;
  return {
    meta: {
      ...parsed,
      id,
      name: String(parsed.name ?? id),
      kind: parsed.kind === 'orchestrator' ? 'orchestrator' : 'leaf',
      // `requires_bench: true` predates capabilities and meant exactly "a demo instance and
      // a browser to drive it", so it widens to both rather than to `bench` alone.
      requires: normaliseRequires(parsed),
      ...(typeof parsed.leg === 'string' ? { leg: parsed.leg } : {}),
    },
    body: raw.slice(m[0].length).trim(),
  };
}

/**
 * The existing frontmatter, then the new prose.
 *
 * A file that has none gets a minimal one synthesised. That is not tidiness: without a block
 * in front of it, a body beginning with `---` would *become* the frontmatter on the next
 * read, and a saved rubric could grow an `executor:` it was never given. There is always a
 * block, so prose is always prose.
 *
 * A stale `version:` is dropped as it passes — the one key this rewrites, because it stopped
 * meaning anything on 2026-08-23 and a number nothing reads is worse than no number.
 */
function replaceBody(raw: string | null, meta: ProtocolMeta, body: string): string {
  const m = raw ? FRONTMATTER.exec(raw) : null;
  if (!m) return serialiseProtocol(meta, body);
  return `${m[0].replace(/^version:.*\r?\n/m, '')}\n${body.trim()}\n`;
}

export function serialiseProtocol(meta: ProtocolMeta, body: string): string {
  // Key order is stable so an edit that changes only the body produces a one-hunk diff.
  const ordered: Record<string, unknown> = {};
  for (const key of ['id', 'name', 'kind', 'order', 'requires', 'executor', 'scores', 'policy', 'phases', 'report_headings', 'requirements', 'imported_from', 'imported_at']) {
    if (meta[key] !== undefined) ordered[key] = meta[key];
  }
  for (const [k, v] of Object.entries(meta)) if (!(k in ordered)) ordered[k] = v;
  return `---\n${YAML.stringify(ordered).trim()}\n---\n\n${body.trim()}\n`;
}

/**
 * Who performs a section.
 *
 * Two forms, and there will not be a third: a model reading a rubric, or a file on disk. An
 * `invalid` executor is not silently downgraded to the agent — a protocol that names a script
 * we refuse to run must record that it could not run, or a typo in one character would turn a
 * deterministic check into an LLM guessing at the same question and nobody would notice.
 */
export type Executor =
  | { kind: 'agent' }
  | { kind: 'script'; file: string }
  | { kind: 'invalid'; raw: string };

/**
 * A `*.sh` beside the protocol, and nothing else.
 *
 * Deliberately stricter than it has to be. No slash, so it cannot leave the directory; no dot
 * except the extension, so `..` is unspellable; no leading dash, so it cannot be read as a
 * flag by anything downstream. This regex is a security boundary, not tidiness — the executor
 * name arrives from a file an operator edits, and the app spawns what it names.
 */
export function isSafeExecutor(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*\.sh$/.test(name);
}

/** A resolved script executor: where it is, and what it was when we ran it. */
export interface ExecutorRef {
  file: string;
  path: string;
  sha256: string;
}

export function parseExecutor(value: unknown): Executor {
  const raw = String(value ?? '').trim();
  if (raw === '' || raw === 'agent') return { kind: 'agent' };
  if (isSafeExecutor(raw)) return { kind: 'script', file: raw };
  return { kind: 'invalid', raw };
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
  /** Who performs it — the agent, or a script beside the protocol. */
  executor: Executor;
  /** Whether its risk counts toward the subject's. False for a section that measures. */
  scores: boolean;
  /** The knobs its executor reads, handed over verbatim. */
  policy: Record<string, unknown>;
  /** The rubric's identity — the sha256 of the file that declared this section. */
  sha256: string;
  body: string;
}

/**
 * The sections a set of protocol files declares, in run order.
 *
 * Order is explicit (`order:`, defaulting to 100, id as the tie-break) rather than the
 * directory's alphabetical accident: the first section carries the run's headline verdict,
 * and `functional.md` sorting before `static.md` would silently move it.
 */
/**
 * The ordered steps of a section — **derived from its requirements, not listed twice.**
 *
 * A phase is not a different kind of thing from a requirement: it is a requirement that also
 * happens to be a step in a fixed sequence. Saying so twice is how the two came to disagree —
 * `functional.md` carried a `phases:` list keyed `A, C, D, E8…` and a `requirements:` list
 * keyed `phase-a-session…`, two id spaces for the same eight facts, and the letters had holes
 * in them (no B, no E1–E7) where an older document's steps used to be. A requirement now
 * declares `phase: <short label>` and that *is* the plan: one list, in one order, with one set
 * of ids the ledger, the prompt and the UI track all agree on.
 *
 * A literal `phases:` block still wins if a file carries one, so a rubric written before this
 * keeps working unchanged.
 */
export function phasesOf(meta: ProtocolMeta): { id: string; label: string }[] {
  const declared = (meta.phases ?? []).filter((ph) => ph?.id);
  if (declared.length > 0) {
    return declared.map((ph) => ({ id: String(ph.id), label: String(ph.label ?? ph.id) }));
  }
  return (meta.requirements ?? [])
    .filter((r) => r?.id && typeof r.phase === 'string' && r.phase.trim() !== '')
    .map((r) => ({ id: String(r.id), label: String(r.phase) }));
}

export function sectionsOf(protocols: readonly Protocol[]): ProtocolSection[] {
  return protocols
    .filter((p) => p.meta.kind === 'leaf')
    .map((p) => ({
      id: p.meta.id,
      name: p.meta.name,
      order: Number.isFinite(Number(p.meta.order)) ? Number(p.meta.order) : 100,
      requires: p.meta.requires ?? [],
      phases: phasesOf(p.meta),
      headings: (p.meta.report_headings ?? []).map((h) => String(h)),
      requirements: p.meta.requirements ?? [],
      executor: parseExecutor(p.meta.executor),
      // Absent means true: every section written before this field existed scores, and a
      // default of false would have quietly emptied the Overview's risk column on upgrade.
      scores: p.meta.scores !== false,
      policy:
        p.meta.policy && typeof p.meta.policy === 'object' && !Array.isArray(p.meta.policy)
          ? (p.meta.policy as Record<string, unknown>)
          : {},
      sha256: p.sha256,
      body: p.body,
    }))
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/**
 * Where the shipped copies of the rubric live in a built image.
 *
 * `data/protocols/*.md` are committed to the repo, which is enough in development and is
 * exactly wrong in a container: the data dir is a volume, it starts empty, and an empty
 * protocol directory means `sectionsOf()` returns nothing, every run blocks `no_protocol`
 * and the Protocols page renders empty. So the image carries its own copy outside the volume
 * and seeds it on first boot, the same move `ensureConfigFile` makes for `config.yaml`.
 *
 * `REPO_ROOT` resolves to `/app` in the image and to the repo in development, where this
 * directory does not exist and seeding is therefore a no-op — `data/protocols/` is already
 * populated by the checkout.
 */
export const PROTOCOL_SEED_DIR =
  process.env.TOUCHSTONE_PROTOCOL_SEED_DIR ?? path.join(REPO_ROOT, 'seed', 'protocols');

export interface SeedResult {
  /** Files written. Empty when the directory already had them, which is the steady state. */
  seeded: string[];
  failed?: string;
}

/**
 * Copy the shipped rubric into `dir` for any leaf that is not already there.
 *
 * **Never overwrites.** The protocol is editable in the app, so an operator's edit outranks
 * the image's copy — a redeploy that silently reverted the rubric would also silently change
 * what every subsequent assay is judged against. A file that exists is left exactly as it is,
 * whatever it now says.
 */
export async function ensureProtocolFiles(
  dir: string,
  seedDir: string = PROTOCOL_SEED_DIR,
): Promise<SeedResult> {
  const out: SeedResult = { seeded: [] };
  let names: string[];
  try {
    // `.sh` too: a leaf whose `executor:` names a script is not seeded until its script is,
    // and a protocol pointing at a file the volume does not have would block on first boot.
    names = (await fs.readdir(seedDir)).filter((n) => n.endsWith('.md') || isSafeExecutor(n)).sort();
  } catch (err) {
    // No seed directory is the normal development case: the checkout already has the files.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    out.failed = err instanceof Error ? err.message : String(err);
    return out;
  }

  try {
    await fs.mkdir(dir, { recursive: true });
    for (const name of names) {
      const target = path.join(dir, name);
      try {
        // `wx` is the whole guarantee: exclusive create, so two boots racing cannot both
        // write, and an existing file is never touched.
        await fs.writeFile(target, await fs.readFile(path.join(seedDir, name), 'utf8'), {
          encoding: 'utf8',
          flag: 'wx',
          // The executable bit does not survive every copy into a volume, and a script seeded
          // without it would fail at dispatch rather than at boot. `runScript` spawns through
          // `sh` regardless, so this is convenience for whoever opens the directory, not a
          // dependency.
          ...(isSafeExecutor(name) ? { mode: 0o755 } : {}),
        });
        out.seeded.push(name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  } catch (err) {
    // A read-only data dir is a real deployment; the app still runs on whatever is there.
    out.failed = err instanceof Error ? err.message : String(err);
  }
  return out;
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
   * Replace a protocol's **prose**, and nothing else.
   *
   * There is nothing to bump: the file's identity is its bytes, so writing different bytes
   * *is* the new revision, and `store/revisions.ts` records it with whatever reason the
   * operator gave. What used to be here — an integer incremented on every save — moved the
   * number whether or not the content changed and left no way to read what the old number
   * named.
   *
   * **The frontmatter block is carried over verbatim rather than regenerated**, which matters
   * three ways. It keeps the operator's YAML comments — `currency.md` documents every policy
   * knob in them, and a round-trip through the YAML dumper silently deleted all thirty-five
   * lines of that. It keeps a body-only edit to a body-only diff, which is the whole point of
   * a history somebody reads. And it means no route can rewrite `executor:`: the field is not
   * re-emitted from parsed data, it is bytes that were already there. See invariant 11.
   *
   * A save that would produce byte-identical content writes nothing at all. Not an
   * optimisation: an unchanged file must not acquire a new `modified_at`, and the history
   * must not acquire an entry whose diff is empty.
   */
  async save(id: string, body: string): Promise<Protocol | null> {
    const existing = await this.get(id);
    if (!existing) return null;
    const raw = await this.rawOf(existing.file);
    const next = replaceBody(raw, existing.meta, body);
    if (next === raw) return existing;
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(path.join(this.dir, existing.file), next, 'utf8');
    return this.get(id);
  }

  /** The file exactly as it is on disk, or null. Used to tell a real edit from a re-save. */
  private async rawOf(name: string): Promise<string | null> {
    try {
      return await fs.readFile(path.join(this.dir, name), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * Resolve a section's script: the absolute path, and the hash of what is actually there.
   *
   * The hash is not decoration — it is the script's version, in the same sense that the
   * rubric's hash is the rubric's. Both are recorded on every assay (invariant 9), so an
   * operator who changes what a check *does* cannot leave the archive claiming that the
   * readings before and after came from one procedure. This field is where that idea started,
   * back when the `.md` beside it still carried an integer instead.
   *
   * Returns `null` when the name is unsafe or the file is not there. Both are the caller's cue
   * to record the section blocked rather than to fall back to anything.
   */
  async executor(file: string): Promise<ExecutorRef | null> {
    if (!isSafeExecutor(file)) return null;
    const full = path.join(this.dir, file);
    // `path.join` cannot climb out given `isSafeExecutor`, but the check is cheap and this is
    // the line between "a config value" and "a process this app spawns".
    if (path.dirname(full) !== path.resolve(this.dir)) return null;
    try {
      const bytes = await fs.readFile(full);
      return { file, path: full, sha256: createHash('sha256').update(bytes).digest('hex') };
    } catch {
      return null;
    }
  }

  private async readFile(name: string): Promise<Protocol | null> {
    const file = path.join(this.dir, name);
    try {
      // Read once as bytes and decode from that, rather than reading a string: the hash has
      // to be over the bytes, because that is what `store/revisions.ts` hashes and what
      // `executor()` has always hashed. Hashing a decoded string instead would give one file
      // two identities the moment it contained a BOM or anything not valid UTF-8 — and the
      // archive would point at a revision the log had never heard of.
      const [buf, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);
      const raw = buf.toString('utf8');
      const { meta, body } = parseProtocol(raw, name);
      return {
        meta,
        body,
        file: name,
        sha256: createHash('sha256').update(buf).digest('hex'),
        bytes: buf.byteLength,
        modified_at: stat.mtime.toISOString(),
      };
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
