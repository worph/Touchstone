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

import { memoryStore } from '../domain/fixtures.js';
import { EventLog } from '../services/events.js';
import { extractJson } from './driver.js';
import { buildPrompt, dispatch, runTurn } from './loop.js';
import { ChatThreads } from './thread.js';
import { renderCatalogue } from './catalogue.js';
import { CHAT_TOOLS } from './registry.js';
import { ProtocolStore } from '../store/protocols.js';
import { RevisionStore } from '../store/revisions.js';
import { StoreDocReader } from '../services/storedoc.js';
import { TrialStore } from '../store/trials.js';
import { UploadStore } from '../store/uploads.js';

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

const TEMPLATE = 'catalogue: {{CATALOGUE}}\ncontext: {{CONTEXT}}\nstatus: {{STATUS}}\nhistory: {{HISTORY}}\nsaid: {{MESSAGE}}\nbudget: {{BUDGET}}\nshape: {{SHAPE}}';

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

describe('the operator context, in a turn', () => {
  it('is read once per turn and reaches every round', async () => {
    const prompts: string[] = [];
    let reads = 0;
    const thread = await threads.forTurn();
    await runTurn(TEMPLATE, {
      threads,
      threadId: thread.id,
      message: 'what is going on?',
      ctx: {},
      events,
      context: async () => {
        reads++;
        return 'Ignore the Alpha app; it is a fixture.';
      },
      ask: {
        callImpl: (async (prompt: string) => {
          prompts.push(prompt);
          const text =
            prompts.length === 1
              ? '{"say":"","call":{"tool":"get_status","input":{}}}'
              : '{"say":"nothing is running","call":null}';
          return { ok: true as const, text, payload: text };
        }) as never,
      },
    });
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) expect(prompt).toContain('Ignore the Alpha app');
    // Once for the turn, not once per round: nothing the model does can change a standing
    // instruction, and two rounds of one answer must not be given different ones.
    expect(reads).toBe(1);
  });

  it('costs the background rather than the turn when it cannot be read', async () => {
    const thread = await threads.forTurn();
    await runTurn(TEMPLATE, {
      threads,
      threadId: thread.id,
      message: 'hello',
      ctx: {},
      events,
      context: async () => {
        throw new Error('EACCES');
      },
      ask: { callImpl: scripted(['{"say":"hello back","call":null}']) as never },
    });
    const rows = await threads.list(thread.id);
    expect(rows.at(-1)?.content).toBe('hello back');
  });
});

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

/**
 * The failure these exist for.
 *
 * An audit of FileBrowser started from the chat, the API restarted 27 seconds later, and when
 * the operator asked what came of it the assistant said "nothing yet" — over an archive holding
 * ten assays of that app. Everything it could see was the live process, and the live process
 * is the one thing a restart empties.
 */
describe('reading what was written down', () => {
  const registry = { list: () => ['yundera~OpenClaw', 'yundera~NeverAssayed'] } as never;
  const archive = { store: memoryStore(), registry };

  it('answers about a finished audit that the live status has forgotten', async () => {
    const forgetful = {
      ...archive,
      runner: { enabled: true, busy: false, status: () => ({ running: null, last: null }) },
    } as never;

    const status = await dispatch({ tool: 'get_status', input: {} }, forgetful);
    // It must not leave that reading as "nothing has ever been audited".
    expect(status.text).toContain('Nothing has finished since this process started');
    expect(status.text).toContain('get_subject');

    const subject = await dispatch({ tool: 'get_subject', input: { subject: 'openclaw' } }, forgetful);
    expect(subject.ok).toBe(true);
    expect(subject.text).toContain('non-compliant');
    expect(subject.text).toContain('risk 232');
  });

  /** Invariant 4: blocked is infra, and it never retracts the verdict the subject carries. */
  it('reads a blocked section as infra, not as a result about the app', async () => {
    const res = await dispatch({ tool: 'get_subject', input: { subject: 'OpenClaw' } }, archive as never);
    expect(res.text).toContain('functional: blocked — bench_unavailable');
    expect(res.text).toContain('nothing was decided about the app');
    expect(res.text).toContain('The verdict it still carries is compliant');
  });

  it('knows the difference between never assayed and not a subject', async () => {
    const never = await dispatch({ tool: 'get_subject', input: { subject: 'NeverAssayed' } }, archive as never);
    expect(never.ok).toBe(true);
    expect(never.text).toContain('no assay of it exists yet');

    const nobody = await dispatch({ tool: 'get_subject', input: { subject: 'Nonesuch' } }, archive as never);
    expect(nobody.ok).toBe(false);
    expect(nobody.text).toContain('list_subjects');
  });

  it('hands back the fix brief, and refuses rather than implying a clean bill', async () => {
    const brief = await dispatch({ tool: 'get_fix_brief', input: { subject: 'OpenClaw' } }, archive as never);
    expect(brief.ok).toBe(true);
    expect(brief.text).toContain('# Fix OpenClaw');

    const none = await dispatch({ tool: 'get_fix_brief', input: { subject: 'NeverAssayed' } }, archive as never);
    expect(none.ok).toBe(false);
    expect(none.text).toContain('no assay');
  });

  it('shows how a run ended — including one a restart cut short', async () => {
    events.log({
      level: 'info',
      code: 'ASSAY_STARTED',
      message: 'An audit has started',
      subject: 'yundera~OpenClaw',
      detail: { subject: 'yundera~OpenClaw', sections: ['static'], try_n: 1, bench: null, browser: null },
    });
    events.log({ level: 'info', code: 'SERVER_STARTED', message: 'Touchstone started and read the archive' });
    await events.flush();

    const res = await dispatch({ tool: 'list_activity', input: {} }, { ...archive, events } as never);
    expect(res.ok).toBe(true);
    // Oldest first: the turn reads it as a story, and the restart has to come after the start.
    expect(res.text.indexOf('ASSAY_STARTED')).toBeLessThan(res.text.indexOf('SERVER_STARTED'));
    expect(res.text).toContain('OpenClaw');

    const scoped = await dispatch(
      { tool: 'list_activity', input: { subject: 'openclaw' } },
      { ...archive, events } as never,
    );
    // A bare name resolves to the key the log actually writes, or it matches nothing at all.
    expect(scoped.text).toContain('ASSAY_STARTED');
  });

  /**
   * The board exists so "what is failing" is one call. The thing it must not lose on the way
   * to one line per app is invariant 4 — a blocked section is infra, and a model scanning
   * sixty rows will otherwise count it as a second failure of the app.
   */
  it('puts every app on one board, worst first, with blocked still spelled as infra', async () => {
    const res = await dispatch({ tool: 'get_board', input: {} }, archive as never);
    expect(res.ok).toBe(true);

    const lines = res.text.split('\n');
    expect(lines[0]).toMatch(/app\(s\), worst risk first/);

    // Every subject in the archive gets a row, and OpenClaw's risk 232 puts it above the rest.
    expect(res.text).toContain('OpenClaw');
    expect(res.text).toContain('Prowlarr');
    const risks = lines
      .slice(1)
      .map((line) => Number(/risk (\d+)/.exec(line)?.[1] ?? '0'));
    expect(risks).toEqual([...risks].sort((a, b) => b - a));

    // Infra, not a verdict — and the word "blocked" never stands on its own.
    expect(res.text).toMatch(/functional blocked \(infra: bench_unavailable\)/);
  });

  it('says the board is empty rather than implying every app passed', async () => {
    const res = await dispatch({ tool: 'get_board', input: {} }, { store: memoryStore([]) } as never);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('Nothing has been audited yet');
    expect(res.text).toContain('list_subjects');
  });

  /**
   * `get_fix_brief` quotes the failures and lists the passes as bare ids. The file is the only
   * place the evidence behind a *pass* survives, which is the whole reason this tool exists.
   */
  it('hands back the report file itself, newest section by default', async () => {
    const res = await dispatch({ tool: 'get_report', input: { subject: 'OpenClaw' } }, archive as never);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('# Yundera/AppStore — OpenClaw');
    expect(res.text).toContain('## Evidence');
  });

  it('reads a named section, and names the ones it has when asked for one it has not', async () => {
    const good = await dispatch(
      { tool: 'get_report', input: { subject: 'OpenClaw', section: 'static' } },
      archive as never,
    );
    expect(good.ok).toBe(true);
    expect(good.text).toContain('OpenClaw');

    const bad = await dispatch(
      { tool: 'get_report', input: { subject: 'OpenClaw', section: 'security' } },
      archive as never,
    );
    expect(bad.ok).toBe(false);
    expect(bad.text).toContain('no security report');
    expect(bad.text).toContain('static');
  });

  it('refuses to read a report for an app that has never been assayed', async () => {
    const res = await dispatch({ tool: 'get_report', input: { subject: 'NeverAssayed' } }, archive as never);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('no assay of NeverAssayed');
  });

  it('refuses a level it does not know rather than silently ignoring it', async () => {
    const res = await dispatch({ tool: 'list_activity', input: { level: 'shouty' } }, { ...archive, events } as never);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('debug, info, warn, error');
  });
});

describe('a run started here reports back into the conversation', () => {
  it('gives the dispatcher the turn\'s thread, which the model never supplies', async () => {
    const started: { subject: string; threadId?: string }[] = [];
    const thread = await threads.forTurn();
    await runTurn(TEMPLATE, {
      threads,
      threadId: thread.id,
      message: 'review OpenClaw',
      ctx: {
        registry: { list: () => ['yundera~OpenClaw'] } as never,
        runner: { enabled: true, busy: false, status: () => ({ running: null, last: null }) } as never,
        startAssay: (job, opts) => started.push({ subject: job.subject, threadId: opts?.threadId }),
      },
      events,
      ask: {
        callImpl: scripted([
          JSON.stringify({ say: '', call: { tool: 'run_assay', input: { subject: 'openclaw', threadId: 'not-yours' } } }),
          JSON.stringify({ say: 'Started it.', call: null }),
        ]) as never,
      },
    });
    expect(started).toEqual([{ subject: 'yundera~OpenClaw', threadId: thread.id }]);
  });

  /**
   * What `run_assay` says back, which until 2026-08-23 was only "Started an audit of X".
   *
   * An operator who started a run into a dead demo pool learned nothing from the reply and had
   * to ask a second question; the answer they then acted on was already five minutes stale.
   * These pin the three things the reply now has to carry: which sections would run, why the
   * rest would not, and that a blocked one does not come back on its own.
   */
  async function replyTo(runner: Record<string, unknown>): Promise<string> {
    const thread = await threads.forTurn();
    await runTurn(TEMPLATE, {
      threads,
      threadId: thread.id,
      message: 'review OpenClaw',
      ctx: {
        registry: { list: () => ['yundera~OpenClaw'] } as never,
        runner: { enabled: true, busy: false, status: () => ({ running: null, last: null }), ...runner } as never,
        prober: { window: () => 'demostaging1 is mid-cleanup — usually back within minutes' } as never,
        startAssay: () => {},
      },
      events,
      ask: {
        callImpl: scripted([
          JSON.stringify({ say: '', call: { tool: 'run_assay', input: { subject: 'openclaw' } } }),
          JSON.stringify({ say: 'Started it.', call: null }),
        ]) as never,
      },
    });
    return JSON.stringify(await threads.list(thread.id));
  }

  it('names the sections that would run, the one that would not, and why', async () => {
    const text = await replyTo({
      forecast: async () => ({
        run: ['static', 'currency'],
        blocked: [{ section: 'functional', reason: 'bench_unavailable' }],
      }),
    });
    expect(text).toContain('static and currency');
    expect(text).toContain('no usable demo bench');
    // The window, so the operator has something to wait for rather than only a fault.
    expect(text).toContain('mid-cleanup');
  });

  /** The clause that would have saved the incident: nothing brings a blocked section back. */
  it('says a blocked section is not retried automatically', async () => {
    const text = await replyTo({
      forecast: async () => ({
        run: ['static'],
        blocked: [{ section: 'functional', reason: 'bench_unavailable' }],
      }),
    });
    expect(text).toContain('NOT retried automatically');
  });

  /** A forecast is not a promise — `execute()` resolves the world again at dispatch. */
  it('reads as a forecast rather than a commitment', async () => {
    const text = await replyTo({
      forecast: async () => ({ run: ['static'], blocked: [{ section: 'functional', reason: 'bench_unavailable' }] }),
    });
    expect(text).toContain('would');
    expect(text).toContain('forecast');
  });

  /**
   * The case today's reply hid completely: a run that will record nothing at all. It must not
   * read as a refusal — the runner handles this correctly and the app is charged nothing.
   */
  it('says plainly when no section could run, and that it costs the app nothing', async () => {
    const text = await replyTo({
      forecast: async () => ({
        run: [],
        blocked: [{ section: 'static', reason: 'bench_unavailable' }],
      }),
    });
    expect(text).toContain('no section could run');
    expect(text).toContain('neither a try nor its place in the backlog');
  });

  /** The lease must not leak: this registry is also served to a surface authenticating nobody. */
  it('never puts an internal endpoint in the reply', async () => {
    const text = await replyTo({
      forecast: async () => ({ run: ['static'], blocked: [] }),
    });
    expect(text).not.toContain('http://');
  });

  /** A forecast that cannot be made must not cost the operator the fact that the run started. */
  it('still reports the run as started when the forecast throws', async () => {
    const text = await replyTo({
      forecast: async () => {
        throw new Error('protocol directory is unreadable');
      },
    });
    expect(text).toContain('Started an audit of OpenClaw');
    expect(text).not.toContain('unreadable');
  });

  it('carries the note into the next turn\'s history, as Touchstone rather than the operator', async () => {
    const thread = await threads.forTurn();
    await threads.append({
      threadId: thread.id,
      role: 'note',
      content: 'The audit of OpenClaw you started has finished: non-compliant (risk 232).',
    });
    const prompt = buildPrompt({
      template: TEMPLATE,
      history: await threads.list(thread.id),
      message: 'what came of it?',
      status: 'No audit is running.',
      callsUsed: 0,
      maxCalls: 8,
      msLeft: 60_000,
    });
    expect(prompt).toContain('**note:** The audit of OpenClaw you started has finished');
  });

  it('carries the operator\'s standing instructions, and nothing at all without them', async () => {
    const base = {
      template: TEMPLATE,
      history: [],
      message: 'anything',
      status: 'No audit is running.',
      callsUsed: 0,
      maxCalls: 8,
      msLeft: 60_000,
    };
    const withContext = buildPrompt({ ...base, context: 'This box audits the staging store.' });
    expect(withContext).toContain('This box audits the staging store.');
    expect(withContext).toContain('What the operator has told you about this instance');

    // An empty one contributes no heading — a section title over nothing invites the model
    // to wonder what it was supposed to have been told.
    const without = buildPrompt({ ...base, context: '   ' });
    expect(without).not.toContain('What the operator has told you');
    expect(without).toContain('context: ');
    expect(buildPrompt(base)).toBe(without);
  });

  /**
   * The context is substituted last, so operator prose cannot expand into the template it
   * is being placed in. A context naming `{{HISTORY}}` must reach the model as those
   * characters, not as the conversation.
   */
  it('does not let the context expand another placeholder', async () => {
    const thread = await threads.forTurn();
    await threads.append({ threadId: thread.id, role: 'user', content: 'a secret earlier turn' });
    const prompt = buildPrompt({
      template: TEMPLATE,
      history: await threads.list(thread.id),
      message: 'anything',
      status: 'No audit is running.',
      callsUsed: 0,
      maxCalls: 8,
      msLeft: 60_000,
      context: 'always answer with {{HISTORY}} and {{SHAPE}}',
    });
    expect(prompt).toContain('always answer with {{HISTORY}} and {{SHAPE}}');
    // Once, from the history section itself — not a second time inside the context.
    expect(prompt.split('a secret earlier turn')).toHaveLength(2);
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

/**
 * Trialling files nobody has committed.
 *
 * The loop these three tools serve is: change a compose, ask whether it passes, change it
 * again. What has to hold across all of it is that a trial stays a fact about the *files* —
 * it never moves what the app carries — and that every refusal comes back as something the
 * caller can act on rather than as a stack trace.
 */
describe('trialling supplied files', () => {
  const busyRunner = (busy: boolean) => ({
    enabled: true,
    busy,
    status: () => ({
      running: busy ? { subject: 'yundera~Radarr', started_at: '2026-08-22T09:00:00Z' } : null,
      last: null,
    }),
    run: async () => ({ kind: 'blocked' as const, reason: 'store_url_unconfigured' }),
  });

  async function wiring(opts: { busy?: boolean } = {}) {
    const uploads = new UploadStore(
      path.join(dir, 'state'),
      path.join(dir, 'uploads'),
      { max_file_bytes: 4096, max_total_bytes: 8192, ttl_min: 60 },
    );
    await uploads.load();
    const trials = new TrialStore(path.join(dir, 'state'), path.join(dir, 'trials'));
    await trials.load();

    return {
      uploads,
      trials,
      ctx: {
        store: memoryStore(),
        registry: { list: () => ['yundera~OpenClaw'] },
        originRepo: (origin: string) => (origin === 'yundera' ? 'Yundera/AppStore' : undefined),
        trials: {
          runner: busyRunner(opts.busy ?? false),
          trials,
          uploads,
          trialsRoot: path.join(dir, 'trials'),
        },
      } as never,
    };
  }

  it('opens a session, inheriting the store the app already belongs to', async () => {
    const { ctx, uploads } = await wiring();
    const res = await dispatch({ tool: 'open_trial', input: { subject: 'openclaw' } }, ctx);

    expect(res.ok).toBe(true);
    // The nominal repo is in the answer, because it is what the assets rule and
    // CONTRIBUTING.md will be resolved against — not somewhere the files come from.
    expect(res.text).toContain('Yundera/AppStore@main');
    expect(res.text).toContain('/api/v1/uploads/');
    expect(res.text).toContain('run_trial');

    const [session] = uploads.list();
    expect(session?.subject).toBe('OpenClaw');
    expect(session?.repo).toBe('Yundera/AppStore');
  });

  it('refuses an app it cannot name a store for, rather than guessing one', async () => {
    const { ctx } = await wiring();
    const bare = { ...(ctx as Record<string, unknown>), originRepo: undefined } as never;
    const res = await dispatch({ tool: 'open_trial', input: { subject: 'openclaw' } }, bare);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('repo as owner/name');
  });

  it('will not run a session with no compose in it', async () => {
    const { ctx, uploads } = await wiring();
    const session = await uploads.create({ subject: 'OpenClaw', repo: 'Yundera/AppStore' });

    const res = await dispatch({ tool: 'run_trial', input: { upload: session.id } }, ctx);
    expect(res.ok).toBe(false);
    // Better here than eight minutes later as a finding about an app with no compose file.
    expect(res.text).toContain('no docker-compose.yml');
  });

  it('starts a trial, and says what it is judging the files as', async () => {
    const { ctx, uploads, trials } = await wiring();
    const session = await uploads.create({ subject: 'OpenClaw', repo: 'Yundera/AppStore' });
    await uploads.put(session, 'docker-compose.yml', Buffer.from('name: openclaw\n'));

    const res = await dispatch({ tool: 'run_trial', input: { upload: session.id } }, ctx);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Yundera/AppStore@main');
    expect(res.text).toContain('get_trial');

    const [record] = trials.list();
    expect(record?.upload_id).toBe(session.id);
    // Provenance is a field, not a slug shape: one kind of trial, one kind of slug, named for
    // the app it is about.
    expect(record?.source_url).toBe(`upload:${session.id}`);
    expect(record?.slug.startsWith('OpenClaw@')).toBe(true);
  });

  it('reports the run in progress instead of queueing behind it', async () => {
    const { ctx, uploads } = await wiring({ busy: true });
    const session = await uploads.create({ subject: 'OpenClaw', repo: 'Yundera/AppStore' });
    await uploads.put(session, 'docker-compose.yml', Buffer.from('name: openclaw\n'));

    const res = await dispatch({ tool: 'run_trial', input: { upload: session.id } }, ctx);
    expect(res.ok).toBe(false);
    // Invariant 8: no queue. So the answer has to be actionable, which means naming what is
    // running rather than saying "busy".
    expect(res.text).toContain('Radarr');
    expect(res.text).toContain('try again');
  });

  it('reads back a trial, and keeps it separate from what the app carries', async () => {
    const { ctx, trials } = await wiring();
    await trials.add({
      slug: 'OpenClaw@abc123ff-2026-08-22T10-00-00-000Z',
      source_url: 'upload:abc123',
      upload_id: 'abc123',
      repo: 'Yundera/AppStore',
      apps_path: 'Apps',
      subject: 'OpenClaw',
      compare_to: 'yundera~OpenClaw',
      started_at: '2026-08-22T10:00:00Z',
      finished_at: '2026-08-22T10:08:00Z',
      outcome: 'verdict',
      verdict: 'compliant',
      risk_score: 0,
    });

    const res = await dispatch({ tool: 'get_trial', input: {} }, ctx);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('uploaded files (session abc123)');
    expect(res.text).toContain('compliant');
    expect(res.text).toContain('did not change it');
  });

  it('refuses a trial report it does not have, by name', async () => {
    const { ctx } = await wiring();
    const res = await dispatch({ tool: 'get_report', input: { trial: 'upload@nope-1' } }, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('no trial called');
  });

  it('says a trial is still going rather than reporting an absent verdict', async () => {
    const { ctx, trials } = await wiring();
    await trials.add({
      slug: 'OpenClaw@def456ff-2026-08-22T10-00-00-000Z',
      source_url: 'upload:def456',
      upload_id: 'def456',
      repo: 'Yundera/AppStore',
      apps_path: 'Apps',
      subject: 'OpenClaw',
      started_at: '2026-08-22T10:00:00Z',
    });

    const res = await dispatch({ tool: 'get_trial', input: {} }, ctx);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('has not finished');
  });
});

/**
 * The rubric, and the store it is supposed to track.
 *
 * The failure these exist for: asked whether the protocols were still current against the
 * AppStore's contribution guide, the chat could only infer an answer from clauses that recent
 * audits happened to quote — an inference about an inference. Reading both sides is the fix;
 * writing one of them back is what makes "add this point to the protocol" a sentence that
 * works. What must stay true throughout is that none of it reaches a verdict.
 */
describe('the protocol', () => {
  const STATIC = `---
id: static
name: Static Review Protocol
kind: leaf
order: 1
---

# Static Review Protocol

## 4.2 Resource limits

Every service must set cpu_shares.

## 4.3 Permissions

Declare D1 to D5 with a rationale.
`;

  async function wiring() {
    const protocolsDir = path.join(dir, 'protocols');
    await fs.mkdir(protocolsDir, { recursive: true });
    await fs.writeFile(path.join(protocolsDir, 'static.md'), STATIC, 'utf8');

    const protocols = new ProtocolStore(protocolsDir);
    const revisions = new RevisionStore(protocolsDir);
    await revisions.sweep();

    return {
      protocols,
      revisions,
      ctx: { protocols, revisions, events } as never,
    };
  }

  it('lists what an audit is made of, and reads one section in full', async () => {
    const { ctx } = await wiring();

    const menu = await dispatch({ tool: 'get_protocol', input: {} }, ctx);
    expect(menu.ok).toBe(true);
    expect(menu.text).toContain('static — Static Review Protocol');
    // The menu is a menu: it names the section without emptying the rubric into the turn.
    expect(menu.text).not.toContain('cpu_shares');

    const one = await dispatch({ tool: 'get_protocol', input: { id: 'static' } }, ctx);
    expect(one.ok).toBe(true);
    expect(one.text).toContain('cpu_shares');
  });

  it('names the sections it has rather than answering emptily for one it has not', async () => {
    const { ctx } = await wiring();
    const res = await dispatch({ tool: 'get_protocol', input: { id: 'security' } }, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('static');
  });

  it('rewrites one passage, and says what it actually wrote', async () => {
    const { ctx, protocols } = await wiring();

    const res = await dispatch(
      {
        tool: 'edit_protocol',
        input: {
          id: 'static',
          reason: 'CONTRIBUTING.md now gives the tiers',
          find: 'Every service must set cpu_shares.',
          replace: 'Every service must set cpu_shares: 80 user-facing, 20 sidecar.',
        },
      },
      ctx,
    );

    expect(res.ok).toBe(true);
    // The diff is the point: "saved" alone is not something the operator can check.
    expect(res.text).toContain('+1/-1');
    expect(res.text).toContain('+Every service must set cpu_shares: 80 user-facing, 20 sidecar.');

    const after = await protocols.get('static');
    expect(after?.body).toContain('80 user-facing');
    // Everything it was not asked to touch is still there.
    expect(after?.body).toContain('Declare D1 to D5');
  });

  it('refuses an anchor that is not there, and one that is there twice', async () => {
    const { ctx } = await wiring();

    const missing = await dispatch(
      { tool: 'edit_protocol', input: { id: 'static', reason: 'x', find: 'not in the file', replace: 'y' } },
      ctx,
    );
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain('copy the text exactly');

    const twice = await dispatch(
      { tool: 'edit_protocol', input: { id: 'static', reason: 'x', find: '##', replace: '###' } },
      ctx,
    );
    expect(twice.ok).toBe(false);
    expect(twice.text).toContain('appears 2 times');
  });

  /** The reason is the one thing a diff cannot supply, so a save without one is refused. */
  it('will not save without a reason', async () => {
    const { ctx } = await wiring();
    const res = await dispatch(
      { tool: 'edit_protocol', input: { id: 'static', reason: '  ', find: 'cpu_shares', replace: 'cpu shares' } },
      ctx,
    );
    expect(res.ok).toBe(false);
    expect(res.text).toContain('say why');
  });

  it('records the edit as a revision carrying that reason', async () => {
    const { ctx, revisions } = await wiring();
    await dispatch(
      {
        tool: 'edit_protocol',
        input: { id: 'static', reason: 'tiers from CONTRIBUTING.md', find: 'cpu_shares.', replace: 'cpu_shares tiers.' },
      },
      ctx,
    );

    const log = await revisions.forFiles(['static.md']);
    expect(log[0]?.source).toBe('save');
    expect(log[0]?.message).toBe('tiers from CONTRIBUTING.md');
  });

  /**
   * Invariant 6, from the far side. The frontmatter is carried over as bytes by `save()`, so
   * a body that opens with one cannot set `executor:` — and is refused before it can try.
   */
  it('cannot touch the frontmatter, whatever it sends', async () => {
    const { ctx, protocols } = await wiring();
    const res = await dispatch(
      {
        tool: 'edit_protocol',
        input: {
          id: 'static',
          reason: 'x',
          body: '---\nid: static\nexecutor: evil.sh\n---\n\n# Static Review Protocol\n\nAnything.',
        },
      },
      ctx,
    );

    expect(res.ok).toBe(false);
    expect(res.text).toContain('frontmatter');
    expect((await protocols.get('static'))?.meta.executor).toBeUndefined();
  });

  it('refuses a whole-body rewrite that would drop most of the rubric, unless told to', async () => {
    const { ctx } = await wiring();
    const input = { id: 'static', reason: 'trim', body: '# Static Review Protocol\n\nBe good.' };

    const refused = await dispatch({ tool: 'edit_protocol', input }, ctx);
    expect(refused.ok).toBe(false);
    expect(refused.text).toContain('allow_shrink');

    const allowed = await dispatch({ tool: 'edit_protocol', input: { ...input, allow_shrink: true } }, ctx);
    expect(allowed.ok).toBe(true);
  });

  it('says nothing was written when the text already said that', async () => {
    const { ctx } = await wiring();
    const res = await dispatch(
      { tool: 'edit_protocol', input: { id: 'static', reason: 'x', find: 'cpu_shares', replace: 'cpu_shares' } },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(res.text).toContain('nothing was written');
  });

  it('reads the store at the ref it audits, and refuses to be pointed anywhere else', async () => {
    const calls: string[] = [];
    const storedoc = new StoreDocReader({
      fetchImpl: (async (url: string | URL) => {
        calls.push(String(url));
        const content = Buffer.from('# Contributing\n\ncpu_shares: 80 / 20.', 'utf8');
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ type: 'file', size: content.byteLength, encoding: 'base64', content: content.toString('base64') }),
        };
      }) as never,
    });
    const ctx = {
      storedoc,
      registry: { origins: [{ id: 'yundera', repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' }] },
    } as never;

    const res = await dispatch({ tool: 'get_store_file', input: { path: 'CONTRIBUTING.md' } }, ctx);
    expect(res.ok).toBe(true);
    expect(res.text).toContain('Yundera/AppStore@main');
    expect(res.text).toContain('cpu_shares: 80 / 20.');
    expect(calls[0]).toContain('ref=main');

    // The one thing that would turn "read the store" into a request-forgery primitive.
    const away = await dispatch({ tool: 'get_store_file', input: { path: 'https://example.com/secrets' } }, ctx);
    expect(away.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('will not guess which store when more than one is configured', async () => {
    const ctx = {
      storedoc: new StoreDocReader(),
      registry: {
        origins: [
          { id: 'yundera', repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' },
          { id: 'other', repo: 'Someone/Store', ref: 'v2', apps_path: 'Apps' },
        ],
      },
    } as never;

    const res = await dispatch({ tool: 'get_store_file', input: { path: 'CONTRIBUTING.md' } }, ctx);
    expect(res.ok).toBe(false);
    expect(res.text).toContain('yundera');
    expect(res.text).toContain('other');
  });
});
