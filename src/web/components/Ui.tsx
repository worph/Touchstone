import type { ReactNode } from 'react';
import type { FindingStatus, Severity } from '@shared/types';
import { SEVERITY_LABEL, SEVERITY_MARK } from '../lib/status';

/** Severity swatch: a coloured block *and* a letter. Never hue alone. */
export function SeverityChip({
  severity,
  status,
  label,
}: {
  severity: Severity;
  status?: FindingStatus;
  label?: string;
}) {
  if (status === 'unverified') {
    return (
      <span
        className="chip"
        data-tone="unverified"
        title={`Suspected ${SEVERITY_LABEL[severity]}, unproven — the check that would settle it could not run.`}
      >
        <span className="chip-mark" aria-hidden="true">
          ?
        </span>
        {label ?? `${SEVERITY_LABEL[severity]}?`}
      </span>
    );
  }
  if (status === 'pass' || severity === 'none') {
    return (
      <span className="chip" data-sev="none">
        <span className="chip-mark" aria-hidden="true">
          ✓
        </span>
        {label ?? 'pass'}
      </span>
    );
  }
  return (
    <span className="chip" data-sev={severity}>
      <span className="chip-mark" aria-hidden="true">
        {SEVERITY_MARK[severity]}
      </span>
      {label ?? SEVERITY_LABEL[severity]}
    </span>
  );
}

export function Loading({ what = 'data' }: { what?: string }) {
  return (
    <div className="loading">
      <span className="spinner" aria-hidden="true" />
      <span>Loading {what}…</span>
    </div>
  );
}

export function Notice({
  tone = 'info',
  glyph,
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warn' | 'error';
  glyph?: string;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <span className="notice-glyph" aria-hidden="true">
        {glyph ?? (tone === 'warn' ? '⚠' : tone === 'error' ? '⛔' : 'ℹ')}
      </span>
      <div className="notice-body">
        <div className="notice-title">{title}</div>
        {children ? <div className="notice-sub">{children}</div> : null}
      </div>
      {action ? <div style={{ flex: 'none' }}>{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, what }: { error: Error; what: string }) {
  return (
    <div className="page">
      <Notice tone="error" title={`Could not load ${what}`}>
        {error.message}
      </Notice>
    </div>
  );
}

export function EmptyState({
  glyph = '∅',
  title,
  sub,
  action,
}: {
  glyph?: string;
  title: string;
  sub?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-glyph" aria-hidden="true">
        {glyph}
      </div>
      <div className="empty-title">{title}</div>
      {sub ? <div className="empty-sub">{sub}</div> : null}
      {action}
    </div>
  );
}
