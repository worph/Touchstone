/**
 * What an upload session is a working copy *of*.
 *
 * `buildSpec` is the seam where a trial stops being two kinds and becomes one store, and since
 * 2026-09-07 it is also where an upload session is laid over the app its store already has.
 * That change exists because the previous behaviour — a session **is** the whole app directory
 * — turned the fix-iterate loop `open_trial` was built for into a trap: `OpenClaw@fcb4e4c9`
 * uploaded a compose, a rationale and a seed template, and the audit correctly filed a Major
 * against an `icon.png` and a `screenshot-1.png` that were sitting in the repo untouched. The
 * verdict came back non-compliant and buried the two real findings the trial was run to check.
 *
 * So what is worth testing here is the inheritance and, just as much, its absence: an app no
 * store has yet must still be audited on its own bytes, and a store that cannot be reached must
 * not take the trial down with it.
 */

import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';

import type { OriginEntry } from '../store/config.js';
import { UploadStore } from '../store/uploads.js';
import { buildSpec, type TrialRunDeps } from './trialrun.js';

let dir: string;

const ORIGIN: OriginEntry = {
  id: 'yundera',
  repo: 'Yundera/AppStore',
  ref: 'main',
  apps_path: 'Apps',
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-trialrun-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

/**
 * The store as GitHub serves it — one wrapper directory, then `Apps/<App>/`.
 *
 * Carries a second app for the same reason `routes/trials.test.ts`'s fixture does: a one-app
 * store would let "only the subject is inherited" pass by accident.
 */
function storeArchive(): Buffer {
  const enc = new TextEncoder();
  return Buffer.from(
    zipSync({
      'AppStore-main/Apps/Widget/docker-compose.yml': enc.encode('name: as-committed\n'),
      'AppStore-main/Apps/Widget/icon.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      'AppStore-main/Apps/Widget/screenshot-1.png': new Uint8Array([0x01, 0x02]),
      'AppStore-main/Apps/Widget/rationale.md': enc.encode('# why\n'),
      'AppStore-main/Apps/Bystander/docker-compose.yml': enc.encode('name: bystander\n'),
    }),
  );
}

/** Serves that archive to whatever asks, so no test reaches GitHub. */
function fetchOf(zip: Buffer | null): typeof fetch {
  return (async () => {
    if (!zip) return { ok: false, status: 404, statusText: 'Not Found', headers: new Headers() };
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Headers({ 'content-length': String(zip.byteLength) }),
      arrayBuffer: async () => zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength),
    };
  }) as unknown as typeof fetch;
}

async function sessionOf(
  subject: string,
  files: Record<string, string | Uint8Array>,
): Promise<{ uploads: UploadStore; id: string }> {
  const uploads = new UploadStore(
    path.join(dir, 'state'),
    path.join(dir, 'uploads'),
    { max_file_bytes: 4096, max_total_bytes: 16384, ttl_min: 60 },
  );
  await uploads.load();
  const session = await uploads.create({ subject, repo: ORIGIN.repo });
  for (const [rel, body] of Object.entries(files)) {
    await uploads.put(session, rel, Buffer.from(typeof body === 'string' ? body : body));
  }
  return { uploads, id: session.id };
}

function depsOf(uploads: UploadStore, known: string[], zip: Buffer | null): TrialRunDeps {
  return { uploads, origins: [ORIGIN], known: () => known, fetchImpl: fetchOf(zip) };
}

/** The relative paths inside the one-app store a trial serves to the bench. */
function packedFiles(zip: Buffer, subject: string): string[] {
  return Object.keys(unzipSync(new Uint8Array(zip)))
    .map((name) => name.split(`/Apps/${subject}/`)[1])
    .filter((rel): rel is string => Boolean(rel))
    .sort();
}

/**
 * A trial is the one caller that may name a platform.
 *
 * Everything else infers it: a scheduled audit is dispatched on the line it was picked from. A
 * trial has no subject row and therefore no line — and trialling a change against the FOSS
 * stack is the whole reason for having one.
 */
describe('which platform a trial is audited on', () => {
  it('carries the target the caller named onto the spec', async () => {
    const { uploads, id } = await sessionOf('Widget', { 'docker-compose.yml': 'name: w\n' });
    const out = await buildSpec(
      depsOf(uploads, ['yundera~Widget'], storeArchive()),
      { upload: id, target: 'foss' },
      'now',
    );
    expect(out.ok && out.spec.target).toBe('foss');
  });

  /** Absent means the default platform, which is what every trial was before targets existed. */
  it('names none when the caller did not, rather than inventing one', async () => {
    const { uploads, id } = await sessionOf('Widget', { 'docker-compose.yml': 'name: w\n' });
    const out = await buildSpec(depsOf(uploads, ['yundera~Widget'], storeArchive()), { upload: id }, 'now');
    expect(out.ok && out.spec.target).toBeUndefined();
  });
});

describe('an upload trial, laid over the app its store has', () => {
  it('inherits the files the session left out rather than calling them missing', async () => {
    const { uploads, id } = await sessionOf('Widget', { 'docker-compose.yml': 'name: changed\n' });
    const out = await buildSpec(depsOf(uploads, ['yundera~Widget'], storeArchive()), { upload: id }, 'now');

    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The one file uploaded wins, and the three nobody touched came from the store.
    expect(out.spec.source.compose).toBe('name: changed\n');
    expect(out.spec.source.files).toEqual([
      'docker-compose.yml',
      'icon.png',
      'rationale.md',
      'screenshot-1.png',
    ]);
    // This is the finding that started it: `assets` is judged on that list.
    expect(out.spec.source.files).toContain('icon.png');
    expect(out.spec.source.files).toContain('screenshot-1.png');
  });

  /**
   * The invariant the whole design hangs on: the prompt's file list and the store the bench
   * installs are built from one `Map`, so inheritance cannot reach one and miss the other. Get
   * this wrong and the audit reads an icon that the running app does not have.
   */
  it('serves the bench exactly the files it tells the auditor about', async () => {
    const { uploads, id } = await sessionOf('Widget', { 'docker-compose.yml': 'name: changed\n' });
    const out = await buildSpec(depsOf(uploads, ['yundera~Widget'], storeArchive()), { upload: id }, 'now');
    if (!out.ok) throw new Error('expected a spec');

    expect(packedFiles(out.spec.zip, 'Widget')).toEqual(out.spec.source.files);
    // And only this app: the store it came from had a second one.
    expect(packedFiles(out.spec.zip, 'Bystander')).toEqual([]);
  });

  it('takes the uploaded bytes over the committed ones, not the other way round', async () => {
    const { uploads, id } = await sessionOf('Widget', {
      'docker-compose.yml': 'name: changed\n',
      'icon.png': new Uint8Array([0xff]),
    });
    const out = await buildSpec(depsOf(uploads, ['yundera~Widget'], storeArchive()), { upload: id }, 'now');
    if (!out.ok) throw new Error('expected a spec');

    const entries = unzipSync(new Uint8Array(out.spec.zip));
    const icon = Object.entries(entries).find(([n]) => n.endsWith('/Apps/Widget/icon.png'))?.[1];
    expect([...icon!]).toEqual([0xff]);
  });

  /**
   * An app no store has yet is the documented case from `docs/requirements.md` §13 — and there
   * is nothing to inherit, so a missing icon really is missing and `assets` should say so.
   */
  it('inherits nothing for an app no store offers, which is the honest answer', async () => {
    const { uploads, id } = await sessionOf('Newcomer', { 'docker-compose.yml': 'name: new\n' });
    const out = await buildSpec(depsOf(uploads, [], storeArchive()), { upload: id }, 'now');
    if (!out.ok) throw new Error('expected a spec');

    expect(out.spec.source.files).toEqual(['docker-compose.yml']);
    expect(out.compare_to).toBeUndefined();
  });

  /**
   * Inheriting is a convenience, never a precondition. An origin that is unreachable — down,
   * rate-limited, renamed — must leave the caller with the trial they asked for rather than a
   * refusal about a fetch they never made.
   */
  it('still audits the session when the store cannot be reached', async () => {
    const { uploads, id } = await sessionOf('Widget', { 'docker-compose.yml': 'name: changed\n' });
    const out = await buildSpec(depsOf(uploads, ['yundera~Widget'], null), { upload: id }, 'now');

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.spec.source.files).toEqual(['docker-compose.yml']);
    // The rubric anchor still resolves, because that never depended on the fetch.
    expect(out.spec.repo).toBe('Yundera/AppStore');
  });

  it('refuses a session with no compose before it fetches anything', async () => {
    const { uploads, id } = await sessionOf('Widget', { 'icon.png': new Uint8Array([0x89]) });
    const out = await buildSpec(depsOf(uploads, ['yundera~Widget'], storeArchive()), { upload: id }, 'now');

    // The caller's mistake is not having uploaded anything yet, and inheriting a compose from
    // the store would hide it behind an audit of the app exactly as it already stands.
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe(400);
    expect(out.error).toContain('docker-compose.yml');
  });
});
