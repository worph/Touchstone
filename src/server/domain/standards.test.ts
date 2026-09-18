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

/**
 * A rubric audited on two platforms — the shape that catches the break the other fixtures
 * cannot see.
 *
 * `static.md` and `currency.md` are not target-scoped, so their section id equals their file id
 * and every lookup keyed on either one works. A target-scoped rubric expands into
 * `functional` and `functional@foss`, and a lookup keyed on the **section** id then misses the
 * file entirely — silently, because the miss is swallowed rather than raised.
 */
const FUNCTIONAL = `---
id: functional
name: Functional Review Protocol
kind: leaf
order: 20
requires: [bench, browser]
targets:
  - yundera
  - id: foss
    scores: false
---

# Functional Review Protocol

Install it and drive it.
`;

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
  await write('functional.md', FUNCTIONAL);
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
    expect(Object.keys(sections).sort()).toEqual([
      'currency',
      'functional',
      'functional@foss',
      'static',
    ]);
  });

  /**
   * One rubric, one revision, one chip. Both platforms are judged by the same bytes, so a
   * verdict reached on either goes `older` together when that file is edited — which is why
   * the expansions share a sha rather than each carrying their own.
   */
  it('gives every target of one rubric the same sha, because it is the same rubric', async () => {
    const { sections } = await readStandards(protocols);
    const onDisk = await protocols.get('functional');
    expect(sections.functional?.sha256).toBe(onDisk?.sha256);
    expect(sections['functional@foss']?.sha256).toBe(onDisk?.sha256);
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
   * **The one this file could not previously catch.** `resolve()` looks the rubric's file up to
   * decide what counts as judging, and it was keyed on the *section* id — fine for `static`,
   * where the two are equal, and a silent miss for `functional@foss`. The `if (file)` swallowed
   * it, so editing the functional rubric stopped re-eligibling anybody: no error, no failure,
   * a whole clause quietly inert.
   */
  it('moves when a target-scoped rubric is edited', async () => {
    const revisions = revisionsFor();
    await revisions.sweep();
    await write('functional.md', `${FUNCTIONAL}\nOne more clause.\n`);
    await revisions.sweep();

    const { moved_at, moved_at_by_line } = await readStandards(protocols, revisions);
    expect(moved_at).toBeDefined();
    expect(moved_at_by_line.yundera).toBeDefined();
  });

  /**
   * Invariant 12, reaching the target axis: a platform shipped **non-scoring** mints no line and
   * so has no backlog to re-eligible. Editing the shared rubric must not conjure one — the
   * whole point of shipping a platform measured-before-it-judges is that it costs no agent time
   * until somebody promotes it.
   *
   * The same bytes still move the *scoring* target's line, in the same edit, which is what
   * makes this a statement about `scores` rather than about the file.
   */
  it('does not move a line for a target that measures rather than judges', async () => {
    const revisions = revisionsFor();
    await revisions.sweep();
    await write('functional.md', `${FUNCTIONAL}\nOne more clause.\n`);
    await revisions.sweep();

    const { moved_at_by_line } = await readStandards(protocols, revisions);
    expect(moved_at_by_line.foss).toBeUndefined();
    expect(moved_at_by_line.yundera).toBeDefined();
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
