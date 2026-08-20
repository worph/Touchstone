/**
 * The agent call and its answer — rows D2, D3, D4.
 *
 * Ported from n8n's `Call Claude Code (protocol)` and `Extract LLM response`. The
 * classification below is reproduced **exactly**, including the order the tests are applied
 * in, because each branch decides whether a subject's try is burned:
 *
 * | class | what it means | costs a try |
 * | --- | --- | --- |
 * | `agent-auth` | the agent's own session is dead — nothing to do with the app | no |
 * | `agent-busy` | someone else has the agent (409) — PR Review shares it, §5.3 | **no** |
 * | `agent-error` | the call failed or returned nothing | yes |
 * | `parse-failed` | an answer arrived with no JSON object in it | yes |
 *
 * `agent-busy` being free is the rule that matters. `AppStore PR Review` stays in n8n and
 * calls the *same* endpoint, so contention is not something owning the loop removes — a PR
 * can take the agent at any moment, and a subject must not be walked toward parking for it.
 *
 * The 409 test runs only on a response already judged an error, and only when it is not an
 * auth failure. An auth failure whose text happens to contain "conflict" is still an auth
 * failure, and n8n's ordering says so.
 */

const DEFAULT_TOOL = 'claude-code__query_claude';

/** Four hours. An audit installs an app, drives a browser and uninstalls it again. */
export const AGENT_TIMEOUT_S = 14_400;

/**
 * What the agent returns, under contract. `Build prompt` demands a strictly-valid JSON
 * object with exactly these keys, and the report headline the archive parses was *generated
 * from* them — which is why the runner consumes this and parses no markdown at all.
 */
export interface AgentReport {
  app_name: string;
  title: string;
  verdict: 'compliant' | 'non-compliant' | 'errored';
  /** Capitalised, as the contract states it: `Critical | Major | Minor | none`. */
  severity: string;
  risk_score: number;
  summary: string;
  report_markdown: string;
}

export type AgentFailure = 'agent-auth' | 'agent-busy' | 'agent-error' | 'parse-failed';

export type AgentOutcome =
  | { ok: true; report: AgentReport }
  | { ok: false; error: AgentFailure; rawText: string };

export interface AgentOptions {
  url?: string;
  /**
   * The tool to call. `claude-code__query_claude` when posting straight at the agent, as
   * n8n does; a namespaced name like `beacon-yunderalabs.claude-code__query_claude` when the
   * call goes through a Beacon aggregator instead.
   */
  tool?: string;
  /**
   * How the call is framed.
   *
   * `direct` posts `tools/call` at the agent itself, which is what n8n does from inside the
   * yunderalabs stack. `beacon` wraps it in the aggregator's own `call` tool — the only way
   * in from outside that network, and a different envelope rather than a different address.
   */
  via?: 'direct' | 'beacon';
  timeoutS?: number;
  workdir?: string;
  /** Injected in tests. Nothing else should reach past this. */
  fetchImpl?: typeof fetch;
}

const PERMISSIONS = [
  'Bash',
  'Read',
  'Glob',
  'Grep',
  'mcp__beacon__call',
  'mcp__claude_ai_yunderalabs__call',
  'mcp__claude_ai_yunderalabs_nsl_sh__call',
  'mcp__claude_ai_Yunderateam__call',
];

const AUTH_RE = /failed to authenticate|oauth session|not logged in|please run \/login|invalid api key|authentication_error/i;

/**
 * Pull the assistant's text out of a JSON-RPC answer, SSE-framed or not.
 *
 * The last `data:` frame carrying content wins, which is n8n's behaviour: the stream ends
 * with the complete message and the earlier frames are partials.
 */
export function extractText(payload: string): string {
  let text = '';
  for (const line of String(payload).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const p = t.slice(5).trim();
    if (!p) continue;
    try {
      const o = JSON.parse(p);
      const candidate = o?.result?.content?.[0]?.text;
      if (typeof candidate === 'string' && candidate) text = candidate;
    } catch {
      /* a partial frame is not an error; the next one may complete it */
    }
  }
  if (!text) {
    try {
      const o = JSON.parse(payload);
      const candidate = o?.result?.content?.[0]?.text;
      if (typeof candidate === 'string') text = candidate;
    } catch {
      /* not JSON either — `classify` will call it an agent-error */
    }
  }
  return text;
}

/**
 * The index of the `}` that closes the object opening at `from`, or -1.
 *
 * n8n uses `lastIndexOf('}')`, which is right only when nothing follows the object. A model
 * that adds a closing sentence, or a report body whose own text ends in a brace, gives it a
 * slice that will not parse — and `parse-failed` costs the app a try. Scanning with string
 * and escape state is the same cost and cannot be fooled by a brace inside a string.
 *
 * A -1 here means the object never closed, which is a *truncated* response rather than a
 * malformed one. The caller reports them the same way; the dumped body tells them apart.
 */
export function matchingBrace(text: string, from: number): number {
  if (from < 0) return -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The classification, branch for branch as n8n applies it. */
export function classify(text: string, fallback = ''): AgentOutcome {
  const t = String(text ?? '').trim();
  const lower = t.toLowerCase();

  const isAuth = AUTH_RE.test(t);
  const isError =
    !t || isAuth || /^error calling remote tool/i.test(t) || lower.includes('httpstatuserror');
  if (isError) {
    const isBusy =
      !isAuth &&
      (lower.includes('409') || lower.includes('conflict') || lower.includes('in progress'));
    return {
      ok: false,
      error: isAuth ? 'agent-auth' : isBusy ? 'agent-busy' : 'agent-error',
      rawText: String(t || fallback).slice(0, 2000),
    };
  }

  // The object may arrive fenced, prefixed with prose, or both — and the fence handling that
  // used to be here caused three separate failures against real answers, each one discarding a
  // complete, correct audit:
  //
  //   1. it unwrapped the FIRST ``` anywhere, and `report_markdown` almost always contains one;
  //   2. it took `lastIndexOf('}')` as the object's end, which is wrong the moment anything
  //      follows the object;
  //   3. even unwrapping only a LEADING fence, it took the next ``` as the closing one — and
  //      that next fence was a ```yaml block inside the report.
  //
  // All three vanish if the fence is simply ignored. A fence marker contains no braces, so the
  // object still begins at a `{`, and a scanner that tracks string state finds its end without
  // caring what comes after. Each candidate `{` is tried in order, so prose containing a brace
  // before the object costs an attempt rather than the run.
  for (let from = t.indexOf('{'); from >= 0; from = t.indexOf('{', from + 1)) {
    const close = matchingBrace(t, from);
    if (close < 0) break; // nothing after this opens and closes; later braces cannot either
    try {
      const obj = JSON.parse(t.slice(from, close + 1)) as Partial<AgentReport>;
      if (obj && typeof obj === 'object' && (obj.report_markdown !== undefined || obj.verdict !== undefined)) {
        return {
          ok: true,
          report: {
            app_name: String(obj.app_name ?? ''),
            title: String(obj.title ?? ''),
            verdict: (obj.verdict as AgentReport['verdict']) ?? 'errored',
            severity: String(obj.severity ?? 'none'),
            risk_score: Number(obj.risk_score ?? 0) || 0,
            summary: String(obj.summary ?? ''),
            report_markdown: String(obj.report_markdown ?? ''),
          },
        };
      }
    } catch {
      /* not this brace; try the next */
    }
  }
  return { ok: false, error: 'parse-failed', rawText: String(t || fallback).slice(0, 20_000) };
}

/**
 * One call. Never throws for an agent-side failure — a thrown exception and a classified
 * one are different things to the caller, and only the classification knows whether a try
 * was spent.
 */
export async function callAgent(prompt: string, opts: AgentOptions = {}): Promise<AgentOutcome> {
  const raw = await postToAgent(prompt, opts);
  if (!raw.ok) return classify(raw.errorText);
  return classify(raw.text, raw.payload);
}

/** What the endpoint said, before anything decides what it means. */
export type AgentRaw =
  | { ok: true; text: string; payload: string }
  | { ok: false; errorText: string };

/**
 * The transport, with no opinion about the answer.
 *
 * Split out of `callAgent` because the administrator chat talks to the same endpoint and
 * wants a different contract back — `classify` reads the *assay* JSON and would quietly
 * flatten a chat reply into an empty report. Everything about how the call is made, and in
 * particular how a busy aggregator is surfaced, stays in one place.
 */
export async function postToAgent(prompt: string, opts: AgentOptions = {}): Promise<AgentRaw> {
  const url = opts.url ?? process.env.TOUCHSTONE_AGENT_URL ?? 'http://beacon-backend:9300/mcp';
  const tool = opts.tool ?? process.env.TOUCHSTONE_AGENT_TOOL ?? DEFAULT_TOOL;
  const timeoutS = opts.timeoutS ?? AGENT_TIMEOUT_S;
  const doFetch = opts.fetchImpl ?? fetch;

  const args = {
    prompt,
    continueSession: false,
    workdir: opts.workdir ?? '/home/claude/workspace/mcp',
    timeout: timeoutS,
    permission: PERMISSIONS,
    __beacon_timeout: timeoutS,
  };
  const via = opts.via ?? (process.env.TOUCHSTONE_AGENT_VIA === 'beacon' ? 'beacon' : 'direct');
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params:
      via === 'beacon'
        ? { name: 'call', arguments: { tool_name: tool, arguments: args } }
        : { name: tool, arguments: args },
  };

  let payload: string;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutS * 1000),
    });
    payload = await res.text();
    if (!res.ok) {
      // An HTTP-level 409 is the same contention the text-level test looks for, and it must
      // reach the same branch — otherwise a busy agent burns a try depending only on how the
      // aggregator chose to report it.
      return { ok: false, errorText: `HTTPStatusError ${res.status} ${payload.slice(0, 400)}` };
    }
  } catch (err) {
    return {
      ok: false,
      errorText: `Error calling remote tool: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, text: extractText(payload), payload };
}
