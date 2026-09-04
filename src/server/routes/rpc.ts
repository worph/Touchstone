/**
 * The MCP envelope, shared by the two surfaces that speak it.
 *
 * Touchstone serves MCP twice and for two different audiences — `routes/mcp.ts` is the run
 * ledger the audit agent calls back on, `routes/mcp-admin.ts` is the operator's own tools made
 * agent-callable — and they differ only in *which tools* and *who may call*. Everything else
 * is the same four methods in the same shapes, so it lives here once: a second copy is how the
 * two drift into answering `initialize` differently and only one of them stays discoverable.
 *
 * Two details are load-bearing and easy to get wrong:
 *
 * - **A tool-level failure is a `result` with `isError`, not a JSON-RPC error.** That is how a
 *   caller gets told what to fix instead of seeing the call blow up. A JSON-RPC error is
 *   reserved for "this method does not exist", which is a fact about the server.
 * - **A notification is answered `202` with no body.** Beacon's client and beaconify both
 *   treat 202 as the accepted-no-content case and read anything else as a response they must
 *   parse; a `204` reaches the SDK as a body-less 2xx with no content type and is where a
 *   handshake stalls. Notifications have no `id`, so there is nothing to answer anyway.
 */

export const MCP_PROTOCOL_VERSION = '2024-11-05';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

/** What one tool call produced. Text either way; `isError` when it could not do what was asked. */
export interface McpToolOutcome {
  text: string;
  isError?: boolean;
}

export interface McpSurface {
  server: { name: string; version: string };
  /**
   * What this surface is *for*, returned by `initialize` as MCP's `instructions`.
   *
   * A client reads it once, before any tool description, which makes it the only place a
   * caller learns something the per-tool text cannot teach: which of two tools its question
   * belongs to. Tool descriptions are read one at a time and by definition argue for
   * themselves, so a caller that picked the wrong one never sees the right one's text — the
   * failure this exists to prevent, where "audit these files" reached `run_assay`, was refused
   * for naming an app no store offers, and read as a spelling mistake.
   *
   * Optional: the assay ledger surface serves one caller that is already inside a run and has
   * nothing to choose between.
   */
  instructions?: string;
  /** Called per request, not captured: a surface may narrow its list at runtime. */
  tools: () => McpToolDef[];
  call: (name: string, args: Record<string, unknown>) => Promise<McpToolOutcome>;
}

/** A status and, unless it is 202, a body. Fastify does the sending. */
export interface RpcReply {
  code: number;
  body?: unknown;
}

/** Tool results are text content. Anything that is not already a string is shown as JSON. */
export function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

export function toolText(value: unknown): McpToolOutcome {
  return { text: asText(value) };
}

export function toolError(message: string): McpToolOutcome {
  return { text: message, isError: true };
}

export async function dispatchRpc(body: JsonRpcRequest, surface: McpSurface): Promise<RpcReply> {
  const id = body.id ?? null;
  const ok = (result: unknown): RpcReply => ({ code: 200, body: { jsonrpc: '2.0', id, result } });

  switch (body.method) {
    case 'initialize':
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: surface.server,
        ...(surface.instructions ? { instructions: surface.instructions } : {}),
      });

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { code: 202 };

    case 'ping':
      return ok({});

    case 'tools/list':
      return ok({ tools: surface.tools() });

    case 'tools/call': {
      const name = String(body.params?.name ?? '');
      const args = body.params?.arguments ?? {};
      const outcome = await surface.call(name, args);
      return ok({
        ...(outcome.isError ? { isError: true } : {}),
        content: [{ type: 'text', text: outcome.text }],
      });
    }

    default:
      return {
        code: 200,
        body: {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `method not found: ${body.method}` },
        },
      };
  }
}
