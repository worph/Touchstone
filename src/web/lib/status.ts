/**
 * Deriving what to *show* from an AssayRecord.
 *
 * The one rule this file exists to enforce: `blocked` and `errored` and
 * `not yet run` are three different unknowns, and none of them is a failure.
 * Nothing outside this module decides what an assay looks like.
 */
import type { AssayRecord, Finding, Severity } from '@shared/types';
import { SEVERITY_RANK } from '@shared/types';
import type { DisplayState } from '../types';

export const SEVERITY_LABEL: Record<Severity, string> = {
  none: 'none',
  minor: 'Minor',
  major: 'Major',
  critical: 'Critical',
};

/** The mark inside a severity swatch. Letters, not hues. */
export const SEVERITY_MARK: Record<Severity, string> = {
  none: '✓',
  minor: 'm',
  major: 'M',
  critical: 'C',
};

export const SEVERITY_ORDER: Severity[] = ['critical', 'major', 'minor', 'none'];

export function worse(a: Severity, b: Severity): boolean {
  return SEVERITY_RANK[a] > SEVERITY_RANK[b];
}

/** `bench_unavailable` reads badly in a sentence; `bench unavailable` does not. */
export function humaniseReason(reason: string | null | undefined): string | undefined {
  if (!reason) return undefined;
  return reason.replace(/[_-]+/g, ' ').trim();
}

const NOT_RUN: DisplayState = {
  kind: 'none',
  severity: 'none',
  label: 'not yet run',
  mark: '',
  hint: 'No assay of this leg has ever been recorded for this subject.',
};

/**
 * @param rec  the latest assay for one leg, or null if the leg was never assayed
 * @param now  injected so the `running · 4m` label is testable
 */
export function displayState(rec: AssayRecord | null | undefined, now = Date.now()): DisplayState {
  if (!rec) return NOT_RUN;
  const m = rec.meta;

  if (m.status === 'running') {
    return {
      kind: 'running',
      severity: 'none',
      label: 'running',
      mark: '◴',
      note: elapsed(m.started_at, now),
      hint: `Started ${m.started_at}. This leg is in flight; the previous hallmark still stands.`,
    };
  }

  if (m.status === 'blocked') {
    const reason = humaniseReason(m.blocked_reason);
    return {
      kind: 'blocked',
      severity: 'none',
      label: 'blocked',
      mark: '',
      note: reason,
      hint:
        `Infrastructure prevented this assay${reason ? ` (${reason})` : ''}. ` +
        'It is not a statement about the subject, and it consumed no retry budget.',
    };
  }

  switch (m.verdict) {
    case 'compliant':
      return {
        kind: 'ok',
        severity: 'none',
        label: 'compliant',
        mark: '✓',
        hint: `Assayed under ${m.standard} v${m.standard_version} and clean.`,
      };
    case 'non-compliant':
      return {
        kind: 'fail',
        severity: m.top_severity,
        label: SEVERITY_LABEL[m.top_severity],
        mark: SEVERITY_MARK[m.top_severity],
        note: m.risk_score ? `risk ${m.risk_score}` : undefined,
        hint: `Checked and failing. Top severity ${SEVERITY_LABEL[m.top_severity]}, risk ${m.risk_score}.`,
      };
    case 'errored':
      return {
        kind: 'errored',
        severity: 'none',
        label: 'errored',
        mark: '!',
        hint: 'The assay itself failed to complete. No verdict was reached about the subject.',
      };
    case 'deferred':
      return {
        kind: 'deferred',
        severity: 'none',
        label: 'deferred',
        mark: '⏸',
        hint: 'Deliberately postponed.',
      };
    default:
      return {
        kind: 'none',
        severity: 'none',
        label: 'no verdict',
        mark: '',
        hint: 'The assay completed without recording a verdict.',
      };
  }
}

/** The same derivation for a single finding row. */
export function findingState(f: Finding): DisplayState {
  switch (f.status) {
    case 'pass':
      return { kind: 'ok', severity: 'none', label: 'pass', mark: '✓' };
    case 'fail':
      return {
        kind: 'fail',
        severity: f.severity,
        label: SEVERITY_LABEL[f.severity],
        mark: SEVERITY_MARK[f.severity],
      };
    case 'unverified':
      return {
        kind: 'unverified',
        severity: f.severity,
        label: 'unverified',
        mark: '?',
        note: `suspected ${SEVERITY_LABEL[f.severity]}`,
        hint:
          `Suspected ${SEVERITY_LABEL[f.severity]}, unproven — the check that would settle it ` +
          'could not run. Counted as potential risk, never as observed risk.',
      };
    case 'advisory':
      return { kind: 'deferred', severity: f.severity, label: 'advisory', mark: 'i' };
    case 'n-a':
    default:
      return { kind: 'none', severity: 'none', label: 'n/a', mark: '' };
  }
}

/** A finding contributes to observed risk only when it was actually observed. */
export function isFailing(f: Finding): boolean {
  return f.status === 'fail';
}
export function isPotential(f: Finding): boolean {
  return f.status === 'unverified';
}

function elapsed(from: string, now: number): string {
  const ms = now - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}
