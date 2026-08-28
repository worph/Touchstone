/**
 * The knowledge base — supporting knowledge for an audit, which is not the standard.
 *
 * A rubric answers *what makes an app pass*. Getting there also takes a second kind of
 * knowledge — how the platform behaves, what a dialog is actually doing, where an app's
 * first-run credentials are written down — and until 2026-08-28 it had nowhere to live but
 * inside the rubric. `functional.md` was 24 KB, and a third of it described Maison rather than
 * the gate: every fact about the dashboard read as one more thing apps were being judged on,
 * and a fact learned the hard way (the store cache, the backup picker) could only be recorded
 * by editing the standard, which re-versions it and re-eligibles every subject.
 *
 * So the KB is a sibling of `protocols/`, not a part of it:
 *
 * - **It is reference, and it cannot judge.** It is handed to the agent after the protocol,
 *   under a fence that says the protocol governs on conflict. It mints no section, carries no
 *   `requirements:`, and nothing here reaches `sectionsOf()`.
 * - **It is not the standard, and does not move `moved_at`.** An edit here must not spend three
 *   days of agent time re-auditing 72 apps — the same argument invariant 12 makes for a
 *   `scores: false` reading. `domain/standards.ts` never reads this file.
 * - **It is still recorded.** A page that changes what an audit *concludes* while leaving no
 *   trace would be exactly the "the archive says v7 and there is no v7" problem `revisions.ts`
 *   exists to end. Every assay the agent produced records `kb_sha256` — a digest over the
 *   pages actually put in front of it — and a `RevisionStore` over this directory keeps the
 *   bytes. The digest says *whether* it moved; the history, which is time-ordered, says what
 *   it said when a given assay ran.
 *
 * `KB.md` is the index: what is here and when to read it, written by hand because "where do I
 * look" is a judgement rather than a listing. It is always included. Every other `*.md` is a
 * page, included when it applies to a section being run — `sections:` in its frontmatter, or
 * every section when it declares none. A static-only run therefore carries no Maison prose.
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import YAML from 'yaml';

import { REPO_ROOT } from './config.js';

/** The index, always included, and never treated as a page. */
export const KB_INDEX_FILE = 'KB.md';

/** One page. */
export interface KbDoc {
  /** The file's basename — `maison`. Identity for a reader, never for the archive. */
  id: string;
  /** `maison.md`, relative to the KB directory — the name the history logs it under. */
  file: string;
  title: string;
  /**
   * The sections this page applies to. Empty means every one.
   *
   * Read the same way `requires:` is: declared data, not a branch in code. A page is dropped
   * from a run that audits none of its sections, which is what keeps a static-only run from
   * carrying eight kilobytes about a dashboard it never opens.
   */
  sections: string[];
  /** The prose, frontmatter stripped. This is what the agent is given. */
  body: string;
  /** sha256 of the whole file, frontmatter included — its identity in the history. */
  sha256: string;
  bytes: number;
}

/** What one run was given, and the digest that names it. */
export interface KnowledgeBase {
  /** `KB.md`'s prose, or null when the volume has no index. */
  index: string | null;
  docs: KbDoc[];
  /**
   * The digest of what was included — sha256 over `<file> <sha256>` lines, sorted.
   *
   * Deliberately a digest of the *selection* rather than of the directory: two runs given
   * different pages were given different reference material, and a hash that could not tell
   * them apart would be a hash of something nobody was shown.
   */
  sha256: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Same shape a protocol file has, minus everything that could make this a rubric. */
export function parseKbDoc(raw: string, file: string): Omit<KbDoc, 'sha256' | 'bytes'> {
  const id = path.basename(file, '.md');
  const m = FRONTMATTER.exec(raw);
  if (!m) return { id, file, title: id, sections: [], body: raw.trim() };
  const parsed = (YAML.parse(m[1]!) ?? {}) as Record<string, unknown>;
  const sections = Array.isArray(parsed.sections)
    ? parsed.sections.map((s) => String(s)).filter(Boolean)
    : [];
  return {
    id: String(parsed.id ?? id),
    file,
    title: String(parsed.title ?? parsed.name ?? id),
    sections,
    body: raw.slice(m[0].length).trim(),
  };
}

/** Where the image keeps its copy, for a volume that has none yet. */
export const KB_SEED_DIR = process.env.TOUCHSTONE_KB_SEED_DIR ?? path.join(REPO_ROOT, 'seed', 'kb');

export interface KbSeedResult {
  seeded: string[];
  failed?: string;
}

/**
 * Copy the shipped knowledge base into `dir` for any page that is not already there.
 *
 * **Never overwrites**, for the reason `ensureProtocolFiles` does not: an operator's page
 * outranks the image's, and a redeploy that silently reverted it would silently change what
 * the next audit reads.
 */
export async function ensureKbFiles(dir: string, seedDir: string = KB_SEED_DIR): Promise<KbSeedResult> {
  const out: KbSeedResult = { seeded: [] };
  let names: string[];
  try {
    names = (await fs.readdir(seedDir)).filter((n) => n.endsWith('.md')).sort();
  } catch (err) {
    // No seed directory is the normal development case: the checkout already has the files.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return out;
    out.failed = err instanceof Error ? err.message : String(err);
    return out;
  }
  try {
    await fs.mkdir(dir, { recursive: true });
    for (const name of names) {
      try {
        await fs.writeFile(path.join(dir, name), await fs.readFile(path.join(seedDir, name), 'utf8'), {
          encoding: 'utf8',
          flag: 'wx',
        });
        out.seeded.push(name);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    }
  } catch (err) {
    out.failed = err instanceof Error ? err.message : String(err);
  }
  return out;
}

export class KbStore {
  constructor(private readonly dir: string) {}

  get directory(): string {
    return this.dir;
  }

  /** Every page on disk, and the index. A missing directory is an empty KB, never an error. */
  async load(): Promise<{ index: string | null; docs: KbDoc[] }> {
    let names: string[];
    try {
      names = (await fs.readdir(this.dir)).filter((n) => n.endsWith('.md')).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { index: null, docs: [] };
      throw err;
    }
    let index: string | null = null;
    const docs: KbDoc[] = [];
    for (const name of names) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(this.dir, name), 'utf8');
      } catch {
        // A page that cannot be read is a page the agent does not get. It is reference
        // material: losing it must never be able to stop an audit.
        continue;
      }
      if (name === KB_INDEX_FILE) {
        index = raw.trim() || null;
        continue;
      }
      docs.push({ ...parseKbDoc(raw, name), sha256: sha256(raw), bytes: Buffer.byteLength(raw) });
    }
    return { index, docs };
  }

  /**
   * The knowledge base for a run auditing these sections, or null when there is none to give.
   *
   * Null rather than an empty object so the caller has one thing to test: no KB means no fence
   * in the prompt and no `kb_sha256` in the assay — an absent hash reads as "there was none",
   * which is true, where a hash of nothing would read as a version.
   *
   * **No pages means no knowledge base, index or not.** `KB.md` is a table saying which page to
   * read for what; handing it over with none of those pages attached describes material the
   * agent does not have, which is worse than saying nothing. That is not a corner case — it is
   * every static-only run on a box whose pages are all about the bench.
   */
  async forSections(sections: readonly string[]): Promise<KnowledgeBase | null> {
    const { index, docs } = await this.load();
    const want = new Set(sections);
    const mine = docs.filter((d) => d.sections.length === 0 || d.sections.some((s) => want.has(s)));
    if (mine.length === 0) return null;
    return { index, docs: mine, sha256: digestOf(index, mine) };
  }
}

/**
 * The digest recorded on an assay.
 *
 * The index is hashed by content and the pages by the identity they already have, so the
 * digest moves when — and only when — what the agent was shown moves.
 */
export function digestOf(index: string | null, docs: readonly KbDoc[]): string {
  const lines = [
    ...(index === null ? [] : [`${KB_INDEX_FILE} ${sha256(index)}`]),
    ...docs.map((d) => `${d.file} ${d.sha256}`),
  ].sort();
  return sha256(lines.join('\n'));
}
