/**
 * `seed/protocols/currency.sh` — the shipped executor, run as the real artifact.
 *
 * A script is not unit-testable the way a pure function is, and that was the acknowledged
 * cost of putting the procedure on the volume rather than in the image. What replaces it is
 * this: a fixture on stdin, an assertion on stdout, running the same file the runner spawns.
 *
 * **Everything here is offline.** Every case is one the script settles before it would reach
 * a registry — digest pins, floating tags, a missing compose — so the suite neither needs the
 * network nor spends somebody's Docker Hub rate limit. The comparison itself is exercised
 * against live registries by hand; what is pinned here is the classification, which is where
 * a wrong answer would be silent.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { runScript, type ScriptOutput } from '../src/server/runner/exec.js';

// The tracked copy, not a volume's. `data/` is what one instance did and is gitignored, so a
// fresh clone has none — which is how this suite went red on CI while passing on a working
// tree that still had the pre-move directory lying around.
const SCRIPT = path.join(fileURLToPath(new URL('../', import.meta.url)), 'seed/protocols/currency.sh');

const POLICY = { platform_images: ['ghcr.io/yundera/appshield'], stale_days: 180, max_pages: 10, timeout: 5 };

async function run(compose: string, extra: Record<string, unknown> = {}): Promise<ScriptOutput> {
  const result = await runScript({
    path: SCRIPT,
    input: { subject: 'Fixture', repo: 'Example/Store', ref: 'main', apps_path: 'Apps', compose, policy: POLICY, ...extra },
    timeoutMs: 30_000,
  });
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail} ${result.stderr}`);
  return result.output;
}

const rowsOf = (out: ScriptOutput) => out.rows ?? [];

describe('currency.sh', () => {
  it('reads the service name and the image from an ordinary compose file', async () => {
    const out = await run(`name: fixture

services:
  app:
    image: "example/app@sha256:${'a'.repeat(64)}"
    container_name: app
    labels:
      caddy_0: app-\${APP_DOMAIN}
  db:
    image: 'example/db@sha256:${'b'.repeat(64)}'
`);
    expect(rowsOf(out).map((r) => r.service)).toEqual(['app', 'db']);
    expect(rowsOf(out).map((r) => r.image)).toEqual(['example/app', 'example/db']);
  });

  /** Nested keys are indented further than a service, and one of them is often `image`-ish. */
  it('does not mistake a nested key for a service', async () => {
    const out = await run(`services:
  app:
    image: example/app@sha256:${'c'.repeat(64)}
    depends_on:
      db:
        condition: service_healthy
    environment:
      SOMETHING: yes
`);
    expect(rowsOf(out)).toHaveLength(1);
    expect(rowsOf(out)[0]?.service).toBe('app');
  });

  it('skips an image that is a variable, having no version to read', async () => {
    const out = await run(`services:
  app:
    image: \${REGISTRY}/app:1.0.0
  other:
    image: example/other@sha256:${'d'.repeat(64)}
`);
    expect(rowsOf(out)).toHaveLength(1);
  });

  /** A digest names bytes, not a version. There is nothing to be behind. */
  it('reports a digest pin as unknown rather than as current', async () => {
    const out = await run(`services:
  app:
    image: example/app@sha256:${'e'.repeat(64)}
`);
    const row = rowsOf(out)[0]!;
    expect(row.state).toBe('unknown');
    expect(String(row.note)).toContain('digest');
    expect(out.badge_state).toBe('unknown');
    expect(out.badge).toBe('unknown');
  });

  it('reports `latest` and an absent tag as floating', async () => {
    const out = await run(`services:
  a:
    image: example/a:latest
  b:
    image: example/b
`);
    expect(rowsOf(out).map((r) => r.state)).toEqual(['floating', 'floating']);
    expect(rowsOf(out).map((r) => r.pinned)).toEqual(['latest', 'latest']);
  });

  it('reports a tag with no number at all as floating', async () => {
    const out = await run(`services:
  a:
    image: nginx:alpine
`);
    expect(rowsOf(out)[0]?.state).toBe('floating');
  });

  /**
   * The badge speaks for the app. A sidecar the platform ships is still measured and still
   * shown — an app store running an old AppShield is worth knowing about — but it is not the
   * app author's to fix, so it must not colour their row.
   */
  it('counts a platform image but does not let it colour the badge', async () => {
    const out = await run(`services:
  app:
    image: example/app@sha256:${'f'.repeat(64)}
  appshield:
    image: ghcr.io/yundera/appshield@sha256:${'0'.repeat(64)}
`);
    expect(rowsOf(out).map((r) => r.platform)).toEqual([false, true]);
  });

  it('blocks when the compose file cannot be read, rather than reporting an empty reading', async () => {
    const result = await runScript({
      path: SCRIPT,
      input: {
        subject: 'NoSuchApp',
        repo: 'Yundera/AppStore',
        ref: 'main',
        apps_path: 'Apps',
        compose: '',
        policy: { ...POLICY, timeout: 1 },
      },
      timeoutMs: 30_000,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output.status).toBe('blocked');
      expect(result.output.reason).toContain('docker-compose.yml');
    }
  }, 30_000);

  it('blocks when the compose has no image at all', async () => {
    const out = await run('services:\n  app:\n    build: .\n');
    expect(out.status).toBe('blocked');
    expect(String(out.reason)).toContain('no image');
  });

  it('declares the columns it wants drawn, and dates the age column', async () => {
    const out = await run(`services:\n  a:\n    image: example/a@sha256:${'1'.repeat(64)}\n`);
    expect(out.columns?.map((c) => c.key)).toContain('stale_since');
    expect(out.columns?.find((c) => c.key === 'stale_since')?.kind).toBe('since');
  });

  /** Invariant 6: the executor records; it never declares an outcome. */
  it('never emits a verdict, a severity or a score', async () => {
    const out = await run(`services:\n  a:\n    image: example/a@sha256:${'2'.repeat(64)}\n`);
    expect(out).not.toHaveProperty('verdict');
    expect(out).not.toHaveProperty('top_severity');
    expect(out).not.toHaveProperty('risk_score');
  });
});
