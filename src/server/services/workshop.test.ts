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
import { Workshop, WorkshopRefusal } from './workshop.js';

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
    if (p === '/repos/Yundera/AppStore/git/ref/heads/main') return json(200, { object: { sha: SHA('a') } });
    if (p.startsWith('/repos/Yundera/AppStore/contents/Apps?ref=')) return json(200, [{ name: 'X', type: 'dir', sha: appTree }]);
    if (p.startsWith('/repos/Yundera/AppStore/pulls?state=open')) return json(200, []);
    if (p === `/repos/Yundera/AppStore/git/commits/${SHA('a')}`) return json(200, { tree: { sha: SHA('1') } });
    if (method === 'POST' && p === '/repos/Yundera/AppStore/git/blobs') {
      return blobRefused ? json(403, { message: 'Resource not accessible by personal access token' }) : json(201, { sha: SHA('b') });
    }
    if (method === 'POST' && p === '/repos/Yundera/AppStore/git/trees') return json(201, { sha: SHA('c') });
    if (method === 'POST' && p === '/repos/Yundera/AppStore/git/commits') return json(201, { sha: SHA('d') });
    if (method === 'POST' && p === '/repos/Yundera/AppStore/git/refs') return json(201, {});
    if (method === 'POST' && p === '/repos/Yundera/AppStore/pulls') return json(201, { number: 42, html_url: 'https://github.com/Yundera/AppStore/pull/42' });
    if (method === 'POST' && p === '/repos/Yundera/AppStore/issues/42/labels') return json(200, []);
    if (p === '/repos/Yundera/AppStore/pulls/42') return json(200, { state: 'closed', merged: false });
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
    { meta: meta('functional', 'compliant'), path: 'yundera/X/a-functional.md', subject: asSubjectKey('yundera~X'), section: 'functional' },
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
  const fetchImpl = fakeFetch();
  const github = new GitHubClient({ token: 'ghp_SECRET_TOKEN', repo: ORIGIN.repo, fetchImpl });
  const probe = new GitHubProbe({ client: github, expectedLogin: 'Mael' });
  await probe.probe();
  agentScript = async () => ({ ok: true, text: 'done', payload: '' });
  workshop = new Workshop({
    store,
    settings: {
      origin: 'yundera',
      armed: false,
      prs_per_day: 1,
      max_rounds: 2,
      session_minutes: 10,
      currency_section: 'currency',
      login: 'Mael',
      commit_name: 'Mael (Touchstone)',
      commit_email: '',
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
    protocols: new ProtocolStore(protocolsDir),
    trialDeps: () => ({ runner: { enabled: true } as never, trials, trialsRoot: path.join(dir, 'trials'), events, origins: [ORIGIN], publicBaseUrl: 'https://touchstone.example' }),
    trialsRoot: path.join(dir, 'trials'),
    leases: { release: (id?: string) => id && released.push(id) } as never,
    events,
    fetchImpl,
    postAgent: async (prompt) => agentScript(prompt, workshop),
  });
});

afterEach(async () => {
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

const tokenOf = (prompt: string) => /session_token is (\S+?) -/.exec(prompt)![1]!;
const lease = { id: 'L1', target: 'yundera', bench: { name: 'b', url: 'https://bench.example', status: 'healthy' }, browser: { name: 'br', kind: 'browser', url: 'http://browser/mcp', status: 'healthy' }, holder: 'w', since: '' } as never;

/** Finish every queued trial of a proposal with these verdicts per section. */
async function finishTrials(verdicts: Record<string, string>) {
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
    const submitted = await workshop.submitPr(p.id, 'operator');
    expect(submitted.state).toBe('submitted');
    expect(submitted.pr?.number).toBe(42);
    const writes = ghCalls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path.replace('/repos/Yundera/AppStore', '')}`);
    expect(writes).toEqual(['POST /git/blobs', 'POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls', 'POST /issues/42/labels']);
    const tree = ghCalls.find((c) => c.path.endsWith('/git/trees'))!.body as { tree: { path: string; sha: string | null }[] };
    expect(tree.tree).toEqual([
      { path: 'Apps/X/docker-compose.yml', mode: '100644', type: 'blob', sha: SHA('b') },
      { path: 'Apps/X/old.txt', mode: '100644', type: 'blob', sha: null },
    ]);
    const commit = ghCalls.find((c) => c.path.endsWith('/git/commits') && c.method === 'POST')!.body as { author: { name: string; email: string } };
    expect(commit.author).toEqual({ name: 'Mael (Touchstone)', email: '7+Mael@users.noreply.github.com' });
    const ref = (ghCalls.find((c) => c.path.endsWith('/git/refs'))!.body as { ref: string }).ref;
    expect(ref).toMatch(/^refs\/heads\/touchstone\/fix\/X-\d{8}-[a-f0-9]{6}$/);
    expect(store.memoryOf(p.task_key)?.outcome).toBe('pr_opened');

    // The quota: one a day.
    await expect(workshop.submitPr(p.id, 'operator')).rejects.toThrow(WorkshopRefusal);

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
    await expect(workshop.submitPr(p.id, 'operator')).rejects.toThrow(/changed/);
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
    const refusal = await workshop.submitPr(p.id, 'operator').catch((err: unknown) => err);
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
