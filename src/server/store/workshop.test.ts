/**
 * The workshop's working copy and memory.
 *
 * The working copy exists because an upload session could not express a deletion; the first
 * test is that one. The rest pin the properties the PR depends on: what is committed is
 * exactly what was validated, a model-chosen path cannot leave the app, and a restart costs
 * the task nothing.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WorkshopError, WorkshopStore } from './workshop.js';

let dir: string;
let store: WorkshopStore;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null | undefined) => (b ? new TextDecoder().decode(b) : null);

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-workshop-'));
  store = new WorkshopStore(path.join(dir, 'state'), path.join(dir, 'workshop'), {
    maxFileBytes: 1024,
    maxTotalBytes: 4096,
  });
  await store.load();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function proposal(taskKey = 'fix:yundera~X') {
  return store.create({
    kind: 'fix',
    task_key: taskKey,
    app: 'X',
    origin: 'yundera',
    class: 'operator',
    asked_at: new Date().toISOString(),
    input_sha: 'i',
    max_rounds: 3,
  });
}

describe('the working copy', () => {
  it('expresses a deletion, an addition and a change against the base', async () => {
    const p = await proposal();
    await store.setBase(
      p.id,
      new Map([
        ['docker-compose.yml', enc('a')],
        ['old.txt', enc('gone')],
        // Inherited names are map keys, so even one the agent could not write is readable.
        ['weird name (1).png', enc('png')],
      ]),
    );
    await store.put(p.id, 'docker-compose.yml', enc('b'));
    await store.put(p.id, 'new.md', enc('hi'));
    expect(await store.del(p.id, 'old.txt')).toBe(true);
    expect(await store.diff(p.id)).toEqual({
      added: ['new.md'],
      modified: ['docker-compose.yml'],
      deleted: ['old.txt'],
    });
    const files = await store.workFiles(p.id);
    expect([...files.keys()]).toEqual(['docker-compose.yml', 'new.md', 'weird name (1).png']);
    expect(dec(files.get('docker-compose.yml'))).toBe('b');
    expect(dec(await store.read(p.id, 'weird name (1).png'))).toBe('png');
    expect(await store.del(p.id, 'weird name (1).png')).toBe(true);
  });

  it('refuses a path that would leave the app', async () => {
    const p = await proposal();
    await store.setBase(p.id, new Map());
    for (const bad of ['../x', 'a/../../b', '.hidden', 'a//b', '']) {
      await expect(store.put(p.id, bad, enc('x'))).rejects.toThrow(WorkshopError);
    }
  });

  it('caps a file and the whole copy', async () => {
    const p = await proposal();
    await store.setBase(p.id, new Map());
    await expect(store.put(p.id, 'big', new Uint8Array(2000))).rejects.toThrow(/per file/);
    for (let i = 0; i < 4; i++) await store.put(p.id, `f${i}`, new Uint8Array(1000));
    await expect(store.put(p.id, 'f4', new Uint8Array(1000))).rejects.toThrow(/limit is 4096/);
    // Replacing a file is measured without its old bytes.
    await expect(store.put(p.id, 'f0', new Uint8Array(1000))).resolves.toBeTruthy();
  });

  it('shows text on both sides of a change, and none for binary', async () => {
    const p = await proposal();
    await store.setBase(p.id, new Map([['a.yml', enc('one')], ['i.png', new Uint8Array([0, 1, 2])]]));
    await store.put(p.id, 'a.yml', enc('two'));
    await store.put(p.id, 'i.png', new Uint8Array([0, 9]));
    const files = await store.diffFiles(p.id);
    expect(files.find((f) => f.path === 'a.yml')).toMatchObject({ before: 'one', after: 'two', change: 'modified' });
    expect(files.find((f) => f.path === 'i.png')?.after).toBeUndefined();
  });
});

describe('proposals', () => {
  it('allows one live proposal per task', async () => {
    await proposal('fix:yundera~X');
    await expect(proposal('fix:yundera~X')).rejects.toThrow(/in flight/);
    await expect(proposal('fix:yundera~Y')).resolves.toBeTruthy();
  });

  it('puts an interrupted session back at no cost, and survives a reload', async () => {
    const p = await proposal();
    await store.update(p.id, { state: 'authoring', started_at: new Date().toISOString() });
    const q = await proposal('fix:yundera~Q');
    await store.update(q.id, { state: 'authoring', round: 2 });

    const again = new WorkshopStore(path.join(dir, 'state'), path.join(dir, 'workshop'), {
      maxFileBytes: 1,
      maxTotalBytes: 1,
    });
    await again.load();
    expect((await again.reconcile()).sort()).toEqual([p.id, q.id].sort());
    expect(again.get(p.id)).toMatchObject({ state: 'queued', interrupted: 1 });
    expect(again.get(p.id)?.started_at).toBeUndefined();
    expect(again.get(q.id)?.state).toBe('revising');
    expect(again.memory()).toEqual({});
  });

  it('counts pull requests opened since a time', async () => {
    const p = await proposal();
    await store.update(p.id, { pr: { number: 1, url: 'u', state: 'open', opened_at: '2026-10-02T10:00:00Z' } });
    expect(store.submittedSince('2026-10-02T09:00:00Z')).toHaveLength(1);
    expect(store.submittedSince('2026-10-02T11:00:00Z')).toHaveLength(0);
  });
});

describe('memory', () => {
  it('counts attempts per input and resets when the input changes', async () => {
    const at = new Date().toISOString();
    expect((await store.remember('wish:a.md', { input_sha: 's1', last_attempt_at: at, outcome: 'cannot' })).attempts).toBe(1);
    expect((await store.remember('wish:a.md', { input_sha: 's1', last_attempt_at: at, outcome: 'cannot' })).attempts).toBe(2);
    expect((await store.remember('wish:a.md', { input_sha: 's2', last_attempt_at: at, outcome: 'cannot' })).attempts).toBe(1);
    expect(await store.forget('wish:a.md')).toBe(true);
    expect(store.memoryOf('wish:a.md')).toBeUndefined();
  });
});
