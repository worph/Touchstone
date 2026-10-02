/**
 * The workshop on disk: proposals, their working copies, and what each task taught us.
 *
 * Two places, for the reason `uploads/` and `state/uploads.json` are two:
 *
 * - `state/workshop.json` — the proposals, the per-task **memory**, and the `armed` override.
 *   Small, mutable, rewritten atomically. The memory is the one part that is not
 *   regenerable, and it is small.
 * - `<workshopDir>/proposals/<id>/` — one working copy per proposal, **content-addressed**:
 *   `objects/<sha256>` holds bytes, `base.json` and `work.json` map a relative path to the
 *   sha of its bytes. A deletion is a key missing from `work.json`, which is the thing an
 *   upload session's overlay could never say. The trial zip is `work` materialised and the
 *   commit is `diff(base, work)` — one source of bytes, so what was validated is what is
 *   committed.
 *
 * Paths are map keys, never filesystem paths: an odd filename inherited from the store archive
 * cannot traverse anything, because it is never joined to a directory. Only a path the agent
 * writes is held to `UPLOAD_PATH_RE`, because only that one is chosen by a model.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type {
  Proposal,
  ProposalState,
  TaskMemory,
  DiffFile,
} from '../../shared/workshop.js';
import { readJson, writeJsonAtomic } from './state.js';
import { UPLOAD_PATH_RE } from './uploads.js';

export class WorkshopError extends Error {}

/** Never rm a path this module did not mint. */
const PROPOSAL_ID_RE = /^[a-f0-9]{12}$/;

/** States in which a proposal is somebody's live business — at most one per task key. */
export const ACTIVE_STATES: ProposalState[] = ['queued', 'authoring', 'validating', 'revising', 'ready', 'submitted'];

/** How many finished proposals the state file keeps. Their working copies go with them. */
const MAX_FINISHED = 200;

export interface WorkshopLimits {
  /** Per file the agent writes. */
  maxFileBytes: number;
  /** The whole working copy — the same cap a store zip's app directory has. */
  maxTotalBytes: number;
}

interface WorkshopFile {
  proposals: Proposal[];
  memory: Record<string, TaskMemory>;
  armed?: boolean;
}

type FileMap = Record<string, string>;

export class WorkshopStore {
  private readonly file: string;
  private proposals: Proposal[] = [];
  private memoryRows: Record<string, TaskMemory> = {};
  private armedOverride?: boolean;

  constructor(
    stateDir: string,
    private readonly root: string,
    private readonly limits: WorkshopLimits,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(stateDir, 'workshop.json');
  }

  async load(): Promise<void> {
    const stored = await readJson<WorkshopFile>(this.file, { proposals: [], memory: {} });
    this.proposals = Array.isArray(stored?.proposals) ? stored.proposals : [];
    this.memoryRows = stored?.memory && typeof stored.memory === 'object' ? stored.memory : {};
    this.armedOverride = typeof stored?.armed === 'boolean' ? stored.armed : undefined;
  }

  private async persist(): Promise<void> {
    const out: WorkshopFile = {
      proposals: this.proposals,
      memory: this.memoryRows,
      ...(this.armedOverride === undefined ? {} : { armed: this.armedOverride }),
    };
    await writeJsonAtomic(this.file, out);
  }

  // ── proposals ────────────────────────────────────────────────────────────────────────

  list(): Proposal[] {
    return [...this.proposals].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  get(id: string): Proposal | undefined {
    return this.proposals.find((p) => p.id === id);
  }

  /** The live proposal for a task, if there is one. */
  activeFor(taskKey: string): Proposal | undefined {
    return this.proposals.find((p) => p.task_key === taskKey && ACTIVE_STATES.includes(p.state));
  }

  async create(input: Omit<Proposal, 'id' | 'created_at' | 'updated_at' | 'round' | 'trials' | 'infra_retries' | 'interrupted' | 'state'>): Promise<Proposal> {
    if (this.activeFor(input.task_key)) throw new WorkshopError(`${input.task_key} already has a proposal in flight`);
    const at = this.now().toISOString();
    const p: Proposal = {
      ...input,
      id: randomBytes(6).toString('hex'),
      state: 'queued',
      round: 1,
      trials: [],
      infra_retries: 0,
      interrupted: 0,
      created_at: at,
      updated_at: at,
    };
    this.proposals.push(p);
    await this.prune();
    await fs.mkdir(path.join(this.dirOf(p.id), 'objects'), { recursive: true });
    await this.persist();
    return p;
  }

  async update(id: string, patch: Partial<Proposal>): Promise<Proposal> {
    const i = this.proposals.findIndex((p) => p.id === id);
    if (i < 0) throw new WorkshopError(`no such proposal: ${id}`);
    const next = { ...this.proposals[i]!, ...patch, id, updated_at: this.now().toISOString() };
    // `undefined` in a patch means "clear it", not "keep it".
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete (next as Record<string, unknown>)[k];
    this.proposals[i] = next;
    await this.persist();
    return next;
  }

  /**
   * After a restart: a session that was authoring died with the process, and its token with
   * it. Put it back where it can be picked up again, at no cost to the task — a restart is
   * infrastructure (invariant 3).
   */
  async reconcile(): Promise<string[]> {
    const touched: string[] = [];
    for (const p of this.proposals) {
      if (p.state !== 'authoring') continue;
      p.state = p.round > 1 ? 'revising' : 'queued';
      p.interrupted += 1;
      p.updated_at = this.now().toISOString();
      delete p.started_at;
      touched.push(p.id);
    }
    if (touched.length > 0) await this.persist();
    return touched;
  }

  /** Every PR opened at or after `iso` — what the quota counts. */
  prsOpenedSince(iso: string): string[] {
    const since = Date.parse(iso);
    return this.proposals
      .map((p) => p.pr?.opened_at)
      .filter((at): at is string => !!at && Date.parse(at) >= since);
  }

  /** Keep the state file bounded: drop the oldest *finished* proposals and their files. */
  private async prune(): Promise<void> {
    const finished = this.proposals
      .filter((p) => !ACTIVE_STATES.includes(p.state))
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at));
    const drop = finished.slice(0, Math.max(0, finished.length - MAX_FINISHED));
    for (const p of drop) await this.removeFiles(p.id);
    const gone = new Set(drop.map((p) => p.id));
    this.proposals = this.proposals.filter((p) => !gone.has(p.id));
  }

  /** Drop a finished proposal's evidence and working copy, keeping its row. */
  async pruneFiles(id: string): Promise<void> {
    const p = this.get(id);
    if (!p || ACTIVE_STATES.includes(p.state)) return;
    await this.removeFiles(id);
  }

  private dirOf(id: string): string {
    if (!PROPOSAL_ID_RE.test(id)) throw new WorkshopError(`not a proposal id: ${id}`);
    return path.join(this.root, 'proposals', id);
  }

  private async removeFiles(id: string): Promise<void> {
    if (!PROPOSAL_ID_RE.test(id)) return;
    await fs.rm(this.dirOf(id), { recursive: true, force: true }).catch(() => {});
  }

  // ── the working copy ─────────────────────────────────────────────────────────────────

  /** Record the base the proposal is built on, and start the working copy equal to it. */
  async setBase(id: string, files: Map<string, Uint8Array>): Promise<void> {
    const map: FileMap = {};
    for (const [rel, bytes] of files) map[rel] = await this.putObject(id, bytes);
    await this.writeMap(id, 'base.json', map);
    await this.writeMap(id, 'work.json', { ...map });
  }

  async hasBase(id: string): Promise<boolean> {
    try {
      await fs.access(path.join(this.dirOf(id), 'base.json'));
      return true;
    } catch {
      return false;
    }
  }

  /** The working copy as bytes — what the trial zip and the commit are both made from. */
  async workFiles(id: string): Promise<Map<string, Uint8Array>> {
    return this.materialise(id, await this.readMap(id, 'work.json'));
  }

  async baseFiles(id: string): Promise<Map<string, Uint8Array>> {
    return this.materialise(id, await this.readMap(id, 'base.json'));
  }

  async manifest(id: string): Promise<{ path: string; bytes: number }[]> {
    const work = await this.readMap(id, 'work.json');
    const out: { path: string; bytes: number }[] = [];
    for (const [rel, sha] of Object.entries(work).sort(([a], [b]) => a.localeCompare(b))) {
      const st = await fs.stat(this.objectPath(id, sha)).catch(() => null);
      out.push({ path: rel, bytes: st?.size ?? 0 });
    }
    return out;
  }

  async read(id: string, rel: string): Promise<Uint8Array | null> {
    const sha = (await this.readMap(id, 'work.json'))[rel];
    if (!sha) return null;
    return fs.readFile(this.objectPath(id, sha));
  }

  /** Write one file into the working copy. The only path here a model chooses. */
  async put(id: string, relPath: string, bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
    const rel = checkRel(relPath);
    if (bytes.byteLength > this.limits.maxFileBytes) {
      throw new WorkshopError(`${rel} is ${bytes.byteLength} bytes; the limit per file is ${this.limits.maxFileBytes}`);
    }
    const work = await this.readMap(id, 'work.json');
    let total = 0;
    for (const [k, sha] of Object.entries(work)) {
      if (k === rel) continue;
      total += (await fs.stat(this.objectPath(id, sha)).catch(() => null))?.size ?? 0;
    }
    if (total + bytes.byteLength > this.limits.maxTotalBytes) {
      throw new WorkshopError(`the working copy would be ${total + bytes.byteLength} bytes; the limit is ${this.limits.maxTotalBytes}`);
    }
    work[rel] = await this.putObject(id, bytes);
    await this.writeMap(id, 'work.json', work);
    return { path: rel, bytes: bytes.byteLength };
  }

  /** Remove one file. A path the working copy does not hold is `false`, not an error. */
  async del(id: string, relPath: string): Promise<boolean> {
    const rel = relPath.replace(/^\/+/, '');
    const work = await this.readMap(id, 'work.json');
    if (!(rel in work)) return false;
    delete work[rel];
    await this.writeMap(id, 'work.json', work);
    return true;
  }

  /** What the working copy changes, against the base. */
  async diff(id: string): Promise<{ added: string[]; modified: string[]; deleted: string[] }> {
    const base = await this.readMap(id, 'base.json');
    const work = await this.readMap(id, 'work.json');
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    for (const [rel, sha] of Object.entries(work)) {
      if (!(rel in base)) added.push(rel);
      else if (base[rel] !== sha) modified.push(rel);
    }
    for (const rel of Object.keys(base)) if (!(rel in work)) deleted.push(rel);
    return { added: added.sort(), modified: modified.sort(), deleted: deleted.sort() };
  }

  /** The diff with both sides' text where both are small UTF-8 — the Workshop page's view. */
  async diffFiles(id: string, maxText = 64 * 1024): Promise<DiffFile[]> {
    const d = await this.diff(id);
    const base = await this.readMap(id, 'base.json');
    const work = await this.readMap(id, 'work.json');
    const textOf = async (sha: string | undefined): Promise<{ text?: string; bytes: number }> => {
      if (!sha) return { bytes: 0 };
      const buf = await fs.readFile(this.objectPath(id, sha)).catch(() => null);
      if (!buf) return { bytes: 0 };
      if (buf.byteLength > maxText || buf.includes(0)) return { bytes: buf.byteLength };
      return { text: buf.toString('utf8'), bytes: buf.byteLength };
    };
    const out: DiffFile[] = [];
    for (const [change, list] of [['added', d.added], ['modified', d.modified], ['deleted', d.deleted]] as const) {
      for (const rel of list) {
        const before = await textOf(base[rel]);
        const after = await textOf(work[rel]);
        out.push({
          path: rel,
          change,
          bytes: change === 'deleted' ? before.bytes : after.bytes,
          ...(before.text !== undefined ? { before: before.text } : {}),
          ...(after.text !== undefined ? { after: after.text } : {}),
        });
      }
    }
    return out;
  }

  // ── evidence and feedback ────────────────────────────────────────────────────────────

  /** Copy a report into the proposal, so a trial evicted later cannot take the PR's evidence. */
  async writeEvidence(id: string, name: string, text: string): Promise<string> {
    const safe = name.replace(/[^A-Za-z0-9._@-]/g, '_');
    const dir = path.join(this.dirOf(id), 'evidence');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, safe), text, 'utf8');
    return safe;
  }

  async readEvidence(id: string, name: string): Promise<string | null> {
    if (!/^[A-Za-z0-9._@-]+$/.test(name)) return null;
    return fs.readFile(path.join(this.dirOf(id), 'evidence', name), 'utf8').catch(() => null);
  }

  async setFeedback(id: string, text: string): Promise<void> {
    await fs.mkdir(this.dirOf(id), { recursive: true });
    await fs.writeFile(path.join(this.dirOf(id), 'feedback.md'), text, 'utf8');
  }

  async feedback(id: string): Promise<string | null> {
    return fs.readFile(path.join(this.dirOf(id), 'feedback.md'), 'utf8').catch(() => null);
  }

  // ── memory ───────────────────────────────────────────────────────────────────────────

  memory(): Record<string, TaskMemory> {
    return { ...this.memoryRows };
  }

  memoryOf(taskKey: string): TaskMemory | undefined {
    return this.memoryRows[taskKey];
  }

  /** A charged outcome. Infra never comes here — invariant 3. */
  async remember(taskKey: string, row: Omit<TaskMemory, 'attempts'>): Promise<TaskMemory> {
    const prev = this.memoryRows[taskKey];
    const next: TaskMemory = {
      ...row,
      attempts: prev && prev.input_sha === row.input_sha ? prev.attempts + 1 : 1,
    };
    this.memoryRows[taskKey] = next;
    await this.persist();
    return next;
  }

  async forget(taskKey: string): Promise<boolean> {
    if (!(taskKey in this.memoryRows)) return false;
    delete this.memoryRows[taskKey];
    await this.persist();
    return true;
  }

  /** The operator's standing instructions for authoring — `<workshopDir>/author.md`. */
  async authorInstructions(): Promise<string | null> {
    const text = await fs.readFile(path.join(this.root, 'author.md'), 'utf8').catch(() => null);
    return text?.trim() ? text : null;
  }

  // ── the switch ───────────────────────────────────────────────────────────────────────

  get armed(): boolean | undefined {
    return this.armedOverride;
  }

  async setArmed(value: boolean | undefined): Promise<void> {
    this.armedOverride = value;
    await this.persist();
  }

  // ── internals ────────────────────────────────────────────────────────────────────────

  private objectPath(id: string, sha: string): string {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new WorkshopError('corrupt working copy');
    return path.join(this.dirOf(id), 'objects', sha);
  }

  private async putObject(id: string, bytes: Uint8Array): Promise<string> {
    const sha = createHash('sha256').update(bytes).digest('hex');
    const file = this.objectPath(id, sha);
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(file, bytes, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    return sha;
  }

  private async materialise(id: string, map: FileMap): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (const [rel, sha] of Object.entries(map).sort(([a], [b]) => a.localeCompare(b))) {
      out.set(rel, new Uint8Array(await fs.readFile(this.objectPath(id, sha))));
    }
    return out;
  }

  private async readMap(id: string, name: 'base.json' | 'work.json'): Promise<FileMap> {
    const map = await readJson<FileMap>(path.join(this.dirOf(id), name), {});
    return map && typeof map === 'object' ? map : {};
  }

  private async writeMap(id: string, name: 'base.json' | 'work.json', map: FileMap): Promise<void> {
    await writeJsonAtomic(path.join(this.dirOf(id), name), map);
  }
}

/** A path the agent writes: plain segments, no `..`. */
export function checkRel(relPath: string): string {
  const rel = String(relPath ?? '').replace(/^\/+/, '');
  if (!UPLOAD_PATH_RE.test(rel) || rel.includes('..')) {
    throw new WorkshopError('path must be plain segments inside the app directory, with no ".."');
  }
  return rel;
}
