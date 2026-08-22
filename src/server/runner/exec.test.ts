import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseOutput, runScript } from './exec.js';

let dir: string;

async function script(name: string, body: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.writeFile(file, body, { encoding: 'utf8', mode: 0o755 });
  return file;
}

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exec-test-'));
});
afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('runScript', () => {
  it('hands the input over on stdin and parses one JSON object back', async () => {
    const file = await script(
      'echo.sh',
      `#!/bin/sh\nread -r line\nprintf '{"status":"done","badge":"%s"}\\n' "$(printf '%s' "$line" | sed 's/.*"subject":"\\([^"]*\\)".*/\\1/')"\n`,
    );
    const run = await runScript({ path: file, input: { subject: 'FileBrowser' } });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.output.badge).toBe('FileBrowser');
  });

  /**
   * The reason input travels on stdin at all. Subject names come from a GitHub directory
   * listing, so this is a name a stranger can create by opening a pull request.
   */
  it('cannot be injected through the subject name', async () => {
    const canary = path.join(dir, 'canary');
    const file = await script('sink.sh', `#!/bin/sh\ncat > /dev/null\necho '{"status":"done"}'\n`);
    const run = await runScript({
      path: file,
      input: { subject: `x"; touch ${canary}; echo "` },
    });
    expect(run.ok).toBe(true);
    await expect(fs.access(canary)).rejects.toThrow();
  });

  it('reports a non-zero exit as the executor being broken, not as a reading', async () => {
    const file = await script('boom.sh', '#!/bin/sh\ncat > /dev/null\necho oops >&2\nexit 3\n');
    const run = await runScript({ path: file, input: {} });
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.reason).toBe('exit');
      expect(run.stderr).toContain('oops');
    }
  });

  it('reports unparseable output rather than guessing at it', async () => {
    const file = await script('junk.sh', '#!/bin/sh\ncat > /dev/null\necho "not json"\n');
    const run = await runScript({ path: file, input: {} });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toBe('parse');
  });

  /** The runner is single-flight: a script that hangs would park the whole loop behind it. */
  it('stops a script that does not answer', async () => {
    const file = await script('hang.sh', '#!/bin/sh\ncat > /dev/null\nsleep 30\n');
    const run = await runScript({ path: file, input: {}, timeoutMs: 300 });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toBe('timeout');
  }, 10_000);

  it('refuses output too large to be an assay record', async () => {
    const file = await script('flood.sh', '#!/bin/sh\ncat > /dev/null\nyes 0123456789abcdef | head -n 20000\n');
    const run = await runScript({ path: file, input: {}, maxStdoutBytes: 4096 });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.reason).toBe('oversize');
  }, 10_000);

  /**
   * A check is handed enough to make an HTTPS request and nothing else. Inheriting the process
   * environment would give every script the push keys and the bench credentials.
   */
  it('does not pass the process environment through', async () => {
    process.env.TOUCHSTONE_TEST_SECRET = 'do-not-leak';
    const file = await script('env.sh', `#!/bin/sh\ncat > /dev/null\nprintf '{"status":"done","badge":"%s"}\\n' "\${TOUCHSTONE_TEST_SECRET:-absent}"\n`);
    const run = await runScript({ path: file, input: {} });
    delete process.env.TOUCHSTONE_TEST_SECRET;
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.output.badge).toBe('absent');
  });
});

describe('parseOutput', () => {
  it('defaults an absent status to done', () => {
    const r = parseOutput('{"badge":"current"}');
    expect(r.ok && r.output.status).toBe('done');
  });

  /**
   * The output lands in frontmatter, which is the archive of record. A check that could write
   * arbitrary keys there could write `verdict`, which is the one thing no executor may set.
   */
  it('drops every key that is not in the contract', () => {
    const r = parseOutput('{"status":"done","verdict":"compliant","risk_score":999,"top_severity":"none"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output).not.toHaveProperty('verdict');
      expect(r.output).not.toHaveProperty('risk_score');
      expect(r.output).not.toHaveProperty('top_severity');
    }
  });

  it('keeps rows, columns and the since hint', () => {
    const r = parseOutput(
      '{"status":"done","columns":[{"key":"a","label":"A","align":"right","kind":"since"}],"rows":[{"a":"2026-01-01","b":2,"c":null}]}',
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.output.columns).toEqual([{ key: 'a', label: 'A', align: 'right', kind: 'since' }]);
      expect(r.output.rows).toEqual([{ a: '2026-01-01', b: 2, c: null }]);
    }
  });

  it('refuses a requirement whose verdict is not one of the four', () => {
    const r = parseOutput('{"status":"done","requirements":[{"id":"x","verdict":"flagged"}]}');
    expect(r.ok && r.output.requirements).toBeUndefined();
  });

  it('rejects an unknown status rather than treating it as done', () => {
    expect(parseOutput('{"status":"probably"}').ok).toBe(false);
  });

  it('rejects an empty answer', () => {
    expect(parseOutput('').ok).toBe(false);
  });
});
