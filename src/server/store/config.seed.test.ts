/**
 * The seeded `config.yaml` must agree with the environment it was seeded in.
 *
 * `loadConfig` merges this file **over** the defaults, and the defaults are where every
 * `TOUCHSTONE_*` variable is read. So a template carrying literals does not merely duplicate
 * the defaults — it *overrides the environment*, permanently, from the first boot onward. On
 * the first real deployment that silently reverted three values a container had set: the agent
 * transport, the browser hostname, and the ledger callback. The first two failed loudly. The
 * third pointed at the SSO sidecar, so runs would have completed while every incremental
 * requirement record was answered with a login page.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureConfigFile, loadConfig } from './config.js';

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV = [
  'TOUCHSTONE_AGENT_URL',
  'TOUCHSTONE_AGENT_TOOL',
  'TOUCHSTONE_AGENT_VIA',
  'TOUCHSTONE_CALLBACK_URL',
  'TOUCHSTONE_BROWSER_URL',
  'TOUCHSTONE_POOL_URL',
  'TOUCHSTONE_BOARD_URL',
  'TOUCHSTONE_PUBLIC_BASE_URL',
];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-cfgseed-'));
  for (const k of ENV) saved[k] = process.env[k];
});

afterEach(async () => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await fs.rm(dir, { recursive: true, force: true });
});

describe('ensureConfigFile', () => {
  it('seeds the environment it was given, not a hardcoded default', async () => {
    process.env.TOUCHSTONE_AGENT_URL = 'http://beacon-backend:9300/mcp';
    process.env.TOUCHSTONE_AGENT_VIA = 'beacon';
    process.env.TOUCHSTONE_CALLBACK_URL = 'http://touchstone-backend:8080/api/v1/mcp';
    process.env.TOUCHSTONE_BROWSER_URL = 'http://touchstone-browser-1:9746/mcp';

    expect(await ensureConfigFile(dir)).toBe(path.join(dir, 'config.yaml'));
    const cfg = await loadConfig(dir);

    // Read back *through loadConfig*, which is the path that actually shadowed the env.
    expect(cfg.runner.agent_via).toBe('beacon');
    expect(cfg.runner.callback_url).toBe('http://touchstone-backend:8080/api/v1/mcp');
    expect(cfg.browsers[0]?.url).toBe('http://touchstone-browser-1:9746/mcp');
  });

  it('is inert — the file it writes reproduces the config that would exist without it', async () => {
    process.env.TOUCHSTONE_AGENT_VIA = 'beacon';
    process.env.TOUCHSTONE_BROWSER_URL = 'http://touchstone-browser-1:9746/mcp';

    // The claim the seeded file's own comments make: "every value below is the built-in
    // default, so deleting this file changes nothing".
    const withoutFile = await loadConfig(dir);
    await ensureConfigFile(dir);
    const withFile = await loadConfig(dir);

    for (const key of ['agent_url', 'agent_tool', 'agent_via', 'callback_url'] as const) {
      expect(withFile.runner[key], key).toEqual(withoutFile.runner[key]);
    }
    expect(withFile.browsers).toEqual(withoutFile.browsers);
    expect(withFile.bench.pool_url).toEqual(withoutFile.bench.pool_url);
    expect(withFile.origins).toEqual(withoutFile.origins);
    expect(withFile.notify.push_subject).toEqual(withoutFile.notify.push_subject);
  });

  it('still ships both switches off', async () => {
    await ensureConfigFile(dir);
    const cfg = await loadConfig(dir);
    expect(cfg.scheduler.armed).toBe(false);
    expect(cfg.runner.enabled).toBe(false);
  });

  it('never overwrites an existing file', async () => {
    await fs.writeFile(path.join(dir, 'config.yaml'), 'runner:\n  enabled: true\n', 'utf8');
    expect(await ensureConfigFile(dir)).toBeNull();
    expect((await loadConfig(dir)).runner.enabled).toBe(true);
  });

  it('keeps the comments — they are the interface', async () => {
    await ensureConfigFile(dir);
    const raw = await fs.readFile(path.join(dir, 'config.yaml'), 'utf8');
    expect(raw).toContain('Seeded on first boot');
    expect(raw).toContain('direct | beacon');
  });
});

/**
 * The blocks added for upload trials, held to the same rule as everything above.
 *
 * `trials.public_base_url` is the one that would fail quietly. Seed a literal for it and the
 * `TOUCHSTONE_PUBLIC_BASE_URL` a container sets is overridden from first boot onward — and the
 * symptom is not an error, it is every trial recording its functional section blocked, which
 * reads exactly like the documented "a trial cannot install" behaviour it replaced.
 */
describe('the blocks upload trials added', () => {
  it('seeds the environment it was given, not a literal', async () => {
    process.env.TOUCHSTONE_PUBLIC_BASE_URL = 'https://touchstone-lab.example';
    await ensureConfigFile(dir);

    const cfg = await loadConfig(dir);
    expect(cfg.trials.public_base_url).toBe('https://touchstone-lab.example');

    // And the file itself carries it, so an operator reading config.yaml sees the truth.
    const raw = await fs.readFile(path.join(dir, 'config.yaml'), 'utf8');
    expect(raw).toContain('https://touchstone-lab.example');
  });

  it('strips a trailing slash, so the built store URL never doubles one', async () => {
    process.env.TOUCHSTONE_PUBLIC_BASE_URL = 'https://touchstone-lab.example/';
    await ensureConfigFile(dir);
    expect((await loadConfig(dir)).trials.public_base_url).toBe('https://touchstone-lab.example');
  });

  it('is empty by default, which keeps trials static-only rather than half-configured', async () => {
    delete process.env.TOUCHSTONE_PUBLIC_BASE_URL;
    await ensureConfigFile(dir);
    expect((await loadConfig(dir)).trials.public_base_url).toBe('');
  });

  it('round-trips the upload caps through the seeded file', async () => {
    await ensureConfigFile(dir);
    const cfg = await loadConfig(dir);
    expect(cfg.uploads.max_file_bytes).toBeGreaterThan(0);
    expect(cfg.uploads.max_total_bytes).toBeGreaterThanOrEqual(cfg.uploads.max_file_bytes);
    expect(cfg.uploads.ttl_min).toBeGreaterThan(0);
    // A sibling of trials/, never inside it — a trial's own directory is scanned as reports.
    expect(cfg.uploadsRoot).toBe(path.join(dir, 'uploads'));
    expect(cfg.uploadsRoot.startsWith(cfg.trialsRoot)).toBe(false);
  });
});
