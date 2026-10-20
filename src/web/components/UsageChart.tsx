/**
 * Token usage — what the agent spent, per day, as it reported it.
 *
 * Two charts rather than one with two scales: a day reads ~10⁶ tokens in and ~10⁴ out, so on
 * a shared axis the output bars are invisible, and a second y-axis is the chart that lies.
 * Each is stacked by the kind of work, in a fixed colour order, with the same legend above
 * both. The colour is never alone: the tooltip names the kind and the table below says it in
 * words.
 *
 * History starts the day the agent began reporting usage (`since`); a day before that is not
 * a cheap day, it is a day nobody measured, and the note under the heading says so.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { USAGE_KINDS, type UsageDay, type UsageKind, type UsageSummary } from '@shared/usage';
import { getUsage } from '../data/client';
import { dateOnly, num, plural } from '../lib/format';

const RANGES = [7, 30, 90] as const;

const KIND_LABEL: Record<UsageKind, string> = {
  assay: 'Audits',
  trial: 'Trials',
  chat: 'Chat',
  workshop: 'Workshop',
};

/** Fixed order, never re-assigned by what is present — a kind keeps its colour. */
const KIND_COLOR: Record<UsageKind, string> = {
  assay: 'var(--series-1)',
  trial: 'var(--series-2)',
  chat: 'var(--series-3)',
  workshop: 'var(--series-4)',
};

/** 1.2M, 34k, 512 — axis and tile labels. */
function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

function usd(n: number): string {
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`;
}

/** A round axis top: 1, 2 or 5 × 10ⁿ at or above the max. */
function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

const H = 160;
const PAD_L = 44;
const PAD_B = 18;
const PAD_T = 6;

function Bars({
  title,
  days,
  pick,
  hover,
  setHover,
}: {
  title: string;
  days: UsageDay[];
  pick: 'in' | 'out';
  hover: number | null;
  setHover: (i: number | null) => void;
}) {
  // Drawn at the box's own pixel width, so an 11px label is 11px on a phone too — a scaled
  // viewBox shrank the axis to unreadable below ~400px.
  const box = useRef<HTMLElement>(null);
  const [W, setW] = useState(640);
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const totals = days.map((d) => USAGE_KINDS.reduce((n, k) => n + (d.by_kind[k]?.[pick] ?? 0), 0));
  const top = niceMax(Math.max(0, ...totals));
  const plotW = W - PAD_L;
  const plotH = H - PAD_B - PAD_T;
  const slot = plotW / Math.max(1, days.length);
  const barW = Math.max(2, Math.min(18, slot - 2));
  const y = (v: number) => PAD_T + plotH - (v / top) * plotH;
  // A date label needs ~44px; label every nth day so they never collide.
  const every = Math.max(1, Math.ceil(44 / slot));

  return (
    <figure className="usage-fig" ref={box}>
      <figcaption className="usage-fig-h">{title}</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} className="usage-svg" role="img" aria-label={`${title} per day`}
        onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={PAD_L} x2={W} y1={y(top * f)} y2={y(top * f)} className="usage-grid" />
            <text x={PAD_L - 6} y={y(top * f)} className="usage-axis" textAnchor="end" dominantBaseline="middle">
              {compact(top * f)}
            </text>
          </g>
        ))}
        {days.map((d, i) => {
          const x = PAD_L + i * slot + (slot - barW) / 2;
          let acc = 0;
          const segs = USAGE_KINDS.map((k) => {
            const v = d.by_kind[k]?.[pick] ?? 0;
            if (v <= 0) return null;
            const y0 = y(acc);
            acc += v;
            const y1 = y(acc);
            // A 2px surface gap between stacked segments; the top one keeps its full height.
            const h = Math.max(1, y0 - y1 - (acc < totals[i]! ? 2 : 0));
            return <rect key={k} x={x} y={y1} width={barW} height={h} fill={KIND_COLOR[k]} rx={acc === totals[i] ? 2 : 0} />;
          });
          return (
            <g key={d.day} className={hover === i ? 'usage-bar is-hover' : 'usage-bar'}>
              {segs}
              {i % every === 0 ? (
                <text x={x + barW / 2} y={H - 4} className="usage-axis" textAnchor="middle">
                  {d.day.slice(5)}
                </text>
              ) : null}
              {/* Hit target: the whole column, not the mark. */}
              <rect x={PAD_L + i * slot} y={PAD_T} width={slot} height={plotH} fill="transparent"
                onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} />
            </g>
          );
        })}
        <line x1={PAD_L} x2={W} y1={y(0)} y2={y(0)} className="usage-base" />
      </svg>
    </figure>
  );
}

export default function UsageChart() {
  const [days, setDays] = useState<number>(30);
  const [data, setData] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await getUsage(days));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [days]);

  useEffect(() => {
    void load();
  }, [load]);

  const present = useMemo(
    () => USAGE_KINDS.filter((k) => data?.days.some((d) => d.by_kind[k])),
    [data],
  );
  const tip = hover !== null ? data?.days[hover] : undefined;

  return (
    <section className="act-section">
      <h2 className="act-h">
        Token usage
        <span className="act-h-filters">
          <select className="control" value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Range">
            {RANGES.map((r) => (
              <option key={r} value={r}>last {r} days</option>
            ))}
          </select>
        </span>
      </h2>

      {error ? (
        <div className="act-quiet">Usage could not be read: {error}</div>
      ) : !data ? (
        <div className="act-quiet">Loading usage…</div>
      ) : data.since === null ? (
        <div className="act-quiet">
          No usage recorded yet. The agent reports it per call once its claude-code container
          runs <code>claude -p --output-format json</code>; calls made before that were not
          measured.
        </div>
      ) : (
        <div className="usage">
          <div className="usage-tiles">
            <div className="usage-tile"><span className="usage-tile-v">{compact(data.totals.in)}</span><span className="usage-tile-k">tokens in</span></div>
            <div className="usage-tile"><span className="usage-tile-v">{compact(data.totals.out)}</span><span className="usage-tile-k">tokens out</span></div>
            <div className="usage-tile"><span className="usage-tile-v">{num(data.totals.calls)}</span><span className="usage-tile-k">agent calls</span></div>
            <div className="usage-tile" title="At API list price. On a subscription login this is an estimate, not a bill.">
              <span className="usage-tile-v">{usd(data.totals.cost_usd)}</span><span className="usage-tile-k">list-price cost</span>
            </div>
          </div>

          <div className="usage-legend">
            {present.map((k) => (
              <span key={k} className="usage-key"><span className="usage-sw" style={{ background: KIND_COLOR[k] }} />{KIND_LABEL[k]}</span>
            ))}
            <span className="usage-note">
              In counts cache reads and writes. Measured since {dateOnly(data.since)}.
            </span>
          </div>

          <div className="usage-tip" aria-live="polite">
            {tip ? (
              <>
                <strong>{tip.day}</strong> · {plural(tip.calls, 'call')} ·{' '}
                {num(tip.input_tokens + tip.cache_read_input_tokens + tip.cache_creation_input_tokens)} in
                {' '}({compact(tip.cache_read_input_tokens)} cache read) · {num(tip.output_tokens)} out · {usd(tip.cost_usd)}
                {USAGE_KINDS.filter((k) => tip.by_kind[k]).map((k) => (
                  <span key={k}> · {KIND_LABEL[k]} {compact(tip.by_kind[k]!.in)}/{compact(tip.by_kind[k]!.out)}</span>
                ))}
              </>
            ) : (
              <span className="usage-note">Hover a day for its figures.</span>
            )}
          </div>

          <div className="usage-charts">
            <Bars title="Tokens in" days={data.days} pick="in" hover={hover} setHover={setHover} />
            <Bars title="Tokens out" days={data.days} pick="out" hover={hover} setHover={setHover} />
          </div>

          {data.subjects.length > 0 ? (
            <div className="usage-tbl-wrap">
            <table className="tbl usage-tbl">
              <thead>
                <tr>
                  <th>App</th>
                  <th className="col-num">Calls</th>
                  <th className="col-num">In</th>
                  <th className="col-num">Out</th>
                  <th className="col-num">Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.subjects.map((s) => (
                  <tr key={s.subject}>
                    <td>{s.subject}</td>
                    <td className="col-num">{num(s.calls)}</td>
                    <td className="col-num">{compact(s.in)}</td>
                    <td className="col-num">{compact(s.out)}</td>
                    <td className="col-num">{usd(s.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
