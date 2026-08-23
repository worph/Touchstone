/**
 * The rubric, and the history that makes its identity mean something.
 *
 * The property under test throughout is invariant 9's second half: an assay records the
 * sha256 of the protocol that judged it, and that hash has to resolve to the exact bytes. So
 * these check the whole loop — save, record, list, fetch, diff — rather than each route on
 * its own, plus the two refusals that keep the loop honest: no reason, no save; and no route
 * that rewinds a protocol to an earlier revision.
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProtocolStore } from '../store/protocols.js';
import { RevisionStore } from '../store/revisions.js';
import routes from './protocols.js';

let dir: string;
let app: FastifyInstance;
let revisions: RevisionStore;

const STATIC = `---
id: static
name: Static Review Protocol
kind: leaf
order: 1
executor: currency.sh
---

# Static Review Protocol

Rule one.
`;

async function serve(): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(routes, { protocols: new ProtocolStore(dir), revisions });
  await instance.ready();
  return instance;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-protocol-routes-'));
  await fs.writeFile(path.join(dir, 'static.md'), STATIC, 'utf8');
  await fs.writeFile(path.join(dir, 'currency.sh'), '#!/bin/sh\nexit 0\n', 'utf8');
  revisions = new RevisionStore(dir);
  // What `index.ts` does at boot, and the reason the pre-cutover text of a rubric survives
  // its first edit: the history is recording before anything reads or writes a protocol.
  await revisions.sweep();
  app = await serve();
});

afterEach(async () => {
  await app?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const save = (body: string, message: string | undefined = 'because') =>
  app.inject({ method: 'PUT', url: '/protocols/static', payload: { body, message } });

describe('listing', () => {
  it('identifies a protocol by its hash, and carries no version number', async () => {
    const res = await app.inject({ method: 'GET', url: '/protocols' });
    const [p] = res.json().protocols;
    expect(p.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.version).toBeUndefined();
  });
});

describe('saving', () => {
  it('refuses without a reason, and records nothing', async () => {
    const res = await save('# Changed', '   ');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/why/);
    const after = await app.inject({ method: 'GET', url: '/protocols/static/revisions' });
    expect(after.json().revisions.filter((r: { source: string }) => r.source === 'save')).toEqual([]);
  });

  it('refuses an empty body, which would pass every app', async () => {
    expect((await save('   ')).statusCode).toBe(400);
  });

  it('records the reason against the new revision', async () => {
    const res = await save('# Changed\n\nRule two.', 'rule one was unenforceable');
    expect(res.statusCode).toBe(200);
    expect(res.json().revision).toMatchObject({
      file: 'static.md',
      source: 'save',
      message: 'rule one was unenforceable',
    });
    expect(res.json().sha256).toBe(res.json().revision.sha256);
  });

  /**
   * The script beside a rubric has no editor and is changed on the volume. A save is the
   * cheapest moment to notice, and what it notices is not attributed to the operator.
   */
  it('notices a hand-edited executor at the same time, without a reason', async () => {
    await fs.writeFile(path.join(dir, 'currency.sh'), '#!/bin/sh\necho different\n', 'utf8');
    await save('# Changed', 'unrelated edit');

    const rows = (await app.inject({ method: 'GET', url: '/protocols/static/revisions' })).json();
    const script = rows.revisions.filter((r: { file: string }) => r.file === 'currency.sh');
    expect(script[0]).toMatchObject({ source: 'observed', message: null });
  });
});

describe('the history', () => {
  it('covers the rubric and the script it names', async () => {
    const res = await app.inject({ method: 'GET', url: '/protocols/static/revisions' });
    expect(res.json().files).toEqual(['static.md', 'currency.sh']);
    expect(res.json().revisions.map((r: { file: string }) => r.file).sort()).toEqual([
      'currency.sh',
      'static.md',
    ]);
  });

  it('hands back the exact bytes a hash names, long after the file moved on', async () => {
    const first = (await app.inject({ method: 'GET', url: '/protocols' })).json().protocols[0];
    await save('# Changed', 'moved on');

    const res = await app.inject({
      method: 'GET',
      url: `/protocols/static/revisions/${first.sha256}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().body).toBe(STATIC);
    expect(res.json().html).toContain('Rule one');
  });

  it('answers 404 for a hash it never recorded', async () => {
    const res = await app.inject({ method: 'GET', url: `/protocols/static/revisions/${'0'.repeat(64)}` });
    expect(res.statusCode).toBe(404);
  });

  it('diffs a revision against its parent by default', async () => {
    await save('# Static Review Protocol\n\nRule one.\nRule two.', 'added a rule');
    const head = (await app.inject({ method: 'GET', url: '/protocols/static/revisions' })).json()
      .revisions[0];

    const res = await app.inject({
      method: 'GET',
      url: `/protocols/static/revisions/${head.sha256}/diff`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().from.sha256).toBe(head.parent);
    expect(res.json().diff.added).toBeGreaterThan(0);
  });

  /**
   * The bug this exists to prevent: expanding the newest row showed the diff of the *oldest*
   * row with the same hash, because a restored file has the identity it had before.
   */
  it('diffs the row asked for, not the first row with the same hash', async () => {
    await save('# Static Review Protocol\n\nRule two.', 'change it');
    await save('# Static Review Protocol\n\nRule one.', 'and put it back');

    const rows = (await app.inject({ method: 'GET', url: '/protocols/static/revisions' })).json()
      .revisions as { seq: number; sha256: string; parent: string | null; file: string }[];
    const restored = rows.find((r) => r.file === 'static.md')!;
    const original = rows.filter((r) => r.sha256 === restored.sha256).at(-1)!;
    expect(original.seq).not.toBe(restored.seq);

    const res = await app.inject({
      method: 'GET',
      url: `/protocols/static/revisions/${restored.sha256}/diff?seq=${restored.seq}`,
    });
    expect(res.json().to.seq).toBe(restored.seq);
    expect(res.json().from.sha256).toBe(restored.parent);
    // Without the seq it answers about the earliest row of that content, which is a different
    // question and a different parent.
    const bare = await app.inject({
      method: 'GET',
      url: `/protocols/static/revisions/${restored.sha256}/diff`,
    });
    expect(bare.json().to.seq).toBe(original.seq);
  });

  it('refuses to diff a rubric against a script', async () => {
    const rows = (await app.inject({ method: 'GET', url: '/protocols/static/revisions' })).json();
    const md = rows.revisions.find((r: { file: string }) => r.file === 'static.md');
    const sh = rows.revisions.find((r: { file: string }) => r.file === 'currency.sh');
    const res = await app.inject({
      method: 'GET',
      url: `/protocols/static/revisions/${md.sha256}/diff?against=${sh.sha256}`,
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * Invariant 6's shape here: a model reaching the admin MCP can edit a rubric, and must not be
 * able to quietly put an old one back. Restoring is an ordinary save of the old text, with a
 * reason, recorded as a new revision — so there is no verb for it.
 */
describe('what there is no route for', () => {
  it('offers no way to rewind a protocol to an earlier revision', async () => {
    const first = (await app.inject({ method: 'GET', url: '/protocols' })).json().protocols[0];
    await save('# Changed', 'moved on');

    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const res = await app.inject({
        method,
        url: `/protocols/static/revisions/${first.sha256}`,
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
