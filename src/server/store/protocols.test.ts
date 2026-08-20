import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProtocolStore, isSafeId, parseProtocol, sectionsOf, serialiseProtocol } from './protocols.js';

let dir: string;
let store: ProtocolStore;

const STATIC = `---
id: static
name: Static Review Protocol
version: 3
kind: leaf
leg: static
requires_bench: false
imported_from: docmost:LPwfKYUVig
---

# Static Review Protocol

Evaluate every statically verifiable item.
`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-protocols-'));
  await fs.writeFile(path.join(dir, 'static.md'), STATIC, 'utf8');
  store = new ProtocolStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('reading one', () => {
  it('splits the frontmatter from the prose', async () => {
    const p = await store.get('static');
    expect(p?.meta).toMatchObject({ id: 'static', version: 3, requires: [] });
    expect(p?.body.startsWith('# Static Review Protocol')).toBe(true);
    expect(p?.body).not.toContain('imported_from');
  });

  /** Provenance, and the reason this file exists at all. Nothing reads it. */
  it('keeps where it came from', async () => {
    expect((await store.get('static'))?.meta.imported_from).toBe('docmost:LPwfKYUVig');
  });

  /**
   * A hand-written protocol with no frontmatter is still a protocol. Refusing it would make
   * starting one from scratch impossible, which is the opposite of the point.
   */
  it('loads a file with no frontmatter at all', () => {
    const { meta, body } = parseProtocol('# Just prose\n', 'ad-hoc.md');
    expect(meta.id).toBe('ad-hoc');
    expect(meta.version).toBe(0);
    expect(body).toBe('# Just prose');
  });

  it('answers nothing for one that is not there', async () => {
    expect(await store.get('nope')).toBeNull();
  });
});

describe('editing', () => {
  /**
   * Every assay records the standard and version it was graded against. An edit that left the
   * number alone would make two different rubrics indistinguishable in the archive — it would
   * claim runs judged by different rules were judged by the same one.
   */
  it('bumps the version', async () => {
    const saved = await store.save('static', '# New rubric\n\nOne rule only.');
    expect(saved?.meta.version).toBe(4);
    expect((await store.get('static'))?.body).toContain('One rule only');
  });

  it('can be told not to, for a typo fix', async () => {
    const saved = await store.save('static', '# Fixed typo', { bumpVersion: false });
    expect(saved?.meta.version).toBe(3);
  });

  it('keeps the rest of the frontmatter across a save', async () => {
    const saved = await store.save('static', '# New');
    expect(saved?.meta).toMatchObject({ leg: 'static', requires_bench: false, imported_from: 'docmost:LPwfKYUVig' });
  });

  it('round-trips through serialise without losing a key', () => {
    const { meta, body } = parseProtocol(serialiseProtocol({ id: 'x', name: 'X', version: 2, kind: 'leaf', extra: 'kept' }, 'body'), 'x.md');
    expect(meta.extra).toBe('kept');
    expect(body).toBe('body');
  });

  it('refuses to save one that does not exist', async () => {
    expect(await store.save('nope', 'text')).toBeNull();
  });
});

describe('listing', () => {
  it('puts the orchestrator first, because it is what composes the rest', async () => {
    await fs.writeFile(path.join(dir, 'orchestrator.md'), '---\nid: orchestrator\nkind: orchestrator\n---\n\nbody', 'utf8');
    await fs.writeFile(path.join(dir, 'functional.md'), '---\nid: functional\nkind: leaf\n---\n\nbody', 'utf8');
    expect((await store.list()).map((p) => p.meta.id)).toEqual(['orchestrator', 'functional', 'static']);
  });

  it('answers empty rather than throwing when there is no directory', async () => {
    expect(await new ProtocolStore(path.join(dir, 'gone')).list()).toEqual([]);
  });
});

/** The id becomes a filename, so it must not be able to climb out of the directory. */
describe('ids', () => {
  it('refuses anything that is not a plain name', () => {
    for (const bad of ['../etc/passwd', 'a/b', '.hidden', '', 'a.b']) expect(isSafeId(bad), bad).toBe(false);
    for (const ok of ['static', 'my-protocol', 'v2_draft']) expect(isSafeId(ok), ok).toBe(true);
  });

  it('does not read one through the store either', async () => {
    expect(await store.get('../../etc/passwd')).toBeNull();
  });
});

/**
 * A leaf protocol **is** a section: its id is the section id, its `requires` is what used to
 * be `depth: static | full`, and its `order` decides which section carries the run's headline.
 * Nothing else in the system holds a list of sections, so adding a file adds a section.
 */
describe('sections', () => {
  const leaf = (id: string, extra: string) =>
    `---\nid: ${id}\nname: ${id} rubric\nversion: 2\nkind: leaf\n${extra}---\n\nthe ${id} rubric\n`;

  it('are the leaf protocols, in declared order rather than alphabetical order', async () => {
    await fs.writeFile(path.join(dir, 'functional.md'), leaf('functional', 'order: 2\nrequires: [bench, browser]\n'), 'utf8');
    await fs.writeFile(path.join(dir, 'static.md'), leaf('static', 'order: 1\n'), 'utf8');
    await fs.writeFile(
      path.join(dir, 'orchestrator.md'),
      `---\nid: orchestrator\nname: o\nversion: 1\nkind: orchestrator\n---\n\ncomposes\n`,
      'utf8',
    );

    const sections = sectionsOf(await store.list());
    // Alphabetically `functional` comes first, which would silently move the headline verdict
    // onto it. The order is the protocol's to declare.
    expect(sections.map((s) => s.id)).toEqual(['static', 'functional']);
    expect(sections[1]?.requires).toEqual(['bench', 'browser']);
    expect(sections[0]?.requires).toEqual([]);
  });

  it('default to order 100, so an un-ordered file lands after the ordered ones', async () => {
    await fs.writeFile(path.join(dir, 'static.md'), leaf('static', 'order: 1\n'), 'utf8');
    await fs.writeFile(path.join(dir, 'appendix.md'), leaf('appendix', ''), 'utf8');
    expect(sectionsOf(await store.list()).map((s) => s.id)).toEqual(['static', 'appendix']);
  });

  /** `requires_bench` predates capabilities and meant a demo instance *and* a browser. */
  it('read the old requires_bench as both capabilities', async () => {
    await fs.writeFile(path.join(dir, 'static.md'), leaf('static', 'requires_bench: true\n'), 'utf8');
    expect(sectionsOf(await store.list())[0]?.requires).toEqual(['bench', 'browser']);
  });

  it('carry the phase plan, which is where the UI track and the prompt both come from', async () => {
    await fs.writeFile(
      path.join(dir, 'static.md'),
      leaf('static', 'phases:\n  - { id: A, label: session }\n  - { id: C }\n'),
      'utf8',
    );
    expect(sectionsOf(await store.list())[0]?.phases).toEqual([
      { id: 'A', label: 'session' },
      // No label declared: the id is the label rather than an empty pill.
      { id: 'C', label: 'C' },
    ]);
  });
});
