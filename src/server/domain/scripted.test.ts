import { describe, expect, it } from 'vitest';

import { assayFromScript, renderRows } from './scripted.js';
import type { AssaySection } from './assay.js';
import type { ScriptRun } from '../runner/exec.js';

const section: AssaySection = {
  id: 'currency',
  name: 'Image Currency',
  standard: { name: 'Image Currency', version: 3 },
  phases: [],
  headings: [],
};

const executor = { file: 'currency.sh', path: '/p/currency.sh', sha256: 'a'.repeat(64) };

const base = {
  subject: 'FileBrowser',
  origin: 'yundera',
  section,
  executor,
  startedAt: '2026-08-22T10:00:00Z',
  finishedAt: '2026-08-22T10:00:06Z',
  subjectRef: 'Yundera/AppStore@main:Apps/FileBrowser',
};

const done = (output: Record<string, unknown>): ScriptRun =>
  ({ ok: true, output: { status: 'done', ...output }, stderr: '', ms: 12 }) as ScriptRun;

describe('assayFromScript', () => {
  it('records the executor and the hash of what actually ran', () => {
    const { meta } = assayFromScript({ ...base, scores: false, run: done({ badge: 'current' }) });
    expect(meta.executor).toBe('currency.sh');
    expect(meta.executor_sha256).toBe('a'.repeat(64));
    expect(meta.standard_version).toBe(3);
  });

  /**
   * The whole reason `scores: false` exists. An image being 400 days behind is a fact about
   * the world, not a finding against the app, and a `non-compliant` here would be exactly the
   * conflation the flag prevents.
   */
  it('states no verdict for a section that measures', () => {
    const { meta } = assayFromScript({
      ...base,
      scores: false,
      run: done({ badge: '2 behind · 400d', badge_state: 'bad' }),
    });
    expect(meta.status).toBe('done');
    expect(meta.verdict).toBeNull();
    expect(meta.top_severity).toBe('none');
    expect(meta.risk_score).toBe(0);
    expect(meta.scores).toBe(false);
    expect(meta.badge).toBe('2 behind · 400d');
  });

  it('omits `scores` when the section does count, so the archive reads unchanged', () => {
    const { meta } = assayFromScript({ ...base, scores: true, run: done({}) });
    expect(meta.scores).toBeUndefined();
  });

  /** Touchstone computes the gate. The script records items; it never declares an outcome. */
  it('computes the verdict from the recorded requirements for a scoring section', () => {
    const { meta } = assayFromScript({
      ...base,
      scores: true,
      run: done({
        requirements: [
          { id: 'a', verdict: 'pass' },
          { id: 'b', verdict: 'fail', severity: 'critical' },
        ],
      }),
    });
    expect(meta.verdict).toBe('non-compliant');
    expect(meta.top_severity).toBe('critical');
    expect(meta.risk_score).toBe(100);
    expect(meta.coverage?.failed).toBe(1);
  });

  it('is compliant when a scoring section recorded no failure', () => {
    const { meta } = assayFromScript({
      ...base,
      scores: true,
      run: done({ requirements: [{ id: 'a', verdict: 'pass' }] }),
    });
    expect(meta.verdict).toBe('compliant');
  });

  /** Invariant 4, one layer out: a registry we could not read says nothing about the app. */
  it('records a script-declared blockage as blocked, not as a reading', () => {
    const { meta, body } = assayFromScript({
      ...base,
      scores: false,
      run: {
        ok: true,
        output: { status: 'blocked', reason: 'docker hub answered 429' },
        stderr: '',
        ms: 3,
      },
    });
    expect(meta.status).toBe('blocked');
    expect(meta.verdict).toBeNull();
    expect(meta.blocked_reason).toBe('executor_blocked');
    expect(meta.blocked_detail).toContain('429');
    expect(meta.badge_state).toBe('unknown');
    expect(body).toContain('not the same as "current"');
  });

  it('records a broken executor as blocked and keeps its stderr', () => {
    const { meta, body } = assayFromScript({
      ...base,
      scores: false,
      run: { ok: false, reason: 'exit', detail: 'exit 3', stderr: 'jq: not found', ms: 4 },
    });
    expect(meta.status).toBe('blocked');
    expect(meta.blocked_reason).toBe('executor_exit');
    expect(body).toContain('jq: not found');
  });

  it('puts the reading in the body when the script supplied no prose', () => {
    const { body } = assayFromScript({
      ...base,
      scores: false,
      run: done({
        summary: 'One image is behind.',
        columns: [{ key: 'image', label: 'Image' }],
        rows: [{ image: 'caddy' }],
      }),
    });
    expect(body).toContain('One image is behind.');
    expect(body).toContain('| Image |');
    expect(body).toContain('| caddy |');
  });
});

describe('renderRows', () => {
  it('falls back to the union of row keys when no columns were declared', () => {
    const md = renderRows({ rows: [{ a: 1 }, { b: 2 }] });
    expect(md).toContain('| a | b |');
  });

  it('keeps an absolute date in a `since` column — a file is read long after it is written', () => {
    const md = renderRows({
      columns: [{ key: 'when', label: 'Since', kind: 'since' }],
      rows: [{ when: '2025-07-18T04:11:00Z' }],
    });
    expect(md).toContain('| 2025-07-18 |');
  });

  it('escapes a pipe so one cell cannot forge a column', () => {
    const md = renderRows({ columns: [{ key: 'x' }], rows: [{ x: 'a|b' }] });
    expect(md).toContain('a\\|b');
  });

  it('renders an empty value as an em dash rather than as nothing', () => {
    const md = renderRows({ columns: [{ key: 'x' }], rows: [{ x: null }] });
    expect(md).toContain('| — |');
  });
});
