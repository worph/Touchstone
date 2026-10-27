import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import YAML from 'yaml';

import { ConfigFile } from './configfile.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-configfile-'));
  file = path.join(dir, 'config.yaml');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const SEEDED = `# Touchstone configuration
scheduler:
  armed: false   # flip on once the benches are healthy
  tick_min: 5
workshop:
  # armed: false
  # auto_submit: false
notify:
  url: "https://example.com/${'x'.repeat(120)}"
`;

describe('ConfigFile', () => {
  it('changes one key and leaves every comment and other key where it was', async () => {
    await fs.writeFile(file, SEEDED);
    await new ConfigFile({ file }).set('scheduler.armed', true);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).toContain('# Touchstone configuration');
    expect(raw).toContain('# flip on once the benches are healthy');
    // Not folded: a long line stays one line.
    expect(raw).toContain(`"https://example.com/${'x'.repeat(120)}"`);
    expect(YAML.parse(raw).scheduler).toEqual({ armed: true, tick_min: 5 });
  });

  it('writes into a block that holds only comments, keeping them', async () => {
    await fs.writeFile(file, SEEDED);
    await new ConfigFile({ file }).set('workshop.auto_submit', true);
    const raw = await fs.readFile(file, 'utf8');
    expect(raw).toContain('# armed: false');
    expect(YAML.parse(raw).workshop).toEqual({ auto_submit: true });
  });

  it('creates the file, and a block that is not there', async () => {
    await new ConfigFile({ file }).set('bench.min_remaining_min', 90);
    expect(YAML.parse(await fs.readFile(file, 'utf8'))).toEqual({ bench: { min_remaining_min: 90 } });
  });

  it('removes a key, and updates the live config to the built-in default', async () => {
    await fs.writeFile(file, SEEDED);
    const live = { scheduler: { armed: false, tick_min: 5 } };
    const cfg = new ConfigFile({ file, live, builtin: { scheduler: { armed: false, tick_min: 60 } } });
    await cfg.set('scheduler.armed', true);
    expect(live.scheduler.armed).toBe(true);
    await cfg.set('scheduler.tick_min', undefined);
    expect(live.scheduler.tick_min).toBe(60);
    expect(YAML.parse(await fs.readFile(file, 'utf8')).scheduler).toEqual({ armed: true });
    expect(cfg.builtin('scheduler.tick_min')).toBe(60);
  });

  it('runs writes one after another, so none is lost', async () => {
    await fs.writeFile(file, SEEDED);
    const cfg = new ConfigFile({ file });
    await Promise.all([
      cfg.set('scheduler.armed', true),
      cfg.set('scheduler.fresh_days', 14),
      cfg.set('workshop.armed', true),
      cfg.set('runner.busy_backoff_min', 3),
    ]);
    expect(YAML.parse(await fs.readFile(file, 'utf8'))).toMatchObject({
      scheduler: { armed: true, tick_min: 5, fresh_days: 14 },
      workshop: { armed: true },
      runner: { busy_backoff_min: 3 },
    });
  });

  it('refuses to rewrite a file it cannot parse, and keeps working after', async () => {
    await fs.writeFile(file, 'scheduler: [unclosed\n');
    const cfg = new ConfigFile({ file });
    await expect(cfg.set('scheduler.armed', true)).rejects.toThrow(/does not parse/);
    expect(await fs.readFile(file, 'utf8')).toBe('scheduler: [unclosed\n');
    await fs.writeFile(file, SEEDED);
    await cfg.set('scheduler.armed', true);
    expect(YAML.parse(await fs.readFile(file, 'utf8')).scheduler.armed).toBe(true);
  });
});
