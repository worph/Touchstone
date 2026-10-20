/**
 * Token usage — what each agent call cost, as the agent reported it.
 *
 * The claude-code MCP server runs `claude -p --output-format json` and hands the run's usage
 * back in the tool result's `_meta.usage`, beside the text it always returned. An agent that
 * predates that change sends no `_meta`, and nothing is recorded: a call with no usage is an
 * absent row, never a zero, because a zero would draw as a cheap day.
 *
 * It is **observation, not judgement**. Nothing here reaches a hallmark, the scheduler or a
 * retry budget; the only reader is the chart on the Status page.
 */

/** What kind of work spent the tokens. One agent endpoint serves all four. */
export type UsageKind = 'assay' | 'trial' | 'chat' | 'workshop';

export const USAGE_KINDS: readonly UsageKind[] = ['assay', 'trial', 'chat', 'workshop'];

/** The agent's own figures for one call, summed over every model the run used. */
export interface AgentUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /**
   * What the API would charge at list price. On a subscription login this is an estimate,
   * not a bill — the token counts are exact either way.
   */
  total_cost_usd: number | null;
  num_turns: number | null;
  duration_ms: number | null;
  models: string[];
}

/** One row of `state/usage.jsonl`. */
export interface UsageRecord extends AgentUsage {
  at: string;
  kind: UsageKind;
  /** The subject key for an assay or a trial; absent for chat and workshop calls with none. */
  subject?: string;
}

/** Tokens in: everything the model read, fresh or from cache. */
export function tokensIn(u: Pick<AgentUsage, 'input_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'>): number {
  return u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
}

export interface UsageDay {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  calls: number;
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** Tokens in and out per kind, for the split under the chart. */
  by_kind: Partial<Record<UsageKind, { in: number; out: number }>>;
}

export interface UsageSubject {
  /** The app's name — keys are folded, so a trial and an audit of one app are one row. */
  subject: string;
  calls: number;
  in: number;
  out: number;
  cost_usd: number;
}

/** `GET /usage`. */
export interface UsageSummary {
  days: UsageDay[];
  /** The costliest apps in the window, most tokens first. */
  subjects: UsageSubject[];
  totals: { calls: number; in: number; out: number; cost_usd: number };
  /** When the first row was ever written, so the page can say where the history starts. */
  since: string | null;
}
