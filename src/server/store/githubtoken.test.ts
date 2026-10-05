import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GitHubTokenInvalid, GitHubTokenStore, normalizeToken } from './githubtoken.js';

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-ghtoken-'));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the stored GitHub token', () => {
  it('is absent until set, owner-only once written, and gone once cleared', async () => {
    const tokens = new GitHubTokenStore(dir);
    expect(await tokens.read()).toBeNull();
    await tokens.write('github_pat_abc');
    expect((await tokens.read())?.token).toBe('github_pat_abc');
    expect((await fs.stat(tokens.path)).mode & 0o777).toBe(0o600);
    await tokens.clear();
    expect(await tokens.read()).toBeNull();
    await tokens.clear();
  });

  it('accepts one word of printable ASCII, trimmed, and refuses anything else', () => {
    expect(normalizeToken('  ghp_x \n')).toBe('ghp_x');
    for (const bad of [undefined, 42, '', '   ', 'ghp x', 'ghp\nx', 'ghp_é', 'x'.repeat(600)]) {
      expect(() => normalizeToken(bad)).toThrow(GitHubTokenInvalid);
    }
  });
});
