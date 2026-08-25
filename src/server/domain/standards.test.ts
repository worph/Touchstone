/**
 * `readStandards` answers two questions with one read, and the tests here are mostly about
 * keeping them apart: which rubric judged each section (the badge), and when the judging set
 * last moved (the scheduler). The second one has the sharper edges — a reading must not be
 * able to move the backlog, and a history that has not caught up must report no movement
 * rather than a guess.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProtocolStore } from '../store/protocols.js';
import { RevisionStore } from '../store/revisions.js';
import { readStandards } from './standards.js';

let dir: string;
let protocols: ProtocolStore;

const ORCHESTRATOR = `---
id: protocol
name: Conformance Protocol
kind: orchestrator
---

# Conformance Protocol

Compose the leaves below.
`;

const STATIC = `---
id: static
name: Static Review Protocol
kind: leaf
order: 10
---

# Static Review Protocol

Evaluate every statically verifiable item.
`;

const CURRENCY = `---
id: currency
name: Image Currency
kind: leaf
order: 90
scores: false
executor: currency.sh
---

# Image Currency

Measure how far behind each image tag is.
`;

const SCRIPT = '#!/bin/sh\necho \'{"requirements":[]}\'\n';

/** A clock that advances a second per call, so `at` is ordered and comparable. */
function ticker(): () => Date {
  let t = Date.parse('2026-08-23T09:00:00Z');
  return () => {
    t += 1000;
    return new Date(t);
  };
}

function revisionsFor(): RevisionStore {
  return new RevisionStore(dir, { now: ticker() });
}

async function write(file: string, body: string): Promise<void> {
  await fs.writeFile(path.join(dir, file), body, 'utf8');
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-standards-'));
  await write('protocol.md', ORCHESTRATOR);
  await write('static.md', STATIC);
  await write('currency.md', CURRENCY);
  await write('currency.sh', SCRIPT);
  protocols = new ProtocolStore(dir);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('the rubric in force, per section', () => {
  it('is the sha of the file that declared each section', async () => {
    const { sections } = await readStandards(protocols);
    const onDisk = await protocols.get('static');
    expect(sections.static?.sha256).toBe(onDisk?.sha256);
    expect(Object.keys(sections).sort()).toEqual(['currency', 'static']);
  });

  /** The procedure is half the standard for a section a script performs — invariant 9. */
  it('carries the executor hash for a scripted section, and nothing for an agent one', async () => {
    const { sections } = await readStandards(protocols);
    const script = await protocols.executor('currency.sh');
    expect(sections.currency?.executor_sha256).toBe(script?.sha256);
    expect(sections.static?.executor_sha256).toBeUndefined();
  });

  it('follows an edit without a restart', async () => {
    const before = (await readStandards(protocols)).sections.static?.sha256;
    await write('static.md', `${STATIC}\nOne more clause.\n`);
    expect((await readStandards(protocols)).sections.static?.sha256).not.toBe(before);
  });
});

describe('when the standard last moved', () => {
  it('is silent with no history to read', async () => {
    expect((await readStandards(protocols)).moved_at).toBeUndefined();
  });

  /**
   * A seed is the sweep learning what was already on the volume, not an edit. Counting it
   * would date the whole standard to the first boot after the history existed and put every
   * app in the archive into the backlog for something nobody did.
   */
  it('is silent when the history has only ever seen a seed', async () => {
    const revisions = revisionsFor();
    const seeded = await revisions.sweep();
    expect(seeded.every((r) => r.source === 'seed')).toBe(true);
    expect((await readStandards(protocols, revisions)).moved_at).toBeUndefined();
  });

  it('is the moment the current bytes were recorded', async () => {
    const revisions = revisionsFor();
    await revisions.sweep();
    await write('static.md', `${STATIC}\nOne more clause.\n`);
    const [edit] = await revisions.sweep();
    expect((await readStandards(protocols, revisions)).moved_at).toBe(edit!.at);
  });

  it('moves when a scoring rubric is edited', async () => {
    const revisions = revisionsFor();
    await revisions.sweep();
    await write('static.md', `${STATIC}\nOne more clause.\n`);
    await revisions.sweep();
    expect((await readStandards(protocols, revisions)).moved_at).toBeDefined();
  });

  /**
   * The orchestrator's prose is in the prompt, so its bytes judge every agent section — even
   * though no assay records its hash and therefore no badge can mention it.
   */
  it('moves when the orchestrator is edited', async () => {
    const revisions = revisionsFor();
    await revisions.sweep();
    await write('protocol.md', `${ORCHESTRATOR}\nAnd one more rule.\n`);
    await revisions.sweep();
    expect((await readStandards(protocols, revisions)).moved_at).toBeDefined();
  });

  /**
   * Invariant 12, third clause. A currency reading is a six-second script that rides every
   * audit; letting a threshold edit in it make the whole store eligible would spend days of
   * agent time re-measuring something that re-measures itself for free on the next run.
   */
  it('does not move for a section that measures rather than judges', async () => {
    const revisions = revisionsFor();
    await revisions.sweep();
    await write('currency.md', `${CURRENCY}\nA new threshold.\n`);
    await write('currency.sh', `${SCRIPT}# tweaked\n`);
    const edits = await revisions.sweep();
    expect(edits.map((r) => r.file).sort()).toEqual(['currency.md', 'currency.sh']);
    expect((await readStandards(protocols, revisions)).moved_at).toBeUndefined();
  });

  /**
   * Matching on the hash rather than on each file's newest entry is what makes a stale log
   * harmless: an edit nobody has recorded yet contributes nothing, so the answer is always a
   * moment that actually happened. It may therefore go *backwards* for as long as the sweep
   * has not caught up — which errs the safe way, since the only thing a later `moved_at` can
   * do is put subjects into the backlog.
   */
  it('never advances on an edit the sweep has not seen yet', async () => {
    const revisions = revisionsFor();
    await revisions.sweep();
    await write('static.md', `${STATIC}\nRecorded.\n`);
    await revisions.sweep();
    const before = (await readStandards(protocols, revisions)).moved_at!;

    await write('static.md', `${STATIC}\nUnrecorded.\n`);
    const after = (await readStandards(protocols, revisions)).moved_at;
    expect(after === undefined || after <= before).toBe(true);
    // …and once it is recorded, it moves.
    await revisions.sweep();
    expect((await readStandards(protocols, revisions)).moved_at! > before).toBe(true);
  });
});
