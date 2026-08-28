/**
 * The knowledge base store.
 *
 * The tests that matter are about what the KB is *not*: it is selected per run, so a section
 * that never opens a browser is not handed eight kilobytes about a dashboard; and its digest
 * covers what was actually included, so two runs given different pages cannot record the same
 * reference material.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { KbStore, ensureKbFiles, parseKbDoc } from './kb.js';

let dir: string;
let store: KbStore;

const MAISON = `---
id: maison
title: Driving Maison
sections:
  - functional
---

# Driving Maison

The Tips dialog is where an app's first credentials are documented.
`;

const HOUSE = `---
id: house-style
title: House style
---

Write the coverage sentence first.
`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-kb-'));
  await fs.writeFile(path.join(dir, 'KB.md'), '# Knowledge base\n\nWhere to look.\n', 'utf8');
  await fs.writeFile(path.join(dir, 'maison.md'), MAISON, 'utf8');
  await fs.writeFile(path.join(dir, 'house-style.md'), HOUSE, 'utf8');
  store = new KbStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('reading a page', () => {
  it('splits the frontmatter from the prose', () => {
    const doc = parseKbDoc(MAISON, 'maison.md');
    expect(doc).toMatchObject({ id: 'maison', title: 'Driving Maison', sections: ['functional'] });
    expect(doc.body.startsWith('# Driving Maison')).toBe(true);
  });

  it('takes a page with no frontmatter at its filename', () => {
    const doc = parseKbDoc('Just prose.', 'notes.md');
    expect(doc).toMatchObject({ id: 'notes', title: 'notes', sections: [], body: 'Just prose.' });
  });

  it('keeps the index out of the pages', async () => {
    const { index, docs } = await store.load();
    expect(index).toContain('Where to look.');
    expect(docs.map((d) => d.file)).toEqual(['house-style.md', 'maison.md']);
  });
});

describe('choosing what a run is given', () => {
  it('includes a page that declares one of the sections being run', async () => {
    const kb = await store.forSections(['static', 'functional']);
    expect(kb?.docs.map((d) => d.id)).toEqual(['house-style', 'maison']);
  });

  /**
   * The point of `sections:`. A static-only run — which is every run made while the demo pool
   * is down — must not carry the platform pages, or the rubric's own words compete with prose
   * about a dashboard nothing is going to open.
   */
  it('drops a page whose sections are not being audited', async () => {
    const kb = await store.forSections(['static']);
    expect(kb?.docs.map((d) => d.id)).toEqual(['house-style']);
  });

  /**
   * The index is a table of which page to read for what. Handing it over with none of those
   * pages attached describes material the agent has not been given — and that is not a corner
   * case, it is every static-only run on a box whose pages are all about the bench.
   */
  it('answers null when no page applies, however good the index is', async () => {
    await fs.rm(path.join(dir, 'house-style.md'));
    expect(await store.forSections(['static'])).toBeNull();
  });

  it('gives a page that declares no sections to every run', async () => {
    const kb = await store.forSections(['nothing-like-it']);
    expect(kb?.docs.map((d) => d.id)).toEqual(['house-style']);
  });

  /**
   * Null, not an empty knowledge base: the caller records `kb_sha256` only when there was one,
   * and a digest of nothing would read in the archive as a version of something.
   */
  it('answers null when the volume has no knowledge base', async () => {
    const empty = new KbStore(path.join(dir, 'nowhere'));
    expect(await empty.forSections(['static'])).toBeNull();
  });
});

describe('the digest', () => {
  it('is stable across reads', async () => {
    const a = await store.forSections(['functional']);
    const b = await store.forSections(['functional']);
    expect(a?.sha256).toBe(b?.sha256);
  });

  it('differs when a different set of pages was given', async () => {
    const withMaison = await store.forSections(['functional']);
    const without = await store.forSections(['static']);
    expect(withMaison?.sha256).not.toBe(without?.sha256);
  });

  it('moves when a page that was given changes', async () => {
    const before = await store.forSections(['functional']);
    await fs.writeFile(path.join(dir, 'maison.md'), `${MAISON}\nAnd the backup picker.\n`, 'utf8');
    const after = await store.forSections(['functional']);
    expect(after?.sha256).not.toBe(before?.sha256);
  });

  it('moves when the index changes, because the index is given too', async () => {
    const before = await store.forSections(['functional']);
    await fs.writeFile(path.join(dir, 'KB.md'), '# Knowledge base\n\nSomewhere else.\n', 'utf8');
    const after = await store.forSections(['functional']);
    expect(after?.sha256).not.toBe(before?.sha256);
  });

  /**
   * A page nobody was shown cannot move the digest — otherwise every assay in an archive would
   * record a new hash the moment an unrelated page was added, and the one question the digest
   * answers ("was the agent reading the same material?") would answer wrongly.
   */
  it('ignores a page the run was not given', async () => {
    const before = await store.forSections(['static']);
    await fs.writeFile(path.join(dir, 'maison.md'), `${MAISON}\nRewritten entirely.\n`, 'utf8');
    const after = await store.forSections(['static']);
    expect(after?.sha256).toBe(before?.sha256);
  });
});

describe('seeding', () => {
  it('never overwrites a page the operator already has', async () => {
    const seedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-kb-seed-'));
    await fs.writeFile(path.join(seedDir, 'maison.md'), 'the image copy', 'utf8');
    await fs.writeFile(path.join(seedDir, 'new.md'), 'a page the box did not have', 'utf8');

    const res = await ensureKbFiles(dir, seedDir);

    expect(res.seeded).toEqual(['new.md']);
    expect(await fs.readFile(path.join(dir, 'maison.md'), 'utf8')).toContain('Driving Maison');
    await fs.rm(seedDir, { recursive: true, force: true });
  });

  it('is silent when the image ships none', async () => {
    const res = await ensureKbFiles(dir, path.join(dir, 'no-such-seed'));
    expect(res).toEqual({ seeded: [] });
  });
});
