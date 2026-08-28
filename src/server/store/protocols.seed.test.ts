/**
 * Seeding the rubric into the data directory.
 *
 * This exists because the data dir is a volume that starts empty, and an empty protocol
 * directory means `sectionsOf()` returns nothing, every run blocks `no_protocol`, and the
 * Protocols page is blank — with no error anywhere saying why.
 *
 * Since 2026-08-28 it is also the path **development** takes: `seed/protocols/` is tracked and
 * `data/` is not, so a fresh checkout seeds itself on first boot exactly as a container does.
 * Before that the checkout arrived with `data/protocols/` already populated, and this code ran
 * nowhere but in production — which is a poor place to find out it does not work.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureProtocolFiles, ProtocolStore } from './protocols.js';

let dir: string;
let seedDir: string;
let dataProtocols: string;

const LEAF = (id: string, version: number) =>
  ['---', `id: ${id}`, `name: ${id} protocol`, `version: ${version}`, 'kind: leaf', 'order: 1', '---', '', '# body', ''].join('\n');

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-seed-'));
  seedDir = path.join(dir, 'seed');
  dataProtocols = path.join(dir, 'data', 'protocols');
  await fs.mkdir(seedDir, { recursive: true });
  await fs.writeFile(path.join(seedDir, 'static.md'), LEAF('static', 6), 'utf8');
  await fs.writeFile(path.join(seedDir, 'functional.md'), LEAF('functional', 5), 'utf8');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ensureProtocolFiles', () => {
  it('populates an empty data directory, so a fresh container has a rubric', async () => {
    const res = await ensureProtocolFiles(dataProtocols, seedDir);

    expect(res.seeded.sort()).toEqual(['functional.md', 'static.md']);
    expect(res.failed).toBeUndefined();

    // The real assertion: the store can now resolve sections. Without this, the runner blocks
    // `no_protocol` on every job and nothing says the rubric was never installed.
    const store = new ProtocolStore(dataProtocols);
    const list = await store.list();
    expect(list.map((p) => p.meta.id).sort()).toEqual(['functional', 'static']);
  });

  it('never overwrites an operator edit', async () => {
    await fs.mkdir(dataProtocols, { recursive: true });
    // An edited rubric at a *higher* version than the image ships — the steady state after
    // somebody saves from the Protocols page.
    await fs.writeFile(path.join(dataProtocols, 'static.md'), LEAF('static', 99), 'utf8');

    const res = await ensureProtocolFiles(dataProtocols, seedDir);

    // Only the missing one is written.
    expect(res.seeded).toEqual(['functional.md']);
    // And the edit stands. A redeploy that reverted it would silently change what every
    // subsequent assay is judged against, while each assay records a version that no longer
    // means what it says.
    const kept = await fs.readFile(path.join(dataProtocols, 'static.md'), 'utf8');
    expect(kept).toContain('version: 99');
  });

  it('is a no-op on the second boot', async () => {
    await ensureProtocolFiles(dataProtocols, seedDir);
    const second = await ensureProtocolFiles(dataProtocols, seedDir);
    expect(second.seeded).toEqual([]);
    expect(second.failed).toBeUndefined();
  });

  it('does nothing, quietly, when there is no seed directory', async () => {
    // An install carrying no seed at all: there is nothing to copy and that is not an error.
    // The run that follows blocks `no_protocol`, which says so where an operator can see it.
    const res = await ensureProtocolFiles(dataProtocols, path.join(dir, 'absent'));
    expect(res).toEqual({ seeded: [] });
  });

  it('reports a failure instead of throwing, so an unwritable data dir still boots', async () => {
    // A *file* where the protocols directory should be: `mkdir` fails. Stands in for the
    // read-only mount that `ensureConfigFile` already documents as a real deployment.
    const blocked = path.join(dir, 'blocked');
    await fs.writeFile(blocked, 'not a directory', 'utf8');

    const res = await ensureProtocolFiles(path.join(blocked, 'protocols'), seedDir);

    expect(res.failed).toBeTruthy();
    expect(res.seeded).toEqual([]);
  });
});
