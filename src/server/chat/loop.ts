/**
 * One turn of the administrator chat.
 *
 * **Touchstone owns the loop and the tools; the model only chooses which to call next.** It
 * answers with one JSON object naming at most one tool, this process runs it against the
 * app's own functions, and the result is written as a row *before* the next round reads it
 * back. That ordering is the design, not an implementation detail: the prompt is rebuilt from
 * stored rows every round rather than accumulated in a string, so the step the operator sees
 * and the step the model is shown next are the same row and cannot disagree — and a turn can
 * never end having reasoned over a history the transcript does not contain.
 *
 * Borrowed wholesale from Newsdesk's `chat/loop.ts`, including the bounds. A failure — a
 * bound, the clock, a dead agent — becomes a message in the conversation, never an exception:
 * the operator asked a question and is owed an answer, even when the answer is "I could not".
 */

import { askForJson, InferenceFailed, type AskOptions } from './driver.js';
import { renderCatalogue } from './catalogue.js';
import { chatTool, type ChatToolContext } from './registry.js';
import { HISTORY_MESSAGES, type ChatMessage, type ChatThreads } from './thread.js';
import type { EventLog } from '../services/events.js';

/** Beyond this a turn has lost the plot; stop and say so. */
export const MAX_CALLS = 8;

/** A human is waiting. Longer than this is a lie about who this is for. */
export const TURN_MS = 120_000;

/**
 * How much of a tool result is carried back into the prompt.
 *
 * The row keeps the full text — the transcript is authoritative — and only the prompt is cut.
 * `list_subjects` on a full store is 69 lines, and feeding that back eight times is how a
 * turn runs out of clock.
 */
export const RESULT_EXCERPT_CHARS = 4_000;

/** What the model must answer with. One tool per round, or none to finish. */
interface Answer {
  say: string;
  call: { tool: string; input: Record<string, unknown> } | null;
}

const ANSWER_SHAPE = [
  '{',
  '  "say": string,            // what to tell the operator; "" if you are only calling a tool',
  '  "call": {                 // the one tool to run now, or null when the turn is over',
  '    "tool": string,         // a name from the catalogue, exactly as written there',
  '    "input": object         // its arguments, matching that tool\'s schema',
  '  } | null',
  '}',
].join('\n');

/** Shape-only. What the arguments mean is the tool's business, checked in `dispatch`. */
function parseAnswer(value: unknown): Answer | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;
  const say = typeof obj.say === 'string' ? obj.say : '';

  if (obj.call === null || obj.call === undefined) return { say, call: null };
  if (typeof obj.call !== 'object') return null;

  const call = obj.call as Record<string, unknown>;
  if (typeof call.tool !== 'string' || !call.tool.trim()) return null;
  const input =
    typeof call.input === 'object' && call.input !== null
      ? (call.input as Record<string, unknown>)
      : {};
  return { say, call: { tool: call.tool, input } };
}

export interface StepResult {
  ok: boolean;
  text: string;
}

/**
 * Run one tool call.
 *
 * The allowlist is the *mechanism*, not a courtesy: the catalogue in the prompt tells the
 * model what exists, and this decides. Anything it cannot resolve or validate comes back as a
 * refusal the model can act on next round — spending one of its calls, which is the right
 * price for getting it wrong.
 */
export async function dispatch(
  call: { tool: string; input: Record<string, unknown> },
  ctx: ChatToolContext,
): Promise<StepResult> {
  const entry = chatTool(call.tool);
  if (!entry) {
    return {
      ok: false,
      text: `There is no tool called "${call.tool}". Use a name from the catalogue, exactly as written there.`,
    };
  }

  const missing = (entry.inputSchema.required ?? []).filter(
    (key) => call.input[key] === undefined || call.input[key] === null || call.input[key] === '',
  );
  if (missing.length > 0) {
    return { ok: false, text: `${entry.name} needs: ${missing.join(', ')}.` };
  }

  try {
    const result = await entry.handler(call.input, ctx);
    return { ok: !result.failed, text: result.text };
  } catch (err) {
    // A thrown handler is a failed step, not a dead turn.
    return { ok: false, text: err instanceof Error ? err.message : String(err) };
  }
}

export interface TurnOptions {
  threads: ChatThreads;
  threadId: string;
  message: string;
  ctx: ChatToolContext;
  events?: EventLog;
  /** Called as each row is written, so the stream can never show a step the record lacks. */
  onMessage?: (row: ChatMessage) => void;
  /** What the model is told about the app before it answers. */
  status?: () => Promise<string>;
  ask?: AskOptions;
  maxCalls?: number;
  turnMs?: number;
  now?: () => Date;
}

function excerpt(text: string): string {
  return text.length <= RESULT_EXCERPT_CHARS
    ? text
    : `${text.slice(0, RESULT_EXCERPT_CHARS)}\n…(cut, ${text.length - RESULT_EXCERPT_CHARS} more characters)`;
}

function renderHistory(rows: ChatMessage[]): string {
  if (rows.length === 0) return '(nothing has been said yet)';
  return rows
    .map((row) => {
      if (row.role !== 'tool') return `**${row.role}:** ${row.content}`;
      return [
        `**tool ${row.tool_name ?? '?'} (${row.ok ? 'result' : 'refused'})**`,
        '```json',
        JSON.stringify(row.tool_input ?? {}),
        '```',
        excerpt(row.content),
      ].join('\n');
    })
    .join('\n\n');
}

export function buildPrompt(input: {
  template: string;
  history: ChatMessage[];
  message: string;
  status: string;
  callsUsed: number;
  maxCalls: number;
  msLeft: number;
}): string {
  return input.template
    .split('{{CATALOGUE}}')
    .join(renderCatalogue())
    .split('{{STATUS}}')
    .join(input.status)
    .split('{{HISTORY}}')
    .join(renderHistory(input.history))
    .split('{{MESSAGE}}')
    .join(input.message)
    .split('{{BUDGET}}')
    .join(
      `Call ${input.callsUsed + 1} of ${input.maxCalls}. ${Math.max(0, Math.round(input.msLeft / 1000))} second(s) left in this turn.`,
    )
    .split('{{SHAPE}}')
    .join(ANSWER_SHAPE);
}

/**
 * One turn, start to finish. Resolves when there is nothing left to say.
 *
 * Never rejects for an ordinary failure — see the file docstring.
 */
export async function runTurn(template: string, opts: TurnOptions): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const maxCalls = opts.maxCalls ?? MAX_CALLS;
  const deadline = now().getTime() + (opts.turnMs ?? TURN_MS);

  const write = async (row: Parameters<ChatThreads['append']>[0]) => {
    const written = await opts.threads.append(row, now());
    opts.onMessage?.(written);
    return written;
  };

  // The operator's own words are a row before any inference happens, so a turn that dies
  // mid-thought still leaves the question in the transcript.
  await write({ threadId: opts.threadId, role: 'user', content: opts.message });

  let calls = 0;
  let failure: string | null = null;
  /**
   * What the last successful tool call reported.
   *
   * Kept because of one specific, expected collision: `run_assay` starts an audit, the audit
   * takes the single agent for minutes, and the model's *next* round — the one where it would
   * have said "I started it" — finds the agent busy. Ending on "I could not finish that"
   * would be both true and a lie: the thing the operator asked for is running. So when a turn
   * dies after doing real work, the work is what gets reported.
   */
  let lastGood: string | null = null;

  /**
   * The tools this turn calls run against the app's own functions, so they belong to this
   * conversation. `threadId` is added here rather than by the caller because it is a property
   * of the turn, not of the wiring — and it is deliberately not something the model can set.
   */
  const ctx = { ...opts.ctx, threadId: opts.threadId };

  // The `+ 1` is the model's chance to *speak* after its last call, not another call.
  for (let round = 1; round <= maxCalls + 1; round++) {
    const msLeft = deadline - now().getTime();
    if (msLeft <= 0) {
      failure = 'the turn ran out of time';
      break;
    }

    /**
     * Read every round, not once per turn.
     *
     * A turn lasts up to two minutes and its own `run_assay` changes the answer, so a block
     * captured before the first round describes an app that no longer exists by the third.
     * It is an in-process read of state already in memory; the cost is nothing and the
     * alternative is the model reasoning from a status that its own last call invalidated.
     */
    const status = opts.status ? await opts.status().catch(() => 'unavailable') : 'unavailable';
    const history = await opts.threads.list(opts.threadId, HISTORY_MESSAGES);
    const prompt = buildPrompt({
      template,
      history,
      message: opts.message,
      status,
      callsUsed: calls,
      maxCalls,
      msLeft,
    });

    let answer: Answer;
    try {
      answer = await askForJson(prompt, parseAnswer, {
        ...opts.ask,
        timeoutMs: Math.min(opts.ask?.timeoutMs ?? 60_000, Math.max(1_000, msLeft)),
      });
    } catch (err) {
      failure = err instanceof InferenceFailed ? err.message : String(err);
      break;
    }

    if (answer.say.trim()) {
      await write({ threadId: opts.threadId, role: 'assistant', content: answer.say.trim() });
    }
    if (!answer.call) return;

    if (calls >= maxCalls) {
      failure = `it needed more than ${maxCalls} steps`;
      break;
    }
    calls++;

    const step = await dispatch(answer.call, ctx);
    await write({
      threadId: opts.threadId,
      role: 'tool',
      content: step.text,
      toolName: answer.call.tool,
      toolInput: answer.call.input,
      ok: step.ok,
    });
    if (step.ok) lastGood = step.text;
    if (!step.ok) {
      opts.events?.log({
        level: 'warn',
        code: 'CHAT_TOOL_FAILED',
        message: 'A tool the assistant called did not do what it asked',
        detail: { tool: answer.call.tool, error: step.text.slice(0, 500) },
      });
    }
  }

  if (failure) {
    opts.events?.log({
      level: 'error',
      code: 'CHAT_TURN_FAILED',
      message: 'The assistant could not finish answering',
      detail: { calls, error: failure },
    });
    await write({
      threadId: opts.threadId,
      role: 'assistant',
      content: lastGood
        ? `${lastGood}\n\n(I stopped there: ${failure}.)`
        : `I could not finish that: ${failure}.`,
    });
  }
}
