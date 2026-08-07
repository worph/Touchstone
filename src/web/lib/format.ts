/** Age, not timestamp — `7d` is actionable, `2026-07-30` requires arithmetic. */

export function ageLabel(days: number | null | undefined): string {
  if (days == null) return '—';
  if (days <= 0) return 'today';
  return `${days}d`;
}

/** Finer-grained age from an ISO stamp, for the subject page. */
export function since(isoStr: string | null | undefined, now = Date.now()): string {
  if (!isoStr) return '—';
  const t = new Date(isoStr).getTime();
  if (!Number.isFinite(t)) return '—';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** `2d 4h` — a duration, as used by the environment banner. */
export function duration(fromIso: string | null | undefined, now = Date.now()): string {
  if (!fromIso) return '—';
  const t = new Date(fromIso).getTime();
  if (!Number.isFinite(t)) return '—';
  const mins = Math.max(0, Math.floor((now - t) / 60000));
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${mins % 60}m`;
  return `${mins}m`;
}

/** `2026-08-05 09:14` — used where the exact instant genuinely matters. */
export function stamp(isoStr: string | null | undefined): string {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return String(isoStr);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function dateOnly(isoStr: string | null | undefined): string {
  return isoStr ? String(isoStr).slice(0, 10) : '—';
}

/** 1 407 — thin spaces, so four-digit risk totals stay scannable. */
export function num(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** `2026-08-05T09-14-22Z-static.md` → `2026-08-05 09:14 · static` */
export function fileLabel(file: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z-(\w+)\.md$/.exec(file);
  if (!m) return file;
  return `${m[1]} ${m[2]}:${m[3]} · ${m[5]}`;
}
