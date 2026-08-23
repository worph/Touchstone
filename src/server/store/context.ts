/**
 * The administrator's context prompt: `data/context.md`.
 *
 * Standing instructions the operator wants in front of the administrator model on every
 * turn — which box this is, which apps matter, what "done" looks like here. It is prepended
 * to `chat/prompt.md` rather than being part of it, and the split is the point: `prompt.md`
 * is code (it ships in `dist/`, it names the tools, a bad edit breaks the JSON contract),
 * and this is data (it lives on the volume, an operator writes it, an empty one is normal).
 *
 * Deliberately **not** under `state/`. Everything in there is regenerable — losing the
 * directory costs a reindex and a re-probe — and this is the one operator-authored string
 * with no other copy anywhere. It sits beside `config.yaml`, which is the other file on the
 * volume a person is expected to have written.
 *
 * It is prose handed to a model, so there is nothing to validate but its size: a context
 * that does not fit leaves no room for the history it is supposed to inform.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** The file, relative to the data dir. */
export const CONTEXT_FILE = 'context.md';

/**
 * Past this a context is not context any more.
 *
 * A turn is 8 calls of one prompt each, and the prompt also carries the catalogue, the live
 * status and up to `HISTORY_MESSAGES` rows. 16 KB is roughly four thousand words — far more
 * than anyone should need to describe an instance, and small enough that eight of them do
 * not crowd out the conversation they are meant to inform.
 */
export const MAX_CONTEXT_BYTES = 16_000;

export interface ContextDoc {
  text: string;
  bytes: number;
  /** ISO-8601, or null when nothing has ever been written. */
  modified_at: string | null;
  /** The absolute path, so the page can tell the operator where it lives. */
  path: string;
  max_bytes: number;
}

/** Thrown for a context that is too large — the route turns it into a 400. */
export class ContextTooLarge extends Error {
  constructor(readonly bytes: number) {
    super(`the context prompt is ${bytes} bytes; the limit is ${MAX_CONTEXT_BYTES}`);
    this.name = 'ContextTooLarge';
  }
}

export class ContextStore {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = path.join(dataDir, CONTEXT_FILE);
  }

  /**
   * The context as it is on disk.
   *
   * An absent file is the normal state and reads as the empty string — a fresh instance has
   * no standing instructions and must not look broken for it. So is an unreadable one: this
   * is decoration on a prompt, and refusing to answer the chat because a permission bit is
   * wrong would be a worse failure than running without it.
   */
  async read(): Promise<ContextDoc> {
    let text = '';
    let modified: string | null = null;
    try {
      text = await fs.readFile(this.path, 'utf8');
      const stat = await fs.stat(this.path);
      modified = stat.mtime.toISOString();
    } catch {
      /* absent or unreadable — both are "no context" */
    }
    return {
      text,
      bytes: Buffer.byteLength(text, 'utf8'),
      modified_at: modified,
      path: this.path,
      max_bytes: MAX_CONTEXT_BYTES,
    };
  }

  /**
   * Replace it. Written atomically, for the same reason `state.ts` writes JSON that way:
   * a turn may be reading this file while the operator saves, and half a prompt is worse
   * than either version of it.
   */
  async write(text: string): Promise<ContextDoc> {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_CONTEXT_BYTES) throw new ContextTooLarge(bytes);

    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${++writeSeq}`;
    try {
      await fs.writeFile(tmp, text, 'utf8');
      await fs.rename(tmp, this.path);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return this.read();
  }
}

/** Distinguishes concurrent writes within this process — see `state.ts`. */
let writeSeq = 0;
