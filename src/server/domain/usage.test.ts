/**
 * Token usage: read back off the agent's answer, and bucketed by day for the chart. The
 * edges that matter are an agent that sends no usage (nothing recorded, not a zero) and a
 * window that has to show the quiet days too.
 */

import { describe, expect, it } from 'vitest';

import { extractUsage, postToAgent } from '../runner/agent.js';
import type { AgentUsage, UsageRecord } from '../../shared/usage.js';
import { summarizeUsage } from './usage.js';

const META = {
  input_tokens: 6,
  output_tokens: 147,
  cache_read_input_tokens: 62_143,
  cache_creation_input_tokens: 12_681,
  total_cost_usd: 0.1168,
  num_turns: 3,
  duration_ms: 4569,
  models: { 'claude-opus-5-5': { input_tokens: 6 } },
  is_error: false,
};

function answer(meta?: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text: 'done' }], ...(meta ? { _meta: { usage: meta } } : {}) },
  });
}

describe('extractUsage', () => {
  it('reads _meta.usage from a plain JSON answer', () => {
    expect(extractUsage(answer(META))).toEqual({
      input_tokens: 6,
      output_tokens: 147,
      cache_read_input_tokens: 62_143,
      cache_creation_input_tokens: 12_681,
      total_cost_usd: 0.1168,
      num_turns: 3,
      duration_ms: 4569,
      models: ['claude-opus-5-5'],
    });
  });

  it('reads it from an SSE-framed answer', () => {
    expect(extractUsage(`event: message\ndata: ${answer(META)}\n\n`)?.output_tokens).toBe(147);
  });

  it('is null for an agent that predates usage', () => {
    expect(extractUsage(answer())).toBeNull();
    expect(extractUsage('not json')).toBeNull();
  });
});

describe('postToAgent', () => {
  const fetchOf = (body: string) =>
    (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  it('hands the usage to onUsage with the caller’s tag', async () => {
    const seen: [AgentUsage, unknown][] = [];
    const raw = await postToAgent('p', {
      fetchImpl: fetchOf(answer(META)),
      onUsage: (u, tag) => seen.push([u, tag]),
      usageTag: { kind: 'trial', subject: 'yundera~FileBrowser' },
    });
    expect(raw.ok && raw.text).toBe('done');
    expect(seen).toHaveLength(1);
    expect(seen[0]![1]).toEqual({ kind: 'trial', subject: 'yundera~FileBrowser' });
  });

  it('does not let a throwing sink fail the call', async () => {
    const raw = await postToAgent('p', {
      fetchImpl: fetchOf(answer(META)),
      onUsage: () => {
        throw new Error('disk full');
      },
    });
    expect(raw.ok).toBe(true);
  });
});

describe('summarizeUsage', () => {
  const row = (at: string, over: Partial<UsageRecord> = {}): UsageRecord => ({
    at,
    kind: 'assay',
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 20,
    total_cost_usd: 0.5,
    num_turns: 1,
    duration_ms: 1,
    models: [],
    ...over,
  });

  it('buckets every day in the window, quiet ones included', () => {
    const s = summarizeUsage(
      [row('2026-10-18T10:00:00Z', { subject: 'yundera~a' }), row('2026-10-20T01:00:00Z', { kind: 'chat' })],
      3,
      new Date('2026-10-20T12:00:00Z'),
    );
    expect(s.days.map((d) => d.day)).toEqual(['2026-10-18', '2026-10-19', '2026-10-20']);
    expect(s.days[1]!.calls).toBe(0);
    expect(s.days[0]!.by_kind.assay).toEqual({ in: 130, out: 5 });
    expect(s.days[2]!.by_kind.chat).toEqual({ in: 130, out: 5 });
    expect(s.totals).toEqual({ calls: 2, in: 260, out: 10, cost_usd: 1 });
    expect(s.subjects).toEqual([{ subject: 'a', calls: 1, in: 130, out: 5, cost_usd: 0.5 }]);
    expect(s.since).toBe('2026-10-18T10:00:00Z');
  });

  it('leaves rows outside the window out of the totals but not out of `since`', () => {
    const s = summarizeUsage([row('2026-09-01T00:00:00Z')], 7, new Date('2026-10-20T12:00:00Z'));
    expect(s.totals.calls).toBe(0);
    expect(s.since).toBe('2026-09-01T00:00:00Z');
  });
});
