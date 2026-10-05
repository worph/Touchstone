/**
 * Setting the workshop's GitHub token from the page: the client is swapped at once, the probe
 * answers in the same call, clearing falls back to the boot token, and the token itself is
 * never written to the event log.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitHubTokenStore } from '../store/githubtoken.js';
import { WorkshopStore } from '../store/workshop.js';
import { EventLog } from './events.js';
import { GitHubClient } from './github.js';
import { GitHubProbe } from './githubprobe.js';
import { Workshop } from './workshop.js';

const ORIGIN = { id: 'yundera', repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' };

let dir: string;
let events: EventLog;
let tokens: GitHubTokenStore;
let seen: string[];

/** GitHub answers `/user` as whoever the bearer names. */
const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
  const auth = new Headers(init?.headers).get('authorization') ?? '';
  seen.push(auth);
  const p = String(url).replace('https://api.github.com', '');
  const json = (status: number, body: unknown) =>
    ({ ok: status < 400, status, text: async () => JSON.stringify(body) }) as Response;
  if (auth.endsWith('bad')) return json(401, { message: 'Bad credentials' });
  if (p === '/user') return json(200, { login: auth.endsWith('boot') ? 'Boot' : 'Page', id: 1 });
  if (p === '/repos/Yundera/AppStore') return json(200, { permissions: { push: true } });
  if (p === '/repos/Yundera/AppStore/labels/touchstone') return json(200, { name: 'touchstone' });
  return json(404, { message: 'Not Found' });
}) as typeof fetch;

const make = (token: string) => new GitHubClient({ token, repo: ORIGIN.repo, fetchImpl });

async function workshop(bootToken: string): Promise<Workshop> {
  const store = new WorkshopStore(path.join(dir, 'state'), path.join(dir, 'workshop'), { maxFileBytes: 1 << 20, maxTotalBytes: 1 << 22 });
  await store.load();
  const github = bootToken ? make(bootToken) : undefined;
  return new Workshop({
    store,
    settings: { origin: 'yundera', armed: false, prs_per_day: 1, max_rounds: 2, session_minutes: 10, currency_section: 'currency', login: '', commit_name: 'x', commit_email: '' },
    origins: [ORIGIN],
    ...(github ? { github } : {}),
    probe: new GitHubProbe({ ...(github ? { client: github } : {}), expectedLogin: '' }),
    tokens,
    tokenSource: 'boot',
    bootToken,
    makeGitHub: (token) => make(token),
    publicBaseUrl: 'https://touchstone.example',
    callbackUrl: 'http://touchstone/api/v1/mcp/workshop',
    agent: {},
    runner: { enabled: true, busyBackoffMin: 10 },
    index: { all: () => [], read: () => null },
    trialDeps: () => ({}) as never,
    trialsRoot: path.join(dir, 'trials'),
    events,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-wstoken-'));
  events = new EventLog(path.join(dir, 'state'));
  await events.load();
  tokens = new GitHubTokenStore(dir);
  seen = [];
});

afterEach(async () => {
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the GitHub token, set from the page', () => {
  it('configures an unconfigured workshop at once and probes it in the same call', async () => {
    const ws = await workshop('');
    expect(ws.unconfigured()).toMatch(/no GitHub token/);
    expect(ws.tokenInfo().source).toBeNull();

    const status = await ws.setToken('ghp_page', 'operator');
    expect(status).toMatchObject({ state: 'ok', login: 'Page' });
    expect(ws.unconfigured()).toBeNull();
    expect(ws.tokenInfo()).toMatchObject({ source: 'page', settable: true });
    expect((await tokens.read())?.token).toBe('ghp_page');
  });

  it('clearing falls back to the boot token, or to none', async () => {
    const ws = await workshop('ghp_boot');
    await ws.setToken('ghp_page', 'operator');
    const back = await ws.setToken(null, 'operator');
    expect(back).toMatchObject({ state: 'ok', login: 'Boot' });
    expect(ws.tokenInfo().source).toBe('boot');
    expect(await tokens.read()).toBeNull();

    const bare = await workshop('');
    await bare.setToken('ghp_page', 'operator');
    expect((await bare.setToken(null, 'operator')).state).toBe('unconfigured');
    expect(bare.unconfigured()).toMatch(/no GitHub token/);
  });

  it('stores a token that does not work and says why, rather than refusing it', async () => {
    const ws = await workshop('');
    const status = await ws.setToken('ghp_bad', 'operator');
    expect(status.state).toBe('failing');
    expect(status.problems.join(' ')).toMatch(/Bad credentials|401/);
    expect(ws.tokenInfo().source).toBe('page');
  });

  it('never writes the token to the event log', async () => {
    const ws = await workshop('');
    await ws.setToken('ghp_page_SECRET', 'operator');
    await ws.setToken(null, 'operator');
    await events.flush();
    const log = await fs.readFile(path.join(dir, 'state', 'events.jsonl'), 'utf8');
    expect(log).toMatch(/GITHUB_TOKEN_SET/);
    expect(log).toMatch(/GITHUB_TOKEN_CLEARED/);
    expect(log).not.toMatch(/SECRET/);
  });
});
