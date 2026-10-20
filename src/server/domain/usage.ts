/**
 * Token usage, bucketed for the chart. Pure: rows in, a summary out.
 *
 * Every day in the window gets a bucket, including the empty ones, so the chart's x axis is
 * time rather than "days something happened" — a quiet weekend has to read as quiet.
 */

import {
  tokensIn,
  type UsageDay,
  type UsageRecord,
  type UsageSubject,
  type UsageSummary,
} from '../../shared/usage.js';

const DAY_MS = 86_400_000;

/** The costliest subjects the summary lists. */
export const TOP_SUBJECTS = 10;

export function summarizeUsage(rows: readonly UsageRecord[], days: number, now: Date): UsageSummary {
  const span = Math.max(1, Math.min(365, Math.floor(days)));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const first = today - (span - 1) * DAY_MS;

  const buckets = new Map<string, UsageDay>();
  for (let t = first; t <= today; t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    buckets.set(day, {
      day,
      calls: 0,
      input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      by_kind: {},
    });
  }

  const subjects = new Map<string, UsageSubject>();
  const totals = { calls: 0, in: 0, out: 0, cost_usd: 0 };
  let since: string | null = null;

  for (const r of rows) {
    if (typeof r?.at !== 'string') continue;
    if (since === null || r.at < since) since = r.at;
    const b = buckets.get(r.at.slice(0, 10));
    if (!b) continue;

    const tin = tokensIn(r);
    const cost = r.total_cost_usd ?? 0;
    b.calls += 1;
    b.input_tokens += r.input_tokens;
    b.cache_read_input_tokens += r.cache_read_input_tokens;
    b.cache_creation_input_tokens += r.cache_creation_input_tokens;
    b.output_tokens += r.output_tokens;
    b.cost_usd += cost;
    const k = (b.by_kind[r.kind] ??= { in: 0, out: 0 });
    k.in += tin;
    k.out += r.output_tokens;

    totals.calls += 1;
    totals.in += tin;
    totals.out += r.output_tokens;
    totals.cost_usd += cost;

    if (r.subject) {
      // By app name, not key: a trial's key carries its slug as the origin, and what an
      // operator wants here is what one app cost across audits, trials and the workshop.
      const name = r.subject.slice(r.subject.lastIndexOf('~') + 1);
      const s = subjects.get(name) ?? { subject: name, calls: 0, in: 0, out: 0, cost_usd: 0 };
      s.calls += 1;
      s.in += tin;
      s.out += r.output_tokens;
      s.cost_usd += cost;
      subjects.set(name, s);
    }
  }

  return {
    days: [...buckets.values()],
    subjects: [...subjects.values()]
      .sort((a, b) => b.in + b.out - (a.in + a.out))
      .slice(0, TOP_SUBJECTS),
    totals,
    since,
  };
}
