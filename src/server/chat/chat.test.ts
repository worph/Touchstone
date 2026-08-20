/**
 * The chat's bounds and its refusals.
 *
 * These test the parts that decide whether a turn can misbehave: how many tools it may call,
 * whether it can call one that does not exist, and whether a failure reaches the operator as
 * a sentence rather than as a stack trace. The tool handlers themselves are thin wrappers and
 * are covered where the thing they wrap is.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '../services/events.js';
import { extractJson } from './driver.js';
import { dispatch, runTurn } from './loop.js';
import { ChatThreads } from './thread.js';
import { renderCatalogue } from './catalogue.js';
import { CHAT_TOOLS } from './registry.js';

let dir: string;
let events: EventLog;
let threads: ChatThreads;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-chat-'));
  events = new EventLog(dir);
  await events.load();
  threads = new ChatThreads(dir);
  await threads.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const TEMPLATE = 'catalogue: {{CATALOGUE}}\nstatus: {{STATUS}}\nhistory: {{HISTORY}}\nsaid: {{MESSAGE}}\nbudget: {{BUDGET}}\nshape: {{SHAPE}}';

/** An agent that answers with whatever is scripted, in order. */
function scripted(answers: string[]) {
  let n = 0;
  return async () => {
    const text = answers[Math.min(n++, answers.length - 1)]!;
    return { ok: true as const, text, payload: text };
  };
}

async function turn(message: string, answers: string[], ctx = {}) {
  const thread = await threads.forTurn();
  await runTurn(TEMPLATE, {
    threads,
    threadId: thread.id,
    message,
    ctx,
    events,
    ask: { callImpl: scripted(answers) as never },
  });
  return threads.list(thread.id);
}

describe('extracting the answer', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"say":"hi","call":null}')).toBe('{"say":"hi","call":null}');
  });

  it('reads one wrapped in a fence, which is what the agent usually does', () => {
    expect(extractJson('```json\n{"say":"hi"}\n```')).toBe('{"say":"hi"}');
  });

  it('reads one with prose around it', () => {
    expect(extractJson('Sure thing.\n{"say":"hi"}\nHope that helps.')).toBe('{"say":"hi"}');
  });

  /**
   * The bug this file exists to prevent. A brace inside a string literal is not structure,
   * and `lastIndexOf('}')` on an answer with prose after it takes the wrong end — both cost
   * this codebase a complete, correct report before now.
   */
  it('is not fooled by braces inside strings', () => {
    const json = '{"say":"use {this} and \\"that\\"","call":null}';
    expect(extractJson(`noise ${json} trailing }`)).toBe(json);
  });

  it('says so rather than guessing when there is no object', () => {
    expect(extractJson('I could not do that.')).toBeNull();
    expect(extractJson('{"unclosed": true')).toBeNull();
  });
});

describe('dispatching a call', () => {
  it('refuses a tool that does not exist, in words the model can act on', async () => {
    const step = await dispatch({ tool: 'delete_everything', input: {} }, {});
    expect(step.ok).toBe(false);
    expect(step.text).toContain('no tool called');
  });

  it('refuses a call that is missing a required argument', async () => {
    const step = await dispatch({ tool: 'run_assay', input: {} }, {});
    expect(step.ok).toBe(false);
    expect(step.text).toContain('subject');
  });

  it('turns a throwing handler into a failed step, not a dead turn', async () => {
    const rows = await turn('go', [
      JSON.stringify({ say: '', call: { tool: 'get_status', input: {} } }),
      JSON.stringify({ say: 'done', call: null }),
    ], {
      runner: {
        get enabled() {
          throw new Error('the runner exploded');
        },
      } as never,
    });
    const tool = rows.find((r) => r.role === 'tool');
    expect(tool?.ok).toBe(false);
    expect(rows.at(-1)?.content).toBe('done');
  });
});

describe('one turn', () => {
  it('writes the operator\'s words before it thinks about them', async () => {
    const rows = await turn('hello', [JSON.stringify({ say: 'hi', call: null })]);
    expect(rows[0]).toMatchObject({ role: 'user', content: 'hello' });
    expect(rows[1]).toMatchObject({ role: 'assistant', content: 'hi' });
  });

  it('stops at the call bound and says why', async () => {
    const forever = JSON.stringify({ say: '', call: { tool: 'get_status', input: {} } });
    const thread = await threads.forTurn();
    await runTurn(TEMPLATE, {
      threads,
      threadId: thread.id,
      message: 'loop please',
      ctx: {},
      events,
      maxCalls: 2,
      ask: { callImpl: scripted([forever]) as never },
    });
    const rows = await threads.list(thread.id);
    expect(rows.filter((r) => r.role === 'tool')).toHaveLength(2);
    expect(rows.at(-1)?.content).toContain('more than 2 steps');
    await events.flush();
    expect(events.query({ code: 'CHAT_TURN_FAILED' })).toHaveLength(1);
  });

  it('answers in the conversation when the agent will not answer at all', async () => {
    const thread = await threads.forTurn();
    await runTurn(TEMPLATE, {
      threads,
      threadId: thread.id,
      message: 'hello',
      ctx: {},
      events,
      ask: {
        callImpl: (async () => ({ ok: false as const, errorText: 'HTTPStatusError 409 busy' })) as never,
      },
    });
    const rows = await threads.list(thread.id);
    // The 409 the runner calls `agent-busy` must read as contention here too, not as a crash.
    expect(rows.at(-1)?.content).toMatch(/could not finish/);
    expect(rows.at(-1)?.content).toMatch(/busy/);
  });

  /**
   * The collision that will actually happen: starting an audit takes the one agent, so the
   * round where the model would have said "started" cannot run. The operator must still be
   * told what happened, because it did happen.
   */
  it('reports the work it did when the agent is taken mid-turn', async () => {
    let n = 0;
    const thread = await threads.forTurn();
    await runTurn(TEMPLATE, {
      threads,
      threadId: thread.id,
      message: 'review something',
      ctx: {},
      events,
      ask: {
        callImpl: (async () => {
          if (n++ === 0) {
            const answer = JSON.stringify({ say: '', call: { tool: 'get_status', input: {} } });
            return { ok: true as const, text: answer, payload: answer };
          }
          return { ok: false as const, errorText: 'HTTPStatusError 409 conflict' };
        }) as never,
      },
    });
    const rows = await threads.list(thread.id);
    const last = rows.at(-1)!;
    // What the tool reported, not "I could not finish that".
    expect(last.content).toContain('No audit is running');
    expect(last.content).toContain('busy');
  });

  it('keeps a refused call in the transcript so the model can correct itself', async () => {
    const rows = await turn('audit nothing', [
      JSON.stringify({ say: '', call: { tool: 'run_assay', input: {} } }),
      JSON.stringify({ say: 'I need a name.', call: null }),
    ]);
    expect(rows.filter((r) => r.role === 'tool')).toHaveLength(1);
    expect(rows.find((r) => r.role === 'tool')?.ok).toBe(false);
  });
});

describe('the catalogue', () => {
  it('is rendered from the registry, so it cannot describe a tool that is not there', () => {
    const rendered = renderCatalogue();
    for (const tool of CHAT_TOOLS) expect(rendered).toContain(`### ${tool.name}`);
  });

  /** No tool may write a verdict — Touchstone applies the protocol's gate, not the model. */
  it('offers no way to record an outcome', () => {
    const names = CHAT_TOOLS.map((t) => t.name).join(' ');
    expect(names).not.toMatch(/record|verdict|hallmark|compliant/i);
  });
});

describe('threads on disk', () => {
  it('keeps messages append-only and rolls a stale conversation', async () => {
    const first = await threads.forTurn();
    await threads.append({ threadId: first.id, role: 'user', content: 'one' });

    const later = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const second = await threads.forTurn(later);
    expect(second.id).not.toBe(first.id);

    // The old conversation is still there — those rows say why something was done.
    expect(await threads.list(first.id)).toHaveLength(1);
  });

  it('survives a half-written line, because that is what a killed process leaves', async () => {
    const thread = await threads.forTurn();
    await threads.append({ threadId: thread.id, role: 'user', content: 'kept' });
    await fs.appendFile(path.join(dir, 'chat', `${thread.id}.jsonl`), '{"role":"user","cont');
    expect(await threads.list(thread.id)).toHaveLength(1);
  });
});
