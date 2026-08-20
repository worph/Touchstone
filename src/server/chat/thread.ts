/**
 * The conversation, on disk.
 *
 * Newsdesk keeps threads in SQLite. Touchstone has no database and does not want one, so a
 * thread is a JSONL file and the set of them is one small index — the same shape as
 * `services/events.ts`, for the same reason: an append-only log of what was said is exactly
 * what a chat transcript is, and rewriting one to add a line is the only thing that could
 * lose it.
 *
 * **Messages are append-only and there is no edit.** "Clear the conversation" starts a new
 * thread and leaves the old file where it is: those rows record *why* a change was made,
 * which nothing else in the archive does. A thread that has been quiet for `IDLE_ROLL_MS`
 * rolls into a new one on the next turn, so a question asked on Tuesday does not arrive
 * carrying Monday's context.
 */

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { ChatMessage, ChatRole } from '../../shared/activity.js';
import { appendJsonl, readJson, readJsonl, writeJsonAtomic } from '../store/state.js';

/** Eight hours of silence ends a conversation. */
export const IDLE_ROLL_MS = 8 * 60 * 60 * 1000;

/** How many rows the prompt carries. Beyond this the turn is reasoning over archaeology. */
export const HISTORY_MESSAGES = 20;

// The row shape is shared with the page that renders it — one definition, so a field added
// on the server cannot go missing in the browser.
export type { ChatMessage, ChatRole } from '../../shared/activity.js';

export interface AppendMessage {
  threadId: string;
  role: ChatRole;
  content: string;
  toolName?: string;
  toolInput?: unknown;
  ok?: boolean;
}

interface ThreadMeta {
  id: string;
  created_at: string;
  updated_at: string;
}

interface IndexFile {
  threads: ThreadMeta[];
}

export class ChatThreads {
  private readonly dir: string;
  private readonly indexFile: string;
  private threads: ThreadMeta[] = [];
  /** Serialises appends. Two turns cannot run at once, but a reload during one can. */
  private writing: Promise<void> = Promise.resolve();

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, 'chat');
    this.indexFile = path.join(this.dir, 'index.json');
  }

  async load(): Promise<void> {
    const file = await readJson<IndexFile>(this.indexFile, { threads: [] });
    this.threads = Array.isArray(file.threads) ? file.threads : [];
  }

  private fileFor(id: string): string {
    return path.join(this.dir, `${id}.jsonl`);
  }

  /**
   * The thread a turn should join, or null when the newest one has gone stale.
   *
   * An unparseable `updated_at` yields `NaN > IDLE_ROLL_MS === false`, which *keeps* the
   * thread. That is the safe direction: a bad timestamp should not silently start a new
   * conversation on every message and scatter one exchange across ten files.
   */
  current(now: Date = new Date()): ThreadMeta | null {
    const newest = this.threads[this.threads.length - 1];
    if (!newest) return null;
    const idle = now.getTime() - Date.parse(newest.updated_at);
    return idle > IDLE_ROLL_MS ? null : newest;
  }

  async start(now: Date = new Date()): Promise<ThreadMeta> {
    const at = now.toISOString();
    const meta: ThreadMeta = { id: randomUUID(), created_at: at, updated_at: at };
    this.threads.push(meta);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.fileFor(meta.id), '', 'utf8');
    await writeJsonAtomic(this.indexFile, { threads: this.threads } satisfies IndexFile);
    return meta;
  }

  /** The thread this turn belongs to: the live one, or a fresh one. */
  async forTurn(now: Date = new Date()): Promise<ThreadMeta> {
    return this.current(now) ?? (await this.start(now));
  }

  async append(msg: AppendMessage, now: Date = new Date()): Promise<ChatMessage> {
    const row: ChatMessage = {
      id: randomUUID(),
      thread_id: msg.threadId,
      role: msg.role,
      content: msg.content,
      ...(msg.toolName ? { tool_name: msg.toolName } : {}),
      ...(msg.toolInput === undefined ? {} : { tool_input: msg.toolInput }),
      ...(msg.ok === undefined ? {} : { ok: msg.ok }),
      at: now.toISOString(),
    };

    const write = this.writing.then(async () => {
      await appendJsonl(this.fileFor(msg.threadId), row);
      const meta = this.threads.find((t) => t.id === msg.threadId);
      if (meta) {
        meta.updated_at = row.at;
        await writeJsonAtomic(this.indexFile, { threads: this.threads } satisfies IndexFile);
      }
    });
    this.writing = write.catch(() => {});
    await write;
    return row;
  }

  /**
   * The last `limit` rows, oldest first.
   *
   * Windowing happens here rather than at the reader, because every caller wants the same
   * window and one of them getting it wrong is how a prompt silently doubles in size.
   */
  async list(threadId: string, limit?: number): Promise<ChatMessage[]> {
    // `readJsonl` already drops the half-written trailing line a killed process leaves, and
    // walks backwards when a limit is set — a long conversation should not be fully parsed
    // to render twenty rows.
    return readJsonl<ChatMessage>(this.fileFor(threadId), limit === undefined ? {} : { limit });
  }
}
