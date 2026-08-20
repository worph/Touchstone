/**
 * Asking the agent one question and getting one JSON object back.
 *
 * The chat runs on the **same** Claude Code endpoint the runner audits with — no second
 * credential, no second dependency, and nothing new pointing outside the box. What differs is
 * the shape of the ask: an audit is one four-hour call, a chat turn is a short question a
 * person is waiting on, so this caps at a minute and retries once.
 *
 * `extractJson` is the part worth reading carefully. Touchstone has been bitten twice by
 * naive brace-matching (HANDOFF §4g): a report is 30 KB of JSON with fenced markdown inside
 * it, and both `indexOf('{')`/`lastIndexOf('}')` and "unwrap the first fence" threw away
 * complete, correct answers. So the scan below is balanced *and* string-aware — braces inside
 * string literals and escaped quotes do not move the depth counter.
 */

import { classify, postToAgent, type AgentOptions } from '../runner/agent.js';

/** A person is waiting. Longer than this is a lie about who the answer is for. */
export const CALL_TIMEOUT_MS = 60_000;

/** Two attempts, then give up: a reworded prompt cannot fix a broken endpoint. */
export const ATTEMPTS = 2;

export class InferenceFailed extends Error {
  constructor(
    message: string,
    readonly lastText: string,
  ) {
    super(message);
    this.name = 'InferenceFailed';
  }
}

/**
 * The first complete JSON value in a blob of text, or null.
 *
 * Returns null rather than guessing. A caller that gets null can say "that did not parse" and
 * retry; a caller handed a truncated object cannot tell it is holding one.
 */
export function extractJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // A whole-answer fence is the common shape and worth handling before scanning.
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  const body = fenced?.[1]?.trim() ?? trimmed;

  const start = body.search(/[{[]/);
  if (start === -1) return null;

  const open = body[start]!;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < body.length; i++) {
    const ch = body[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      if (inString) escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

export interface AskOptions {
  agent?: AgentOptions;
  timeoutMs?: number;
  /** Overridden in tests so the suite does not wait on a real endpoint. */
  callImpl?: typeof postToAgent;
}

/**
 * Ask for one JSON object, validated by the caller's own parser.
 *
 * `parse` returns null for "the shape is wrong", which becomes the correction shown to the
 * agent on the second attempt. That split matters: a malformed *answer* is worth retrying,
 * while a wrong *tool argument* is not — that one comes back as a refused tool row the model
 * fixes on the next round, and it costs a call rather than a retry.
 */
export async function askForJson<T>(
  prompt: string,
  parse: (value: unknown) => T | null,
  opts: AskOptions = {},
): Promise<T> {
  const call = opts.callImpl ?? postToAgent;
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;
  let lastError = 'no answer';
  let lastText = '';

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const ask =
      attempt === 1
        ? prompt
        : `${prompt}\n\nYour previous response could not be used:\n${lastError}\n\nReturn only the corrected JSON object.`;

    const outcome = await call(ask, {
      ...opts.agent,
      // Under ours, so the agent's own message surfaces instead of an opaque abort.
      timeoutS: Math.max(15, Math.floor(timeoutMs / 1000) - 5),
    });

    if (!outcome.ok) {
      // A dead, logged-out or busy endpoint is not something rewording fixes. `classify` is
      // reused so the chat names contention exactly as the runner does — a 409 while an audit
      // holds the agent is the expected case here, not an anomaly.
      const why = classify(outcome.errorText);
      const named = why.ok ? 'unknown' : why.error;
      throw new InferenceFailed(
        named === 'agent-busy'
          ? 'the agent is busy with another job — it runs one thing at a time'
          : `the agent did not answer (${named})`,
        outcome.errorText,
      );
    }

    lastText = outcome.text;
    const json = extractJson(lastText);
    if (!json) {
      lastError = 'there was no JSON object in it';
      continue;
    }
    try {
      const parsed = parse(JSON.parse(json) as unknown);
      if (parsed) return parsed;
      lastError = 'the JSON did not have the expected shape';
    } catch (err) {
      lastError = `the JSON would not parse: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  throw new InferenceFailed(
    `the agent did not produce a usable answer after ${ATTEMPTS} attempts: ${lastError}`,
    lastText,
  );
}
