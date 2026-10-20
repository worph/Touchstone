/**
 * The token-usage log: `state/usage.jsonl`, one row per agent call that reported its usage.
 *
 * Append-only for the same reason `events.jsonl` is — concurrent runs interleave whole lines
 * and a torn tail costs one row. It is regenerable in the weak sense everything under
 * `state/` is: losing it loses a chart, never a verdict.
 *
 * Kept apart from `events.jsonl` on purpose. The event log is trimmed to a cap and read
 * newest-first for the Activity page; a chart over thirty days wants every row in the window
 * and nothing else, and one audit's usage row would otherwise be one more line an operator
 * scrolls past.
 */

import path from 'node:path';
import type { AgentUsage, UsageKind, UsageRecord, UsageSummary } from '../../shared/usage.js';
import { summarizeUsage } from '../domain/usage.js';
import { appendJsonl, readJsonl } from './state.js';

export const USAGE_FILE = 'usage.jsonl';

export class UsageLog {
  readonly file: string;

  constructor(
    stateDir: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.file = path.join(stateDir, USAGE_FILE);
  }

  /** Fire-and-forget: a full disk must not fail the audit whose cost it was recording. */
  record(usage: AgentUsage, tag: { kind: UsageKind; subject?: string }): void {
    const row: UsageRecord = {
      at: this.now().toISOString(),
      kind: tag.kind,
      ...(tag.subject ? { subject: tag.subject } : {}),
      ...usage,
    };
    void appendJsonl(this.file, row).catch(() => {});
  }

  async summary(days: number): Promise<UsageSummary> {
    const rows = await readJsonl<UsageRecord>(this.file);
    return summarizeUsage(rows, days, this.now());
  }
}
