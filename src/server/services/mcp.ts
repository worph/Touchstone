/**
 * The smallest MCP client that can talk to beacon.
 *
 * Beacon speaks streamable-HTTP and is stateless — no session header, one POST per call,
 * response framed as a single SSE `data:` line — so the whole client is one function and
 * pulling in an SDK would be more code than this, not less.
 *
 * It started life in `tools/` for the importer and moved here in P2, unchanged: the
 * notifier, the importer and (in P4) the runner all reach Beacon the same way, and
 * `tsconfig.server.json` compiles only `src/`, so a shared client cannot live in `tools/`.
 */

export interface McpOptions {
  url?: string;
  /** Seconds. Docmost page fetches are slow enough that the default deserves to be generous. */
  timeout?: number;
}

let nextId = 0;

export class McpError extends Error {}

export async function callTool(
  toolName: string,
  args: Record<string, unknown>,
  opts: McpOptions = {},
): Promise<string> {
  const url = opts.url ?? process.env.TOUCHSTONE_BEACON_URL ?? 'http://localhost:3000/mcp/';
  const body = {
    jsonrpc: '2.0',
    id: ++nextId,
    method: 'tools/call',
    params: {
      name: 'call',
      arguments: {
        tool_name: toolName,
        arguments: opts.timeout ? { ...args, __beacon_timeout: opts.timeout } : args,
      },
    },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
    redirect: 'follow',
  });
  if (!res.ok) throw new McpError(`${url} → HTTP ${res.status}`);

  const text = await res.text();
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? text
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('')
    : text;

  let parsed: any;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new McpError(`unparseable MCP response: ${text.slice(0, 200)}`);
  }
  if (parsed.error) throw new McpError(`MCP error: ${JSON.stringify(parsed.error)}`);

  const content = parsed.result?.content;
  if (!Array.isArray(content)) throw new McpError(`no content in MCP result`);
  const out = content
    .filter((c: any) => typeof c?.text === 'string')
    .map((c: any) => c.text)
    .join('\n');
  if (parsed.result?.isError) throw new McpError(out.slice(0, 300));
  return out;
}
