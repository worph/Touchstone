/**
 * The administrator chat, over HTTP.
 *
 * Three routes. The interesting one streams, because a turn takes tens of seconds and shows
 * its work as it goes — a spinner that resolves into three paragraphs is a worse answer than
 * the same three paragraphs arriving as they are decided.
 *
 * Two properties worth keeping:
 *
 * - **Guards run before the socket is hijacked.** A refusal is ordinary JSON with a status
 *   code, never an empty event stream that the browser has to interpret.
 * - **The turn is detached from the request.** If the browser goes away mid-turn the rows
 *   keep being written, and `GET /chat` recovers them. The transcript is the record; the
 *   stream is only a faster way to watch it being written.
 */

import type { FastifyPluginAsync } from 'fastify';

import { runTurn } from '../chat/loop.js';
import type { ChatToolContext } from '../chat/registry.js';
import { ChatThreads, type ChatMessage } from '../chat/thread.js';
import type { AskOptions } from '../chat/driver.js';
import type { EventLog } from '../services/events.js';
import type { PortProber } from '../services/ports.js';

export interface ChatRoutesOptions {
  threads?: ChatThreads;
  ctx?: ChatToolContext;
  events?: EventLog;
  ports?: PortProber;
  /** The prompt template, read once at boot. */
  template?: string;
  ask?: AskOptions;
  /** The inference-free "what is happening" block handed to the model. */
  status?: () => Promise<string>;
}

/** Ping often enough that no proxy between here and the browser calls the socket idle. */
const HEARTBEAT_MS = 15_000;

const routes: FastifyPluginAsync<ChatRoutesOptions> = async (app, options) => {
  const threads = options.threads;

  /**
   * One turn at a time, per thread.
   *
   * In memory, and that is sound for the same reason the runner's single-flight guard is:
   * one instance, one process. It exists to refuse a second turn on a conversation that is
   * already thinking, not to survive a restart — a turn interrupted by one genuinely is not
   * running any more.
   */
  const inFlight = new Set<string>();

  app.get('/chat', async () => {
    if (!threads) return { thread_id: null, messages: [], running: false, available: false };
    const current = threads.current();
    return {
      thread_id: current?.id ?? null,
      messages: current ? await threads.list(current.id) : [],
      running: current ? inFlight.has(current.id) : false,
      available: agentReachable(),
    };
  });

  app.delete('/chat', async (_req, reply) => {
    if (!threads) return reply.code(503).send({ error: 'the chat is not wired' });
    const current = threads.current();
    if (current && inFlight.has(current.id)) {
      return reply.code(409).send({ error: 'this conversation is still thinking — wait for it to finish' });
    }
    const fresh = await threads.start();
    return { thread_id: fresh.id, messages: [] };
  });

  /**
   * Whether there is anything to think with.
   *
   * Asked of the prober rather than by making a call: the answer has to be available before
   * the socket is hijacked, and it is already being measured every five minutes.
   */
  function agentReachable(): boolean {
    const ports = options.ports?.list() ?? [];
    const agent = ports.find((p) => p.kind === 'agent');
    // No prober configured is not evidence of absence — let the turn try and report honestly.
    return !agent || agent.status !== 'unreachable';
  }

  app.post<{ Body?: { message?: string } }>('/chat/messages', async (req, reply) => {
    const message = String(req.body?.message ?? '').trim();
    if (!message) return reply.code(400).send({ error: 'a message is required' });
    if (message.length > 8_000) return reply.code(400).send({ error: 'that message is too long' });
    if (!threads || !options.template) return reply.code(503).send({ error: 'the chat is not wired' });
    if (!agentReachable()) {
      return reply.code(503).send({
        error: 'the agent is not answering, so there is nothing to think with — see Activity for its state',
      });
    }

    const thread = await threads.forTurn();
    if (inFlight.has(thread.id)) {
      return reply.code(409).send({ error: 'this conversation is already thinking — wait for it to finish' });
    }
    inFlight.add(thread.id);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tell any reverse proxy not to buffer it, or the stream arrives all at once at the end.
      'x-accel-buffering': 'no',
    });

    let open = true;
    const frame = (event: string, data: unknown) => {
      if (!open) return;
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const beat = setInterval(() => {
      if (open) raw.write(': ping\n\n');
    }, HEARTBEAT_MS);

    // Only stop *writing*; the turn keeps going and keeps recording.
    raw.on('close', () => {
      open = false;
      clearInterval(beat);
    });

    frame('open', { thread_id: thread.id });
    try {
      await runTurn(options.template, {
        threads,
        threadId: thread.id,
        message,
        ctx: options.ctx ?? {},
        ...(options.events ? { events: options.events } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.ask ? { ask: options.ask } : {}),
        onMessage: (row: ChatMessage) => frame('message', row),
      });
      frame('done', { thread_id: thread.id });
    } catch (err) {
      // `runTurn` turns ordinary failures into messages, so anything here is a bug rather
      // than a bad answer — and it still has to reach the browser as something readable.
      app.log.error({ err }, 'chat turn threw');
      frame('error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      inFlight.delete(thread.id);
      clearInterval(beat);
      if (open) raw.end();
    }
  });
};

export default routes;
