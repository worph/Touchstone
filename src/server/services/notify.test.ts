/**
 * What leaves the building, and what it says when it gets there.
 *
 * Two things are worth holding still. **Which codes push** — because the operator asked for
 * a review and walked away, and a routing table that covers only the happy path makes
 * silence ambiguous. And **what the push says** — because `event.message` is deliberately
 * id-free ("An audit finished"), which is right for a log column and useless on a lock
 * screen.
 */

import { describe, expect, it } from 'vitest';

import { pushBodyFor, routeFor } from './notify.js';
import type { EventRecord } from '../../shared/activity.js';

function event(over: Partial<EventRecord>): EventRecord {
  return {
    seq: 1,
    at: '2026-08-20T09:33:27.000Z',
    level: 'info',
    code: 'ASSAY_COMPLETED',
    category: 'assay',
    message: 'An audit finished',
    ...over,
  } as EventRecord;
}

describe('routing', () => {
  /** Every way an audit can end reaches the phone. Silence must mean "still running". */
  it.each(['ASSAY_COMPLETED', 'ASSAY_FAILED', 'ASSAY_BLOCKED', 'AGENT_UNAUTHENTICATED'])(
    'pushes %s',
    (code) => {
      expect(routeFor(code).push).toBe(true);
    },
  );

  /** A tick that decided nothing is not news, and a notifier people mute is not a notifier. */
  it('does not push routine scheduler noise', () => {
    expect(routeFor('TICK_IDLE').push).toBe(false);
    expect(routeFor('TICK_SELECTED').push).toBe(false);
  });
});

describe('what the push says', () => {
  it('names the subject and the verdict, which the log line deliberately does not', () => {
    const body = pushBodyFor(
      event({ subject: 'FileBrowser', detail: { subject: 'FileBrowser', verdict: 'non-compliant', risk: 13 } }),
    );
    expect(body).toBe('FileBrowser — non-compliant · risk 13');
  });

  /**
   * The difference between "this app is fine" and "half of it was never checked" has to
   * survive into the two lines somebody actually reads.
   */
  it('says when only half the audit ran', () => {
    const body = pushBodyFor(
      event({
        subject: 'FileBrowser',
        message: 'An audit finished, but its functional half could not run',
        detail: {
          subject: 'FileBrowser',
          verdict: 'non-compliant',
          risk: 12,
          legs: ['static', 'functional'],
          blocked: 'bench_unavailable',
        },
      }),
    );
    expect(body).toBe('FileBrowser — non-compliant · risk 12 · functional leg blocked (no usable demo bench)');
  });

  it('turns a blocked start into a reason a person can read', () => {
    const body = pushBodyFor(
      event({
        code: 'ASSAY_BLOCKED',
        level: 'warn',
        subject: 'Ntfy',
        detail: { subject: 'Ntfy', reason: 'browser_unavailable' },
      }),
    );
    expect(body).toBe('Ntfy — could not start: no browser was answering');
  });

  it('keeps a failure short enough to read on a lock screen', () => {
    const body = pushBodyFor(
      event({
        code: 'ASSAY_FAILED',
        level: 'error',
        subject: 'Ntfy',
        detail: { subject: 'Ntfy', error: 'x'.repeat(400) },
      }),
    );
    expect(body.length).toBeLessThan(160);
    expect(body).toContain('Ntfy — the audit failed:');
  });

  /** Anything without a formatter falls back to the log sentence, which is always safe. */
  it('falls back to the event sentence', () => {
    expect(pushBodyFor(event({ code: 'BENCH_POOL_DOWN', message: 'No demo bench is usable' }))).toBe(
      'No demo bench is usable',
    );
  });
});
