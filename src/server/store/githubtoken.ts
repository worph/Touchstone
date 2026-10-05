/**
 * The workshop's GitHub token, as set from the Settings page: `data/github-token`.
 *
 * It **overrides** what the process booted with (`github.token` in `config.yaml`, or
 * `TOUCHSTONE_GITHUB_TOKEN`), the same way `state/controls.json` overrides the config file:
 * deleting this one file puts the boot value back. Clearing it from the page does exactly that.
 *
 * Beside `config.yaml` rather than under `state/`, for the reason `context.md` is: everything
 * in `state/` is regenerable, and this is something a person typed. Written `0600`, and it is
 * **write-only** over HTTP — no route returns it, `redactConfig` never sees it because it is
 * not part of the config, and no chat or admin-MCP tool can set it (a token chosen by a
 * surface that authenticates nobody is a pull request under somebody else's name).
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

export const GITHUB_TOKEN_FILE = 'github-token';

/** GitHub tokens are well under this; a paste that is longer is something else. */
const MAX_TOKEN_CHARS = 512;

export class GitHubTokenInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubTokenInvalid';
  }
}

/** Trimmed, single-line, printable ASCII — or a refusal saying which of those it is not. */
export function normalizeToken(raw: unknown): string {
  if (typeof raw !== 'string') throw new GitHubTokenInvalid('token is required');
  const token = raw.trim();
  if (!token) throw new GitHubTokenInvalid('token is empty');
  if (token.length > MAX_TOKEN_CHARS) throw new GitHubTokenInvalid('that is too long to be a GitHub token');
  if (!/^[\x21-\x7e]+$/.test(token)) {
    throw new GitHubTokenInvalid('a GitHub token is one word of printable ASCII — no spaces or line breaks');
  }
  return token;
}

export class GitHubTokenStore {
  readonly path: string;

  constructor(dataDir: string) {
    this.path = path.join(dataDir, GITHUB_TOKEN_FILE);
  }

  /** The stored token and when it was set, or null when the page has never set one. */
  async read(): Promise<{ token: string; set_at: string } | null> {
    try {
      const token = (await fs.readFile(this.path, 'utf8')).trim();
      if (!token) return null;
      const stat = await fs.stat(this.path);
      return { token, set_at: stat.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  /** Atomic, and `0600` from the first byte — the temp file is created with the mode. */
  async write(token: string): Promise<void> {
    await fs.mkdir(path.dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp-${process.pid}-${++writeSeq}`;
    try {
      await fs.writeFile(tmp, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, this.path);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  async clear(): Promise<void> {
    await fs.rm(this.path, { force: true });
  }
}

let writeSeq = 0;
