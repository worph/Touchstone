/**
 * Wish files — operator-authored, one per app, versioned by their bytes. A file that cannot be
 * used says why on its row rather than vanishing, because the operator wrote it and is waiting.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseWish, WishlistStore } from './wishlist.js';

describe('a wish file', () => {
  it('reads name, image, order and body', () => {
    const w = parseWish('---\nname: Immich\nimage: ghcr.io/immich-app/immich-server\norder: 5\n---\nPhotos.\n', 'immich.md');
    expect(w).toMatchObject({ file: 'immich.md', name: 'Immich', image: 'ghcr.io/immich-app/immich-server', order: 5, body: 'Photos.' });
    expect(w.problem).toBeUndefined();
    expect(w.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('says what is wrong instead of disappearing', () => {
    expect(parseWish('no frontmatter', 'a.md').problem).toContain('frontmatter');
    expect(parseWish('---\nname: ../x\nimage: y\n---\n', 'a.md').problem).toContain('not a usable app directory name');
    expect(parseWish('---\nname: X\n---\n', 'a.md').problem).toContain('image');
    expect(parseWish('---\n: : :\n---\n', 'a.md').problem).toBeTruthy();
  });

  it('a different byte is a different wish', () => {
    expect(parseWish('---\nname: X\nimage: y\n---\na', 'a.md').sha256).not.toBe(parseWish('---\nname: X\nimage: y\n---\nb', 'a.md').sha256);
  });

  it('skips examples and a missing directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-wish-'));
    expect(await new WishlistStore(path.join(dir, 'none')).list()).toEqual([]);
    await fs.writeFile(path.join(dir, '_example.md'), '---\nname: Ex\nimage: e\n---\n');
    await fs.writeFile(path.join(dir, 'b.md'), '---\nname: B\nimage: b\n---\n');
    await fs.writeFile(path.join(dir, 'a.md'), '---\nname: A\nimage: a\n---\n');
    const store = new WishlistStore(dir);
    expect((await store.list()).map((w) => w.name)).toEqual(['A', 'B']);
    expect(await store.get('../a.md')).toBeNull();
    await fs.rm(dir, { recursive: true, force: true });
  });
});
