import type { ReactNode } from 'react';

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
