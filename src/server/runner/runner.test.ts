import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from '../services/events.js';
import type { BenchProber } from '../services/bench.js';
import { classify, extractText } from './agent.js';
import { DEFAULT_ORIGIN, subjectKey } from '../../shared/subject.js';
import { Runner, type RunnerOptions } from './index.js';

/** The app under test, as the runner now addresses it: `<origin>~<name>`. */
const SUBJECT = subjectKey(DEFAULT_ORIGIN, 'Tuwunel');

/**
 * The protocol, as two sections — which is now the *only* thing that says what a run is made
 * of. `requires` is what used to be `depth: full`: the runner probes those capabilities and
 * records the sections it cannot satisfy as blocked, without knowing what "functional" means.
 */
function protocolsOf(
  sections: { id: string; order: number; requires: string[]; phases?: string[] }[] = [
    { id: 'static', order: 1, requires: [] },
    { id: 'functional', order: 2, requires: ['bench', 'browser'], phases: ['A', 'C', 'D', 'E8', 'E9', 'E10', 'F', 'G'] },
  ],
) {
  return {
    directory: '/protocols',
    list: async () =>
      sections.map((s) => ({
        meta: {
          id: s.id,
          name: `${s.id[0]!.toUpperCase()}${s.id.slice(1)} Review Protocol`,
          version: 1,
          kind: 'leaf' as const,
          order: s.order,
          requires: s.requires,
          phases: (s.phases ?? []).map((id) => ({ id })),
          report_headings:
            s.id === 'static' ? ['^tech\\s*&\\s*documentation'] : ['^functionality'],
          requirements: [{ id: `${s.id}-item`, text: `something ${s.id}` }],
        },
        body: `the ${s.id} rubric`,
        file: `${s.id}.md`,
        bytes: 10,
        modified_at: '2026-08-20T00:00:00Z',
      })),
  } as never;
}

function portsOf(browsers: string[]) {
  return {
    healthy: (kind: string) =>
      kind === 'browser' ? browsers.map((url) => ({ name: 'browser-1', url })) : [],
  } as never;
}

/** A report shaped like the ones the archive already holds — both legs, phase table and all. */
function report(opts: { phases?: string } = {}): string {
  return [
    '## Verdict',
    '**NON-COMPLIANT · Critical · risk score 113**',
    '',
    '## Tech & Documentation',
    'The compose file pins `:latest` on the main image.',
    '',
    '## Functionality',
    opts.phases ??
      [
        '| Phase | Result | Notes |',
        '| --- | --- | --- |',
        '| A — session | pass | logged in |',
        '| C — install | pass | 41s |',
        '| E8 — works immediately | fail | 503 from the homeserver |',
      ].join('\n'),
    '',
    '## Notes',
    'Cleanup done.',
  ].join('\n');
}

function agentJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app_name: 'Tuwunel',
    title: 'Yundera/AppStore — Tuwunel',
    verdict: 'non-compliant',
    severity: 'Critical',
    risk_score: 113,
    summary: 'NON-COMPLIANT · Critical · risk 113',
    report_markdown: report(),
    ...over,
  });
}

/** An SSE frame carrying one JSON-RPC result, the way Beacon returns it. */
function sse(text: string): string {
  return `event: message\ndata: ${JSON.stringify({ result: { content: [{ type: 'text', text }] } })}\n\n`;
}

let dir: string;
let events: EventLog;

/** The reports root for this run's temp data dir. */
function reportsRoot(): string {
  return path.join(dir, 'reports');
}

/** Where this subject's reports land — `reports/<origin>/<Subject>/`. */
function subjectDir(): string {
  return path.join(reportsRoot(), DEFAULT_ORIGIN, 'Tuwunel');
}

/** Every report anywhere under the reports root, so "nothing was written" can be proved. */
async function reportFiles(root = path.join(dir, 'reports')): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.name.endsWith('.md')) out.push(abs);
    }
  };
  await walk(root);
  return out;
}

function make(over: Partial<RunnerOptions> = {}, answers: string[] = [sse(agentJson())]): Runner {
  let call = 0;
  return new Runner({
    enabled: true,
    reportsRoot: path.join(dir, 'reports'),
    protocols: protocolsOf(),
    // Both capabilities available by default. An *absent* prober is not "we could not check"
    // — it is a capability nothing can satisfy, and the sections needing it are blocked.
    prober: proberOf(['https://demostaging1.example']),
    ports: portsOf(['http://touchstone-browser:9746/mcp']),
    events,
    busyBackoffMs: 1,
    sleep: async () => {},
    agent: {
      fetchImpl: (async () => {
        const body = answers[Math.min(call++, answers.length - 1)]!;
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch,
    },
    ...over,
  });
}

function proberOf(urls: string[]): BenchProber {
  return { leasable: () => urls.map((url) => ({ name: 'demo', url })) } as unknown as BenchProber;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-runner-'));
  events = new EventLog(dir);
});

afterEach(async () => {
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('reading the agent', () => {
  it('takes the last complete frame out of an SSE stream', () => {
    const stream = sse('partial') + sse('final');
    expect(extractText(stream)).toBe('final');
  });

  it('reads a plain JSON-RPC body too', () => {
    expect(extractText(JSON.stringify({ result: { content: [{ text: 'hello' }] } }))).toBe('hello');
  });

  /**
   * The live failure. `report_markdown` almost always contains a fenced block, and unwrapping
   * "the first fence" then slices from inside the JSON string — n8n does exactly that, and the
   * first real run against the agent lost a complete Spliit report to it.
   */
  it('does not mistake a fence inside the report for a wrapper', () => {
    const payload = JSON.stringify({
      app_name: 'Spliit',
      verdict: 'non-compliant',
      severity: 'Critical',
      risk_score: 120,
      report_markdown: '## Verdict\n\n```yaml\nservices:\n  app:\n    privileged: true\n```\n',
    });
    const out = classify(payload);
    expect(out.ok).toBe(true);
    expect(out.ok && out.report.risk_score).toBe(120);
    expect(out.ok && out.report.report_markdown).toContain('privileged: true');
  });

  it('finds the object inside a fenced block', () => {
    const out = classify('Here you go:\n```json\n{"verdict":"compliant","risk_score":0}\n```\n');
    expect(out.ok && out.report.verdict).toBe('compliant');
  });
});

/**
 * The four classes, reproduced from n8n branch for branch. Each one decides whether a
 * subject's try is burned, which is why they are asserted rather than trusted.
 */
describe('classifying a failure', () => {
  it('calls a dead session agent-auth', () => {
    const out = classify('Error: failed to authenticate. Please run /login.');
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toBe('agent-auth');
  });

  it('calls a 409 agent-busy', () => {
    expect(classify('Error calling remote tool: 409 conflict').ok).toBe(false);
    const out = classify('Error calling remote tool: 409 conflict');
    expect(!out.ok && out.error).toBe('agent-busy');
  });

  it('calls "in progress" agent-busy as well', () => {
    const out = classify('Error calling remote tool: a query is already in progress');
    expect(!out.ok && out.error).toBe('agent-busy');
  });

  /**
   * Order matters. An auth failure whose text happens to contain "conflict" is still an auth
   * failure — n8n tests auth first, and a busy misclassification would silently stop charging
   * a try for a condition that never resolves on its own.
   */
  it('does not let a conflicting word turn an auth failure into a busy one', () => {
    const out = classify('failed to authenticate: session conflict');
    expect(!out.ok && out.error).toBe('agent-auth');
  });

  it('calls an empty answer agent-error', () => {
    const out = classify('');
    expect(!out.ok && out.error).toBe('agent-error');
  });

  it('calls an answer with no object parse-failed', () => {
    const out = classify('I had a look and everything seems fine.');
    expect(!out.ok && out.error).toBe('parse-failed');
  });

  it('keeps the raw text, capped, so the log can show what came back', () => {
    const out = classify('x'.repeat(5000) + ' httpstatuserror');
    expect(!out.ok && out.rawText.length).toBe(2000);
  });
});

describe('a run that produces a verdict', () => {
  it('writes one file per section and takes the verdict from the declaration', async () => {
    const out = await make().run({ subject: SUBJECT, try_n: 1 });
    expect(out.kind).toBe('verdict');
    expect(out.kind === 'verdict' && out.files).toHaveLength(2);

    const files = await fs.readdir(subjectDir());
    expect(files).toHaveLength(2);
    const staticFile = files.find((f) => f.endsWith('-static.md'))!;
    const body = await fs.readFile(path.join(subjectDir(), staticFile), 'utf8');
    expect(body).toContain('verdict: non-compliant');
    expect(body).toContain('top_severity: critical');
    expect(body).toContain('risk_score: 113');
  });

  /** Principle 3: the prose is not consulted, so a headline that disagrees changes nothing. */
  it('ignores the report prose when it contradicts the declaration', async () => {
    const contradicting = agentJson({
      report_markdown: report().replace('risk score 113', 'risk score 1'),
    });
    const out = await make({}, [sse(contradicting)]).run({ subject: SUBJECT, try_n: 1 });
    expect(out.kind === 'verdict' && out.risk).toBe(113);
  });

  it('records the bench it ran against', async () => {
    await make({ prober: proberOf(['https://demostaging1.example']) }).run({
      subject: SUBJECT,
      try_n: 1,
    });
    const files = await fs.readdir(subjectDir());
    const body = await fs.readFile(path.join(subjectDir(), files[0]!), 'utf8');
    expect(body).toContain('bench_host:');
  });

  /**
   * Nothing tells the runner which sections to audit — there is no depth any more. It reads
   * the protocol directory, and a third rubric would produce a third file with no code change.
   */
  it('audits every section the protocol declares', async () => {
    const three = make({
      protocols: protocolsOf([
        { id: 'static', order: 1, requires: [] },
        { id: 'licensing', order: 2, requires: [] },
        { id: 'functional', order: 3, requires: ['bench', 'browser'], phases: ['A'] },
      ]),
    });
    const out = await three.run({ subject: SUBJECT, try_n: 1 });
    expect(out.kind === 'verdict' && out.files).toHaveLength(3);
    const files = await fs.readdir(subjectDir());
    expect(files.filter((f) => f.endsWith('-licensing.md'))).toHaveLength(1);
  });

  /** Principle 6: the rubric that judged an assay is the protocol, and it versions itself. */
  it('stamps a section from its own protocol', async () => {
    await make().run({ subject: SUBJECT, try_n: 1 });
    const files = await fs.readdir(subjectDir());
    const body = await fs.readFile(
      path.join(subjectDir(), files.find((f) => f.endsWith('-static.md'))!),
      'utf8',
    );
    expect(body).toContain('standard: Static Review Protocol');
    expect(body).toContain('standard_version: 1');
  });

  /** There is no rubric on disk, so there is nothing to judge against and nothing to write. */
  it('refuses to run with no protocol at all', async () => {
    const out = await make({ protocols: protocolsOf([]) }).run({ subject: SUBJECT, try_n: 1 });
    expect(out).toEqual({ kind: 'blocked', reason: 'no_protocol' });
  });
});

/**
 * The distinction the whole project exists to make. A functional half that never ran is a
 * statement about the bench, and writing it as a verdict is what filed 49 infrastructure
 * failures against the apps.
 */
describe('a functional half that could not run', () => {
  const noPhases = agentJson({
    report_markdown: report({ phases: 'The demo pool returned 401 on both hosts, so no phase ran.' }),
  });

  it('writes the functional leg blocked, not errored', async () => {
    await make({}, [sse(noPhases)]).run({ subject: SUBJECT, try_n: 1 });
    const files = await fs.readdir(subjectDir());
    const fn = files.find((f) => f.endsWith('-functional.md'))!;
    const body = await fs.readFile(path.join(subjectDir(), fn), 'utf8');
    expect(body).toContain('status: blocked');
    expect(body).toContain('blocked_reason: bench_unavailable');
    expect(body).toContain('verdict: null');
  });

  it('still reports the run as a verdict, because the static half did produce one', async () => {
    const out = await make({}, [sse(noPhases)]).run({ subject: SUBJECT, try_n: 1 });
    expect(out.kind).toBe('verdict');
  });
});

/** Row D5, and the rule that a busy agent is never the subject's fault. */
describe('the agent being busy', () => {
  const busy = sse('Error calling remote tool: 409 conflict');

  it('waits and tries once more', async () => {
    const out = await make({}, [busy, sse(agentJson())]).run({
      subject: SUBJECT,
      try_n: 1,
    });
    expect(out.kind).toBe('verdict');
  });

  it('gives the subject back untouched when the retry is busy too', async () => {
    const out = await make({}, [busy, busy]).run({ subject: SUBJECT, try_n: 1 });
    expect(out).toEqual({ kind: 'agent_busy' });
  });

  it('writes no report when it gives up', async () => {
    await make({}, [busy, busy]).run({ subject: SUBJECT, try_n: 1 });
    // Deliberately not `expect(readdir(<subject dir>)).rejects.toThrow()`. That directory does
    // not exist when nothing was written *and* did not exist when the layout gained a store
    // level, so the assertion passed either way — including if the runner had written files
    // somewhere else entirely. Listing the whole reports root proves the real claim.
    expect(await reportFiles()).toEqual([]);
  });

  it('retries only once, never in a loop', async () => {
    let calls = 0;
    const runner = make({
      agent: {
        fetchImpl: (async () => {
          calls++;
          return new Response(busy, { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    await runner.run({ subject: SUBJECT, try_n: 1 });
    expect(calls).toBe(2);
  });
});

describe('refusing to run', () => {
  it('does nothing at all while disabled', async () => {
    const out = await make({ enabled: false }).run({ subject: SUBJECT, try_n: 1 });
    expect(out).toEqual({ kind: 'blocked', reason: 'runner_disabled' });
  });

  /**
   * Principle 4, and the thing this used to get wrong.
   *
   * A dead demo pool once aborted the whole job before the agent was called, so it cost the
   * *static* verdict too — an infra outage attributed to the subject, which is §2.2 all over
   * again one layer down. The job degrades instead: static runs, functional is recorded.
   */
  it('runs the rest of the audit when no bench is leasable', async () => {
    const out = await make({ prober: proberOf([]) }).run({ subject: SUBJECT, try_n: 1 });
    expect(out.kind).toBe('verdict');
  });

  it('still writes both sections, the one that needed a bench blocked', async () => {
    await make({ prober: proberOf([]) }).run({ subject: SUBJECT, try_n: 1 });
    const files = await fs.readdir(subjectDir());
    expect(files.filter((f) => f.endsWith('-static.md'))).toHaveLength(1);
    expect(files.filter((f) => f.endsWith('-functional.md'))).toHaveLength(1);

    const functional = await fs.readFile(
      path.join(subjectDir(), files.find((f) => f.endsWith('-functional.md'))!),
      'utf8',
    );
    // No verdict, and a reason about the bench rather than about the app.
    expect(functional).toMatch(/status: blocked/);
    expect(functional).toMatch(/blocked_reason: bench_unavailable/);
    expect(functional).toMatch(/verdict: null/);
  });

  it('says out loud which section it could not attempt', async () => {
    await make({ prober: proberOf([]) }).run({ subject: SUBJECT, try_n: 1 });
    await events.flush();
    expect(events.query({ code: 'ASSAY_DEGRADED' })).toHaveLength(1);
  });

  /** The agent must not be sent to install onto a pool we already know is unusable. */
  it('asks the agent for the runnable sections only', async () => {
    let prompt = '';
    const runner = make({
      prober: proberOf([]),
      agent: {
        fetchImpl: (async (_url: string, init: { body: string }) => {
          prompt = String(JSON.parse(init.body).params.arguments.prompt ?? '');
          return new Response(sse(agentJson()), { status: 200 });
        }) as unknown as typeof fetch,
      },
    });
    await runner.run({ subject: SUBJECT, try_n: 1 });
    expect(prompt).toContain('sections=static');
    // And it is told what is NOT being audited, so it does not judge it or invent it.
    expect(prompt).toContain('NOT part of this run');
    expect(prompt).not.toContain('the functional rubric');
  });

  /** A section that requires nothing runs whatever the state of the pool. */
  it('still produces a verdict for the sections that need no bench', async () => {
    await make({ prober: proberOf([]) }).run({ subject: SUBJECT, try_n: 1 });
    const files = await fs.readdir(subjectDir());
    const body = await fs.readFile(
      path.join(subjectDir(), files.find((f) => f.endsWith('-static.md'))!),
      'utf8',
    );
    expect(body).toContain('status: done');
    expect(body).toContain('verdict: non-compliant');
  });
});

describe('a failure that is not busy', () => {
  it('reports the class so the scheduler can charge the try', async () => {
    const out = await make({}, [sse('Error calling remote tool: httpstatuserror 500')]).run({
      subject: SUBJECT,
      try_n: 1,
    });
    expect(out).toEqual({ kind: 'error', reason: 'agent-error' });
  });

  it('calls out a logged-out agent separately, because no app is at fault', async () => {
    await make({}, [sse('failed to authenticate, please run /login')]).run({
      subject: SUBJECT,
      try_n: 1,
    });
    await events.flush();
    expect(events.query({ code: 'AGENT_UNAUTHENTICATED' })).toHaveLength(1);
  });
});

/**
 * Row D6. A lease is `(bench, browser)` together: the runner is single-flight, so taking the
 * first healthy sidecar *is* the lease and no two assays can share a browser by
 * construction — which is what makes the page-stealing race in ARCHITECTURE §2.4 impossible
 * rather than unlikely.
 */
describe('the browser sidecar', () => {
  it('skips the sections that need it when no sidecar is answering', async () => {
    const out = await make({
      prober: proberOf(['https://demostaging1.example']),
      ports: portsOf([]),
    }).run({ subject: SUBJECT, try_n: 1 });
    expect(out.kind).toBe('verdict');
  });

  /** A missing sidecar is infrastructure, so it is recorded against the browser, not the app. */
  it('names the browser as the reason the functional leg is blocked', async () => {
    await make({ prober: proberOf(['https://x.example']), ports: portsOf([]) }).run({
      subject: SUBJECT,
      try_n: 1,
    });
    const files = await fs.readdir(subjectDir());
    const functional = await fs.readFile(
      path.join(subjectDir(), files.find((f) => f.endsWith('-functional.md'))!),
      'utf8',
    );
    expect(functional).toMatch(/blocked_reason: browser_unavailable/);
  });

  it('records which browser the run drove', async () => {
    await make({
      prober: proberOf(['https://demostaging1.example']),
      ports: portsOf(['http://touchstone-browser:9746/mcp']),
    }).run({ subject: SUBJECT, try_n: 1 });

    const files = await fs.readdir(subjectDir());
    const body = await fs.readFile(path.join(subjectDir(), files[0]!), 'utf8');
    expect(body).toContain('browser: ');
  });

  /** A section that does not declare `browser` drives none, so a dead sidecar cannot stop it. */
  it('is not needed by a section that does not ask for it', async () => {
    const out = await make({ ports: portsOf([]) }).run({ subject: SUBJECT, try_n: 1 });
    expect(out.kind).toBe('verdict');
  });
});

/**
 * The three ways the extractor threw away a complete audit, each found against a real answer
 * from the live agent rather than a fixture someone imagined. All three are one bug: the
 * parser tried to find the object's *boundaries* by looking for fences, and `report_markdown`
 * is markdown — it contains fences.
 */
describe('extracting the object from a real agent answer', () => {
  it('survives prose, a leading fence, and yaml fences inside the report', async () => {
    const fs = await import('node:fs/promises');
    const raw = await fs.readFile('test/fixtures/agent/prose-then-fenced-json.txt', 'utf8');
    const out = classify(raw);
    expect(out.ok, out.ok ? '' : `still ${out.error}`).toBe(true);
    expect(out.ok && out.report.app_name).toBe('Dufs');
    expect(out.ok && out.report.verdict).toBe('non-compliant');
    // The body must survive whole — a truncated report is what the old slice produced.
    expect(out.ok && out.report.report_markdown).toContain('```yaml');
  });

  it('steps over a brace in the prose before the object', () => {
    const out = classify('I checked {app} and here it is:\n{"verdict":"compliant","report_markdown":"# ok"}');
    expect(out.ok && out.report.verdict).toBe('compliant');
  });

  it('still refuses an answer with no object in it', () => {
    expect(classify('Everything looked fine to me.').ok).toBe(false);
  });
});

/**
 * The store a run is against.
 *
 * Until 2026-08-20 `buildPrompt`'s `repo` was a parameter no caller set and `subject_ref` was a
 * defaulted constant, so a second origin would have listed its own apps and then audited them
 * against `Yundera/AppStore@main` — filing a wrong verdict under the right name, with nothing
 * said about it.
 */
describe('the store a subject came from', () => {
  const ACME = { id: 'acme', repo: 'Acme/AppStore', ref: 'pr-812', apps_path: 'apps' };

  it('reaches the prompt', async () => {
    let sent = '';
    await make({
      origins: [ACME],
      agent: {
        fetchImpl: (async (_u: string, init: RequestInit) => {
          sent = String(init.body);
          return { ok: true, status: 200, text: async () => sse(agentJson()) };
        }) as unknown as typeof fetch,
      },
    }).run({ subject: subjectKey('acme', 'Tuwunel'), try_n: 1 });

    expect(sent).toContain('repo=Acme/AppStore ; ref=pr-812 ; apps_path=apps');
    expect(sent).toContain('apps/Tuwunel at ref pr-812');
  });

  it('is written into every report it produces, not defaulted', async () => {
    await make({ origins: [ACME] }).run({ subject: subjectKey('acme', 'Tuwunel'), try_n: 1 });

    const dir = path.join(reportsRoot(), 'acme', 'Tuwunel');
    const files = await fs.readdir(dir);
    expect(files).toHaveLength(2);
    for (const f of files) {
      const body = await fs.readFile(path.join(dir, f), 'utf8');
      expect(body).toContain("subject_ref: 'Acme/AppStore@pr-812:apps/Tuwunel'");
      expect(body).toContain('origin: acme');
      // The heading names the store too, matching the `title` the agent is asked to return.
      expect(body).toContain('# Acme/AppStore — Tuwunel');
    }
  });

  it('falls back to the Yundera store for an origin no longer configured', async () => {
    // A store removed from config.yaml still has reports and can still be asked for by hand.
    // Refusing to audit it would be a worse answer than auditing it where it came from.
    await make({ origins: [] }).run({ subject: SUBJECT, try_n: 1 });

    const files = await fs.readdir(subjectDir());
    const body = await fs.readFile(path.join(subjectDir(), files[0]!), 'utf8');
    expect(body).toContain("subject_ref: 'Yundera/AppStore@main:Apps/Tuwunel'");
  });
});

/**
 * A store that cannot be read.
 *
 * Invariant 3: no infra condition may consume a subject's retry budget or produce a verdict
 * about the subject. A store outage is the newest member of that family, and the one most
 * likely to be mistaken for an app fault — the run *would* fail, loudly, against a dead source.
 */
describe('a store that cannot be read', () => {
  it('blocks rather than errors, so no try is burned', async () => {
    const out = await make({
      storeReachable: () => false,
      storeFailure: () => 'HTTP 503',
    }).run({ subject: SUBJECT, try_n: 1 });

    expect(out.kind).toBe('blocked');
    expect(out.kind === 'blocked' && out.reason).toContain('store_unreachable');
    // `blocked` is what `scheduler/record.ts` reads to restore the subject untouched. An
    // `error` here would burn a try, and three ticks of a GitHub outage would park the app.
    expect(out.kind).not.toBe('error');
  });

  it('never reaches the agent, and writes nothing about the subject', async () => {
    let called = 0;
    const out = await make({
      storeReachable: () => false,
      agent: {
        fetchImpl: (async () => {
          called += 1;
          return { ok: true, status: 200, text: async () => sse(agentJson()) };
        }) as unknown as typeof fetch,
      },
    }).run({ subject: SUBJECT, try_n: 1 });

    expect(out.kind).toBe('blocked');
    expect(called).toBe(0);
    // Nothing on disk either: a blocked-before-start run has established nothing, and a file
    // saying so would be a statement about the subject where there is none to make.
    expect(await reportFiles()).toEqual([]);
  });

  it('runs normally once the store is readable', async () => {
    const out = await make({ storeReachable: () => true }).run({ subject: SUBJECT, try_n: 1 });
    expect(out.kind).toBe('verdict');
  });
});

/**
 * Trials.
 *
 * The claim is that a trial is *the same run, written where the index does not look*. Every
 * test here is about the second half — what a trial must NOT be able to touch — because the
 * first half is already covered by every other test in this file.
 */
describe('a trial', () => {
  const SLUG = 'Tuwunel@a1b2c3d4-2026-08-20T19-00-00Z';
  const TRIAL = {
    repo: 'Acme/AppStore',
    apps_path: 'Apps',
    // Always present: a trial resolves to a store zip before it reaches the runner, and these
    // are the app's files read out of that zip.
    source: { files: ['docker-compose.yml'], compose: 'services: {}\n', rationale: null },
    store_url: 'https://ts.example/api/v1/trialstore/tok.zip',
  };

  function trialJob(root: string) {
    return {
      subject: subjectKey(SLUG, 'Tuwunel'),
      try_n: 1,
      trial: { ...TRIAL, root },
    };
  }

  /** The same job with no address to serve its store from — the one degraded case left. */
  function unservableJob(root: string) {
    const { store_url: _dropped, ...rest } = TRIAL;
    return { subject: subjectKey(SLUG, 'Tuwunel'), try_n: 1, trial: { ...rest, root } };
  }

  it('writes under its own root and leaves the archive untouched', async () => {
    const root = path.join(dir, 'trials', SLUG);
    const out = await make().run(trialJob(root));

    expect(out.kind).toBe('verdict');
    // Its own tree, mirroring the archive's shape with the slug standing in for the origin.
    const files = await fs.readdir(path.join(root, SLUG, 'Tuwunel'));
    expect(files).toHaveLength(2);
    // And nothing at all in the archive. This is the whole point: an unmerged branch has
    // earned nothing, so it may not move a hallmark.
    expect(await reportFiles()).toEqual([]);
  });

  it('never enters the report index', async () => {
    // The index is what the scheduler derives freshness from, and what
    // `registry.archived: () => store.subjects()` turns into schedulable subjects. A trial
    // reaching it would both age a subject it says nothing about and add a slug to the backlog.
    const upserted: unknown[] = [];
    await make({
      index: { upsert: (r: unknown) => upserted.push(r) } as never,
    }).run(trialJob(path.join(dir, 'trials', SLUG)));

    expect(upserted).toEqual([]);
  });

  it('blocks the functional section only when it has no address to serve its store from', async () => {
    const root = path.join(dir, 'trials', SLUG);
    await make({ prober: proberOf(['https://demostaging1.example']) }).run(unservableJob(root));

    const d = path.join(root, SLUG, 'Tuwunel');
    const fn = (await fs.readdir(d)).find((f) => f.endsWith('-functional.md'))!;
    const body = await fs.readFile(path.join(d, fn), 'utf8');

    expect(body).toContain('status: blocked');
    expect(body).toContain('blocked_reason: store_url_unconfigured');
    // Never a verdict. `blocked` is a statement about the environment, and a trial that scored
    // the app on an install of something else would be attributing a result to the wrong code.
    expect(body).toContain('verdict: null');
    // The justification lives in the artefact, because that is where somebody asks — and it
    // must name the setting, since that is the whole of the remedy.
    expect(body).toContain('trials.public_base_url');
  });

  /**
   * The rule that replaced `store_not_installable`, 2026-08-22.
   *
   * That block was never "trials cannot install" — it was "a bench installs the store's own
   * branch, not the thing under trial". Every trial now serves the exact archive it audited, so
   * the objection is gone and the section must run. If this ever starts blocking again with a
   * store URL present, the condition has been widened back into a blanket rule and full trials
   * are silently dead.
   */
  it('runs the functional section, which is now every trial that can be served', async () => {
    const root = path.join(dir, 'trials', SLUG);
    let sent = '';
    const out = await make({
      prober: proberOf(['https://demostaging1.example']),
      ports: portsOf(['http://touchstone-browser:9746/mcp']),
      agent: {
        fetchImpl: (async (_u: string, init: RequestInit) => {
          sent = String(init.body);
          return { ok: true, status: 200, text: async () => sse(agentJson()) };
        }) as unknown as typeof fetch,
      },
    }).run(trialJob(root));

    expect(out.kind).toBe('verdict');
    // The bench was leased rather than declined, and the agent was told where to install from.
    expect(sent).toContain('trialstore');
    expect(sent).not.toContain('store_url_unconfigured');
  });

  it('judges against the rubric anchor it was given, not the configured store', async () => {
    let sent = '';
    await make({
      origins: [{ id: 'yundera', repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' }],
      agent: {
        fetchImpl: (async (_u: string, init: RequestInit) => {
          sent = String(init.body);
          return { ok: true, status: 200, text: async () => sse(agentJson()) };
        }) as unknown as typeof fetch,
      },
    }).run(trialJob(path.join(dir, 'trials', SLUG)));

    // `main` unconditionally: a trial audits an archive, not a branch, and `prompt.ts` rebinds
    // the asset rule for any other value — right for a store pinned to a branch, wrong here.
    expect(sent).toContain('repo=Acme/AppStore ; ref=main');
    expect(sent).not.toContain('repo=Yundera/AppStore');
  });

  it('is not gated on the configured store being reachable', async () => {
    // A trial carries its own bytes. Refusing it because the *archive's* store is down would
    // be checking the wrong thing.
    const out = await make({ storeReachable: () => false }).run(
      trialJob(path.join(dir, 'trials', SLUG)),
    );
    expect(out.kind).toBe('verdict');
  });
});
