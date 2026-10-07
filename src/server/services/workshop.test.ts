/**
 * The workshop end to end, with every outbound edge faked: GitHub, the agent and the trials'
 * runs. One proposal goes the whole way — propose, author, validate, open a PR — and the
 * tests around it pin the rules that make that safe: infra charges nothing, a failed round
 * goes back with its feedback, the store moving under a proposal discards it, and the PR is
 * built from exactly the bytes that were validated.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AssayRecord } from '../../shared/types.js';
import { asSubjectKey } from '../../shared/subject.js';
import type { AgentRaw } from '../runner/agent.js';
import { ensureProtocolFiles, ProtocolStore, sectionsOf } from '../store/protocols.js';
import { writeReport } from '../store/reports.js';
import { TrialStore } from '../store/trials.js';
import { WorkshopStore } from '../store/workshop.js';
import { EventLog } from './events.js';
import { GitHubClient } from './github.js';
import { GitHubProbe } from './githubprobe.js';
import { Workshop, WorkshopRefusal, type WorkshopSettings } from './workshop.js';

const SHA = (c: string) => c.repeat(40);
const ORIGIN = { id: 'yundera', repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' };

let dir: string;
let events: EventLog;
let trials: TrialStore;
let store: WorkshopStore;
let ghCalls: { method: string; path: string; body?: unknown }[];
let appTree: string;
/** Set to make GitHub refuse blob creation, the way a token without Contents: write does. */
let blobRefused: boolean;
/** What GitHub says about PR #42 when it is polled. */
let pull42: Record<string, unknown>;
/** Where `main` points; a PATCH that GitHub accepts moves it. */
let mainHead: string;
/** `Apps/X`'s tree sha per ref, falling back to `appTree`. */
let appTreeAt: Record<string, string>;
/** Answers queued for the next PATCHes of main (a function runs first); empty means accept. */
let patchAnswers: ([number, unknown] | (() => [number, unknown]))[];
/** Commit shas handed out in order, so a push and its revert are told apart. */
let commitShas: string[];
let mainProtected: boolean;

const enc = new TextEncoder();

function archive(): Buffer {
  return Buffer.from(
    zipSync({
      'AppStore-x/Apps/X/docker-compose.yml': enc.encode('services:\n  x:\n    image: x:latest\n'),
      'AppStore-x/Apps/X/old.txt': enc.encode('gone'),
      'AppStore-x/Apps/Other/docker-compose.yml': enc.encode('services: {}\n'),
    }),
  );
}

/** GitHub, as far as the workshop talks to it. */
function fakeFetch(): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (u.startsWith('https://github.com/')) {
      const zip = archive();
      return { ok: true, status: 200, url: u, headers: new Headers({ 'content-length': String(zip.byteLength) }), arrayBuffer: async () => zip } as unknown as Response;
    }
    const p = u.replace('https://api.github.com', '');
    ghCalls.push({ method, path: p, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const json = (status: number, body: unknown) =>
      ({ ok: status < 400, status, text: async () => (body === undefined ? '' : JSON.stringify(body)) }) as Response;
    if (p === '/user') return json(200, { login: 'Mael', id: 7 });
    if (p === '/repos/Yundera/AppStore') return json(200, { permissions: { push: true } });
    if (p === '/repos/Yundera/AppStore/labels/touchstone') return json(200, { name: 'touchstone' });
    if (p === '/repos/Yundera/AppStore/git/ref/heads/main') return json(200, { object: { sha: mainHead } });
    if (p.startsWith('/repos/Yundera/AppStore/contents/Apps?ref=')) {
      const ref = decodeURIComponent(p.slice(p.indexOf('?ref=') + 5));
      return json(200, [{ name: 'X', type: 'dir', sha: appTreeAt[ref] ?? appTree }]);
    }
    if (p === '/repos/Yundera/AppStore/branches/main') return json(200, { name: 'main', protected: mainProtected });
    if (method === 'PATCH' && p === '/repos/Yundera/AppStore/git/refs/heads/main') {
      const next = patchAnswers.shift();
      const answer = typeof next === 'function' ? next() : next;
      if (answer) return json(answer[0], answer[1]);
      mainHead = (init!.body ? JSON.parse(String(init!.body)) : {}).sha;
      return json(200, { object: { sha: mainHead } });
    }
    if (p.startsWith('/repos/Yundera/AppStore/pulls?state=open')) return json(200, []);
    if (method === 'GET' && p.startsWith('/repos/Yundera/AppStore/git/commits/')) return json(200, { tree: { sha: SHA('1') } });
    if (method === 'POST' && p === '/repos/Yundera/AppStore/git/blobs') {
      return blobRefused ? json(403, { message: 'Resource not accessible by personal access token' }) : json(201, { sha: SHA('b') });
    }
    if (method === 'POST' && p === '/repos/Yundera/AppStore/git/trees') return json(201, { sha: SHA('c') });
    if (method === 'POST' && p === '/repos/Yundera/AppStore/git/commits') return json(201, { sha: commitShas.shift() ?? SHA('d') });
    if (method === 'POST' && p === '/repos/Yundera/AppStore/git/refs') return json(201, {});
    if (method === 'POST' && p === '/repos/Yundera/AppStore/pulls') return json(201, { number: 42, html_url: 'https://github.com/Yundera/AppStore/pull/42' });
    if (method === 'POST' && p === '/repos/Yundera/AppStore/issues/42/labels') return json(200, []);
    if (p === '/repos/Yundera/AppStore/pulls/42') return json(200, pull42);
    if (method === 'DELETE') return json(204, undefined);
    return json(404, { message: 'Not Found' });
  }) as typeof fetch;
}

/** The archive: X is non-compliant with one Critical. */
function archiveRecords(): AssayRecord[] {
  const meta = (section: string, verdict: string, extra: Record<string, unknown> = {}) => ({
    subject: 'X',
    origin: 'yundera',
    section,
    status: 'done',
    verdict,
    top_severity: verdict === 'compliant' ? 'none' : 'critical',
    risk_score: verdict === 'compliant' ? 0 : 100,
    started_at: '2026-10-01T10:00:00Z',
    finished_at: '2026-10-01T10:30:00Z',
    ...(shas[section] ? { standard_sha256: shas[section] } : {}),
    ...extra,
  });
  return [
    {
      meta: meta('static', 'non-compliant', { requirements: [{ id: 'pinned-image-tag', verdict: 'fail', severity: 'critical' }] }),
      path: 'yundera/X/a-static.md',
      subject: asSubjectKey('yundera~X'),
      section: 'static',
    },
    { meta: meta('functional', 'compliant', { requirements: [{ id: 'first-login', verdict: 'pass' }] }), path: 'yundera/X/a-functional.md', subject: asSubjectKey('yundera~X'), section: 'functional' },
    { meta: meta('functional@foss', 'compliant', { target: 'foss' }), path: 'yundera/X/a-ff.md', subject: asSubjectKey('yundera~X'), section: 'functional@foss' },
  ] as unknown as AssayRecord[];
}

/** The rubric hashes in force, so the archive's verdicts read as under the current standard. */
let shas: Record<string, string> = {};

let agentScript: (prompt: string, ws: Workshop) => Promise<AgentRaw>;
let workshop: Workshop;
let released: string[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-wsvc-'));
  ghCalls = [];
  appTree = SHA('e');
  blobRefused = false;
  pull42 = { state: 'closed', merged: false };
  mainHead = SHA('a');
  appTreeAt = {};
  patchAnswers = [];
  commitShas = [];
  mainProtected = false;
  released = [];
  events = new EventLog(path.join(dir, 'state'));
  await events.load();
  trials = new TrialStore(path.join(dir, 'state'), path.join(dir, 'trials'));
  await trials.load();
  store = new WorkshopStore(path.join(dir, 'state'), path.join(dir, 'workshop'), { maxFileBytes: 1 << 20, maxTotalBytes: 1 << 22 });
  await store.load();
  const protocolsDir = path.join(dir, 'protocols');
  await ensureProtocolFiles(protocolsDir);
  shas = Object.fromEntries(sectionsOf(await new ProtocolStore(protocolsDir).list()).map((x) => [x.id, x.sha256]));
  workshop = await build();
});

/** A workshop over the fakes; `settings` overrides the defaults (delivery, push_branch, …). */
async function build(settings: Partial<WorkshopSettings> = {}): Promise<Workshop> {
  const fetchImpl = fakeFetch();
  const directBranch = settings.delivery === 'push' ? 'main' : undefined;
  const github = new GitHubClient({ token: 'ghp_SECRET_TOKEN', repo: ORIGIN.repo, fetchImpl, ...(directBranch ? { directBranch } : {}) });
  const probe = new GitHubProbe({ client: github, expectedLogin: 'Mael' });
  await probe.probe();
  agentScript = async () => ({ ok: true, text: 'done', payload: '' });
  const ws: Workshop = new Workshop({
    store,
    settings: {
      origin: 'yundera',
      armed: false,
      auto_submit: false,
      prs_per_day: 1,
      max_rounds: 2,
      session_minutes: 10,
      currency_section: 'currency',
      login: 'Mael',
      commit_name: 'Mael (Touchstone)',
      commit_email: '',
      ...settings,
    },
    origins: [ORIGIN],
    github,
    probe,
    publicBaseUrl: 'https://touchstone.example',
    callbackUrl: 'http://touchstone/api/v1/mcp/workshop',
    agent: {},
    runner: { enabled: true, busyBackoffMin: 10 },
    index: { all: () => archiveRecords(), read: () => null },
    registry: { list: () => [asSubjectKey('yundera~X')], delisted: () => [], versions: () => ({ 'yundera~X': 'v1' }), versionOf: () => 'v1' },
    protocols: new ProtocolStore(path.join(dir, 'protocols')),
    trialDeps: () => ({ runner: { enabled: true } as never, trials, trialsRoot: path.join(dir, 'trials'), events, origins: [ORIGIN], publicBaseUrl: 'https://touchstone.example' }),
    trialsRoot: path.join(dir, 'trials'),
    leases: { release: (id?: string) => id && released.push(id) } as never,
    events,
    fetchImpl,
    postAgent: async (prompt) => agentScript(prompt, ws),
  });
  return ws;
}

afterEach(async () => {
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

const tokenOf = (prompt: string) => /session_token is (\S+?) -/.exec(prompt)![1]!;
const lease = { id: 'L1', target: 'yundera', bench: { name: 'b', url: 'https://bench.example', status: 'healthy' }, browser: { name: 'br', kind: 'browser', url: 'http://browser/mcp', status: 'healthy' }, holder: 'w', since: '' } as never;

/** Finish every queued trial of a proposal with these verdicts per section. */
async function finishTrials(verdicts: Record<string, string>, extra: Record<string, Record<string, unknown>> = {}) {
  for (const t of trials.queued()) {
    const sections = (t.target ?? 'yundera') === 'foss' ? ['functional@foss'] : ['static', 'functional'];
    for (const section of sections) {
      await writeReport(
        path.join(dir, 'trials', t.slug),
        {
          subject: t.subject,
          origin: t.slug,
          section,
          ...(section.includes('@') ? { target: 'foss' } : {}),
          status: 'done',
          verdict: verdicts[section] ?? 'compliant',
          top_severity: 'none',
          risk_score: 0,
          standard_sha256: 'f'.repeat(64),
          started_at: '2026-10-02T10:00:00Z',
          finished_at: '2026-10-02T10:20:00Z',
          ...(verdicts[section] === 'non-compliant' ? { requirements: [{ id: 'auth', verdict: 'fail', severity: 'critical' }] } : {}),
          ...(extra[section] ?? {}),
        } as never,
        '# report\n',
      );
    }
    await trials.update(t.slug, { began_at: '2026-10-02T10:00:00Z', finished_at: '2026-10-02T10:20:00Z', outcome: 'verdict' });
    await workshop.onTrialFinished(t.slug);
  }
}

describe('a proposal, the whole way', () => {
  it('authors, validates on both platforms, and opens one labelled PR from the validated bytes', async () => {
    agentScript = async (prompt, ws) => {
      const token = tokenOf(prompt);
      expect(prompt).not.toContain('ghp_SECRET_TOKEN'); // the GitHub token never reaches the agent
      expect(await ws.readFile(token, 'docker-compose.yml')).toContain('x:latest');
      await ws.writeFile(token, 'docker-compose.yml', 'services:\n  x:\n    image: x:1.2.3\n');
      await ws.deleteFile(token, 'old.txt');
      expect((await ws.stage(token)).store_url).toMatch(/^https:\/\/touchstone\.example\/api\/v1\/trialstore\//);
      ws.submit(token, 'Pinned the image.');
      return { ok: true, text: 'ok', payload: '' };
    };
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    expect((await workshop.slot())?.id).toBe(p.id);
    await workshop.dispatch(p.id, lease);
    expect(released).toEqual(['L1']);

    let now = store.get(p.id)!;
    expect(now.state).toBe('validating');
    expect(now.before_findings?.[0]?.id).toBe('pinned-image-tag');
    // One trial per platform the standard covers, derived from the protocol, not named.
    expect(trials.queued().map((t) => t.target ?? 'yundera').sort()).toEqual(['foss', 'yundera']);

    await finishTrials({});
    now = store.get(p.id)!;
    expect(now.state).toBe('ready');
    expect(now.validation?.map((r) => r.section).sort()).toEqual(['functional', 'functional@foss', 'static']);

    ghCalls = [];
    const submitted = await workshop.submitProposal(p.id, 'operator');
    expect(submitted.state).toBe('submitted');
    expect(submitted.pr?.number).toBe(42);
    const writes = ghCalls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace('/repos/Yundera/AppStore', '')}`);
    expect(writes).toEqual(['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls', 'POST /issues/42/labels']);
    const tree = ghCalls.find((c) => c.path.endsWith('/git/trees'))!.body as { tree: { path: string; sha: string | null }[] };
    expect(tree.tree).toEqual([
      { path: 'Apps/X/docker-compose.yml', mode: '100644', type: 'blob', sha: SHA('b') },
      { path: 'Apps/X/old.txt', mode: '100644', type: 'blob', sha: null },
    ]);
    const commit = ghCalls.find((c) => c.path.endsWith('/git/commits') && c.method === 'POST')!.body as { author: { name: string; email: string }; message: string };
    expect(commit.author).toEqual({ name: 'Mael (Touchstone)', email: '7+Mael@users.noreply.github.com' });
    expect(commit.message).toContain(`Touchstone-Proposal: ${p.id}`);
    const ref = (ghCalls.find((c) => c.path.endsWith('/git/refs'))!.body as { ref: string }).ref;
    expect(ref).toMatch(/^refs\/heads\/touchstone\/fix\/X-\d{8}-[a-f0-9]{6}$/);
    expect(store.memoryOf(p.task_key)?.outcome).toBe('pr_opened');

    // The quota: one a day.
    await expect(workshop.submitProposal(p.id, 'operator')).rejects.toThrow(WorkshopRefusal);

    // Still open: the poll records whether it would merge, and only writes when that moves.
    pull42 = { state: 'open', merged: false, mergeable: true, mergeable_state: 'clean' };
    await workshop.pollPrs();
    expect(store.get(p.id)!.state).toBe('submitted');
    expect(store.get(p.id)!.pr?.mergeable).toBe('clean');
    pull42 = { state: 'open', merged: false, mergeable: false, mergeable_state: 'dirty' };
    await workshop.pollPrs();
    expect(store.get(p.id)!.pr?.mergeable).toBe('conflicts');
    pull42 = { state: 'closed', merged: false };

    // Closed unmerged: the branch is deleted and the task parks.
    ghCalls = [];
    await workshop.pollPrs();
    expect(store.get(p.id)!.state).toBe('closed');
    expect(ghCalls.some((c) => c.method === 'DELETE' && c.path.endsWith(ref))).toBe(true);
    expect(store.memoryOf(p.task_key)?.outcome).toBe('pr_closed');
  });
});

describe('the rules around it', () => {
  it('a busy agent charges nothing and backs off', async () => {
    agentScript = async () => ({ ok: false, errorText: 'HTTPStatusError 409 conflict: in progress' });
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await workshop.dispatch(p.id, lease);
    const now = store.get(p.id)!;
    expect(now.state).toBe('queued');
    expect(now.backoff_until).toBeTruthy();
    expect(store.memory()).toEqual({});
    expect(await workshop.slot()).toBeUndefined();
  });

  it('no bench in the lease is infra, not the task\'s fault', async () => {
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await workshop.dispatch(p.id, { id: 'L2', target: 'yundera', holder: 'w', since: '' } as never);
    expect(store.get(p.id)!.state).toBe('queued');
    expect(store.memory()).toEqual({});
  });

  it('a session that never submits is a failed round, and the last round is remembered', async () => {
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await workshop.dispatch(p.id, lease);
    expect(store.get(p.id)).toMatchObject({ state: 'revising', round: 2 });
    expect(await store.feedback(p.id)).toContain('without calling submit');
    await workshop.dispatch(p.id, lease);
    expect(store.get(p.id)!.state).toBe('failed');
    expect(store.memoryOf(p.task_key)?.outcome).toBe('failed_validation');
  });

  it('a failing validation goes back with the findings as feedback', async () => {
    agentScript = async (prompt, ws) => {
      ws.submit(tokenOf(prompt), 'Tried.');
      return { ok: true, text: '', payload: '' };
    };
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await workshop.dispatch(p.id, lease);
    await finishTrials({ functional: 'non-compliant' });
    expect(store.get(p.id)).toMatchObject({ state: 'revising', round: 2 });
    expect(await store.feedback(p.id)).toBeTruthy();
    let saw = '';
    agentScript = async (prompt) => {
      saw = prompt;
      return { ok: true, text: '', payload: '' };
    };
    await workshop.dispatch(p.id, lease);
    expect(saw).toContain('PREVIOUS ROUND');
  });

  it('cannot is honest and parks the task until its input changes', async () => {
    agentScript = async (prompt, ws) => {
      ws.cannotDo(tokenOf(prompt), 'the upstream has no arm64 image');
      return { ok: true, text: '', payload: '' };
    };
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await workshop.dispatch(p.id, lease);
    expect(store.get(p.id)!.state).toBe('cannot');
    expect(store.memoryOf(p.task_key)).toMatchObject({ outcome: 'cannot', reason: 'the upstream has no arm64 image' });
    const row = (await workshop.candidates()).find((c) => c.task_key === p.task_key)!;
    expect(row.eligible).toBe(false);
  });

  it('discards a ready proposal the store moved under, charging nothing', async () => {
    agentScript = async (prompt, ws) => {
      await ws.writeFile(tokenOf(prompt), 'docker-compose.yml', 'services: {}\n');
      ws.submit(tokenOf(prompt), 'x');
      return { ok: true, text: '', payload: '' };
    };
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await workshop.dispatch(p.id, lease);
    await finishTrials({});
    appTree = SHA('9');
    await expect(workshop.submitProposal(p.id, 'operator')).rejects.toThrow(/changed/);
    expect(store.get(p.id)!.state).toBe('discarded');
    expect(store.memory()).toEqual({});
    expect(ghCalls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('a GitHub refusal before the pull request is a 502 with GitHub\'s words, logged, and leaves it ready', async () => {
    agentScript = async (prompt, ws) => {
      await ws.writeFile(tokenOf(prompt), 'docker-compose.yml', 'services: {}\n');
      ws.submit(tokenOf(prompt), 'x');
      return { ok: true, text: '', payload: '' };
    };
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await workshop.dispatch(p.id, lease);
    await finishTrials({});
    blobRefused = true;
    const refusal = await workshop.submitProposal(p.id, 'operator').catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(WorkshopRefusal);
    expect((refusal as WorkshopRefusal).code).toBe(502);
    expect((refusal as Error).message).toMatch(/Resource not accessible by personal access token/);
    expect(events.query({}).some((e) => e.code === 'PROPOSAL_SUBMIT_FAILED')).toBe(true);
    expect(store.get(p.id)!.state).toBe('ready');
    expect(ghCalls.some((c) => c.path.endsWith('/git/refs'))).toBe(false);
  });

  it('a session token dies with its session', async () => {
    let token = '';
    agentScript = async (prompt) => {
      token = tokenOf(prompt);
      return { ok: true, text: '', payload: '' };
    };
    const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await workshop.dispatch(p.id, lease);
    await expect(workshop.listFiles(token)).rejects.toThrow(/unknown or expired/);
  });

  it('refuses to propose for an app with nothing to fix, or twice', async () => {
    await expect(workshop.propose({ subject: 'Nope', kind: 'fix' }, 'operator')).rejects.toThrow(/not an app/);
    await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
    await expect(workshop.propose({ subject: 'X', kind: 'fix' }, 'operator')).rejects.toThrow(/in flight/);
  });

  it('idle work needs the switch, and is offered as a candidate rather than created', async () => {
    expect(await workshop.slot()).toBeUndefined();
    await workshop.setArmed(true, 'test');
    const slot = await workshop.slot();
    expect(slot).toMatchObject({ id: 'cand:fix:yundera~X', class: 'idle' });
    expect(store.list()).toHaveLength(0);
  });
});

/** Author a one-line fix and run it through validation; returns the proposal id. */
async function toReady(verdicts: Record<string, string> = {}, extra: Record<string, Record<string, unknown>> = {}): Promise<string> {
  agentScript = async (prompt, ws) => {
    const token = tokenOf(prompt);
    await ws.writeFile(token, 'docker-compose.yml', 'services:\n  x:\n    image: x:1.2.3\n');
    ws.submit(token, 'Pinned the image.');
    return { ok: true, text: 'ok', payload: '' };
  };
  const p = await workshop.propose({ subject: 'X', kind: 'fix' }, 'operator');
  await workshop.dispatch(p.id, lease);
  await finishTrials(verdicts, extra);
  return p.id;
}

describe('the three switches (D15)', () => {
  it('armed picks work but submits nothing by itself', async () => {
    await workshop.setArmed(true, 'test');
    const id = await toReady();
    expect(store.get(id)!.state).toBe('ready');
    await workshop.maybeSubmit();
    expect(store.get(id)!.state).toBe('ready');
  });

  it('auto-submit submits what a person proposed, with the workshop disarmed', async () => {
    workshop.setAutoSubmit(true);
    expect(workshop.armed).toBe(false);
    const id = await toReady();
    expect(store.get(id)!.state).toBe('submitted');
    expect(store.get(id)!.pr?.number).toBe(42);
  });

  it('says once that armed no longer submits, and never again', async () => {
    await workshop.setArmed(true, 'test');
    await workshop.noteSubmitSplit();
    await workshop.noteSubmitSplit();
    await events.flush();
    expect(events.query({}).filter((e) => e.code === 'WORKSHOP_SUBMIT_SPLIT')).toHaveLength(1);
  });

  it('says nothing to a box that was not armed', async () => {
    await workshop.noteSubmitSplit();
    await events.flush();
    expect(events.query({}).filter((e) => e.code === 'WORKSHOP_SUBMIT_SPLIT')).toHaveLength(0);
  });
});

describe('D7′ in validation', () => {
  it('a compliant round that makes a requirement worse goes back, naming it', async () => {
    const id = await toReady(
      {},
      { functional: { standard_sha256: shas.functional, requirements: [{ id: 'first-login', verdict: 'fail', severity: 'minor', requirement: 'credentials documented' }] } },
    );
    const p = store.get(id)!;
    expect(p.baseline?.functional?.requirements['first-login']).toEqual({ verdict: 'pass' });
    expect(p.state).toBe('revising');
    const detail = await workshop.detail(id);
    expect(JSON.stringify(detail)).toContain('first-login');
  });

  it('passes, and says the comparison was partial, when the baseline ran under another standard', async () => {
    const id = await toReady({}, { functional: { requirements: [{ id: 'brand-new', verdict: 'fail', severity: 'minor' }] } });
    const p = store.get(id)!;
    expect(p.state).toBe('ready');
    expect(p.baseline_stale).toContain('functional');
  });
});

describe('push delivery (D16)', () => {
  const writes = () => ghCalls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace('/repos/Yundera/AppStore', '')}`);

  beforeEach(async () => {
    ghCalls = [];
    workshop = await build({ delivery: 'push', push_branch: 'main' });
  });

  it('fast-forwards main with one commit, no branch and no PR, and counts against the quota', async () => {
    const id = await toReady();
    appTreeAt[SHA('d')] = SHA('f');
    ghCalls = [];
    const out = await workshop.submitProposal(id, 'operator');
    expect(out.state).toBe('merged');
    expect(writes()).toEqual(['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'PATCH /git/refs/heads/main']);
    expect(ghCalls.find((c) => c.method === 'PATCH')!.body).toEqual({ sha: SHA('d'), force: false });
    expect(out.delivered).toMatchObject({ mode: 'push', branch: 'main', commit: SHA('d'), parent: SHA('a'), app_tree_sha: SHA('f'), by: 'operator' });
    expect(out.pr).toBeUndefined();
    expect(store.memoryOf(out.task_key)?.outcome).toBe('pushed');
    expect(workshop.quotaNow().allowed).toBe(false);
    await events.flush();
    expect(events.query({}).some((e) => e.code === 'PROPOSAL_PUSHED')).toBe(true);
  });

  it('the view says how it delivers, and the probe asks about protection instead of the label', async () => {
    const v = await workshop.view();
    expect(v.delivery).toEqual({ mode: 'push', branch: 'main' });
    expect(v.github.direct_branch).toBe('main');
    expect(ghCalls.some((c) => c.path.endsWith('/labels/touchstone'))).toBe(false);
  });

  it('a protected branch is a blocking problem before anybody presses Push', async () => {
    mainProtected = true;
    workshop = await build({ delivery: 'push', push_branch: 'main' });
    const id = await toReady();
    await expect(workshop.submitProposal(id, 'operator')).rejects.toThrow(/main is protected/);
    expect(store.get(id)!.state).toBe('ready');
  });

  it('another app landing first: rebuilt on the new head, blobs not uploaded twice', async () => {
    const id = await toReady();
    commitShas = [SHA('d'), SHA('9')];
    // GitHub refuses the first PATCH because another push moved main to 8…; X is the same there.
    patchAnswers = [
      () => {
        mainHead = SHA('8');
        return [422, { message: 'Update is not a fast forward' }];
      },
    ];
    ghCalls = [];
    const out = await workshop.submitProposal(id, 'operator');
    expect(out.state).toBe('merged');
    expect(writes().filter((w) => w === 'POST /git/blobs')).toHaveLength(1);
    expect(writes().filter((w) => w.startsWith('PATCH'))).toHaveLength(2);
    const commits = ghCalls.filter((c) => c.method === 'POST' && c.path.endsWith('/git/commits')).map((c) => (c.body as { parents: string[] }).parents);
    expect(commits).toEqual([[SHA('a')], [SHA('8')]]);
    expect(out.delivered).toMatchObject({ commit: SHA('9'), parent: SHA('8') });
  });

  it('when the head moved and X moved with it, the push is discarded rather than rebuilt', async () => {
    const id = await toReady();
    patchAnswers = [
      () => {
        mainHead = SHA('8');
        appTreeAt[SHA('8')] = SHA('7');
        return [422, { message: 'Update is not a fast forward' }];
      },
    ];
    await expect(workshop.submitProposal(id, 'operator')).rejects.toThrow(/changed/);
    expect(store.get(id)!.state).toBe('discarded');
  });

  it('the app itself changed on main: discarded, nothing charged', async () => {
    const id = await toReady();
    appTree = SHA('7');
    await expect(workshop.submitProposal(id, 'operator')).rejects.toThrow(/changed/);
    expect(store.get(id)!.state).toBe('discarded');
    expect(ghCalls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('a branch that keeps moving gives up after three tries, logged, and stays ready', async () => {
    const id = await toReady();
    patchAnswers = [
      [422, { message: 'Update is not a fast forward' }],
      [422, { message: 'Update is not a fast forward' }],
      [422, { message: 'Update is not a fast forward' }],
    ];
    await expect(workshop.submitProposal(id, 'operator')).rejects.toThrow(WorkshopRefusal);
    expect(store.get(id)!.state).toBe('ready');
    await events.flush();
    expect(events.query({}).some((e) => e.code === 'PROPOSAL_SUBMIT_FAILED')).toBe(true);
  });

  it('revert puts the app tree back in one fast-forward', async () => {
    const id = await toReady();
    commitShas = [SHA('d'), SHA('9')];
    appTreeAt[SHA('d')] = SHA('f');
    await workshop.submitProposal(id, 'operator');
    ghCalls = [];
    const out = await workshop.revert(id, 'operator');
    expect(out.state).toBe('reverted');
    expect(out.delivered?.reverted?.commit).toBe(SHA('9'));
    const tree = ghCalls.find((c) => c.path.endsWith('/git/trees'))!.body as { tree: unknown[] };
    expect(tree.tree).toEqual([{ path: 'Apps/X', mode: '040000', type: 'tree', sha: SHA('e') }]);
    const commit = ghCalls.find((c) => c.path.endsWith('/git/commits') && c.method === 'POST')!.body as { message: string; parents: string[] };
    expect(commit.parents).toEqual([SHA('d')]);
    expect(commit.message).toContain(`This reverts commit ${SHA('d')}`);
    expect(store.memoryOf(out.task_key)?.outcome).toBe('reverted');
    await expect(workshop.revert(id, 'operator')).rejects.toThrow(/not pushed|already/);
  });

  it('revert is refused when somebody changed the app after the push', async () => {
    const id = await toReady();
    appTreeAt[SHA('d')] = SHA('f');
    await workshop.submitProposal(id, 'operator');
    mainHead = SHA('6');
    appTreeAt[SHA('6')] = SHA('5');
    ghCalls = [];
    await expect(workshop.revert(id, 'operator')).rejects.toThrow(/revert it by hand/);
    expect(ghCalls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('a pushed proposal cannot be discarded — it is reverted', async () => {
    const id = await toReady();
    await workshop.submitProposal(id, 'operator');
    await expect(workshop.discard(id, 'operator')).rejects.toThrow(/Revert/);
  });
});

describe('pull-request delivery never moves a branch', () => {
  it('opens its PR without a single PATCH, and has nothing to revert', async () => {
    const id = await toReady();
    await workshop.submitProposal(id, 'operator');
    expect(ghCalls.some((c) => c.method === 'PATCH')).toBe(false);
    await expect(workshop.revert(id, 'operator')).rejects.toThrow(/not pushed/);
  });
});
