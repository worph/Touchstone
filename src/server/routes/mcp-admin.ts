/**
 * `POST /mcp/admin` — the operator's own tools, made callable by an agent.
 *
 * This serves **the chat's registry**, unchanged: `CHAT_TOOLS` and the same `ChatToolContext`
 * the administrator chat is given. That is the whole design. A second definition of "what an
 * agent may ask Touchstone" would be a second thing to keep in step with invariant 6, and the
 * first time the two disagreed the weaker one would be the one somebody had connected.
 *
 * So the scope here is exactly the scope of the chat: seventeen tools, twelve of which read
 * what is *written down* — the board, the archive, a report file, the fix brief, a trial, the
 * log, the backlog, the schedule, the rubric, the store's own files, and this instance's own
 * settings — and five which act: `run_assay`, the pair that trials files nobody has committed
 * (`open_trial`, `run_trial`), `edit_protocol` and `set_control`. None of them writes a
 * verdict, mints a section, or names a repo and ref; `registry.ts` explains at length why not.
 *
 * Two are worth reading twice before enabling this surface wide open. `edit_protocol` rewrites
 * the prose every *future* audit is judged by — it cannot reach the gate, the frontmatter or
 * an executor, and every edit is a revision with a reason. `set_control` changes when and
 * whether audits happen at all, including the two safety switches; every change is a logged
 * event naming what moved and from what. Both are marked `writes`, so an installation that
 * wants this address answers-only wants `read_only`, which drops them.
 *
 * ## Why it is off by default
 *
 * Everything else Touchstone exposes sits behind the AppShield sidecar (ARCHITECTURE §8), and
 * the two exceptions are deliberate: `/public`, which is read-only by a boot-time check, and
 * the run ledger, which is scoped to a token that dies with its run. This surface is neither.
 * It is meant to be beaconified — announced on UDP and aggregated behind a Beacon endpoint
 * that, by its own documentation, has no identity model at all: whoever can reach `:9300/mcp/`
 * can call whatever is registered there. Turning that on is a decision about the box, not a
 * default, so `admin_mcp.enabled` starts false and an installation that leaves it false does
 * not serve the address at all — there is no disabled-but-answering state to mistake for a
 * working one.
 *
 * Two narrowings for an installation that wants the surface without all of it:
 *
 * - `admin_mcp.read_only` drops every tool marked `writes` from `tools/list` *and* refuses it
 *   in `tools/call`. Hiding a tool is not the same as not having one, so both are checked.
 * - `admin_mcp.token` is a bearer, checked when set. Beaconify can inject it (`BEACONIFY_AUTH`)
 *   without the caller knowing it, which is what makes it useful in front of an aggregator
 *   that cannot authenticate anybody.
 *
 * Note what remains true even wide open: `run_assay` still refuses when `runner.enabled` is
 * false, still refuses while another audit is running, and still resolves the subject against
 * the registry. This surface changes *who can ask*, never *what may be asked for*.
 */

import type { FastifyPluginAsync } from 'fastify';

/**
 * What a client is told before it reads a single tool description.
 *
 * It says one thing the per-tool text structurally cannot: **which** tool a question belongs
 * to. A description argues for its own tool and is read alone, so a caller that reached for
 * the wrong one is refused by the wrong one and never sees the right one — which is exactly
 * how "audit these files for an app nobody has committed" ended at `run_assay`'s "there is no
 * subject called that", read as a misspelling, and stopped. Two sentences here would have
 * turned that into a trial.
 *
 * Kept to the fork in the road. Everything else a caller needs is on the tool it picked, and
 * an instructions block that restates seventeen descriptions is one more thing to keep in
 * step with them.
 */
const INSTRUCTIONS = [
  'Touchstone audits apps against a versioned standard and issues the verdict each one carries.',
  '',
  'Two things can be judged, and picking the wrong one is the common mistake:',
  '',
  '- **An app a configured store offers** — `run_assay`. The audit fetches the app from its store, the result becomes the hallmark that app carries, and the subject must therefore be one `list_subjects` gives.',
  '- **Bytes that are not in a store, or not yet** — `open_trial` (upload the files, no commit and no push) or `run_trial` with a GitHub archive URL. A trial names any app directory, including one no store has ever offered, and writes where the report index never looks: it can never move what an app carries.',
  '',
  'So a new app, an uncommitted fix, or a branch is always a trial — never a failed audit. Reading is separate from both: `get_board` for every verdict at once, then `get_subject`, `get_fix_brief` and `get_report` for one app in increasing detail.',
].join('\n');

import { CHAT_TOOLS, type ChatTool, type ChatToolContext } from '../chat/registry.js';
import type { EventLog } from '../services/events.js';
import { dispatchRpc, toolError, type JsonRpcRequest, type McpToolDef } from './rpc.js';

export interface AdminMcpOptions {
  /** Off unless an operator said otherwise. Absent, the route is not registered. */
  enabled?: boolean;
  /** Checked when set. The aggregator in front of this cannot authenticate anyone. */
  token?: string;
  /** Serve only the tools that report; refuse the ones that act. */
  readOnly?: boolean;
  /**
   * The chat's context, verbatim — the same archive, registry, ledger and `startAssay`.
   *
   * Deliberately without a `threadId`: a run started from here has no conversation to report
   * back into, and the operator learns it finished the way they learn about a scheduled one,
   * through the notification and the log. Inventing a thread for it would put rows in a
   * transcript nobody was party to.
   */
  ctx?: ChatToolContext;
  /** So a call that acted leaves a trace on the Activity page, and a refusal does too. */
  events?: EventLog;
}

const routes: FastifyPluginAsync<AdminMcpOptions> = async (app, options) => {
  if (!options.enabled) return;

  const visible = (): ChatTool[] =>
    options.readOnly ? CHAT_TOOLS.filter((tool) => !tool.writes) : [...CHAT_TOOLS];

  const defs = (): McpToolDef[] =>
    visible().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));

  app.post<{ Body?: JsonRpcRequest }>('/mcp/admin', async (req, reply) => {
    if (options.token) {
      const header = String(req.headers.authorization ?? '');
      if (header !== `Bearer ${options.token}`) return reply.code(401).send({ error: 'unauthorized' });
    }

    const out = await dispatchRpc(req.body ?? {}, {
      server: { name: 'touchstone-admin', version: '1' },
      instructions: INSTRUCTIONS,
      tools: defs,
      call: async (name, args) => {
        const tool = visible().find((candidate) => candidate.name === name);
        if (!tool) {
          // A tool hidden by read_only is reported as absent rather than as forbidden: the
          // list this caller was given is the truth about what it may call, and a different
          // answer here would only teach it to try again.
          const refusal = `no such tool: ${name}`;
          options.events?.log({
            level: 'warn',
            code: 'ADMIN_MCP_CALL',
            message: `An agent asked for a tool this surface does not serve: ${name}.`,
            detail: { tool: name, failed: true, read_only: options.readOnly === true },
          });
          return toolError(refusal);
        }

        const ctx = options.ctx;
        if (!ctx) return toolError('this installation has no operator context wired');

        try {
          const result = await tool.handler(args, ctx);
          options.events?.log({
            // A read is routine and belongs at debug; a call that could act is worth a row an
            // operator sees without asking for one, because ASSAY_STARTED alone does not say
            // that something outside the app asked for it.
            level: tool.writes ? 'info' : 'debug',
            code: 'ADMIN_MCP_CALL',
            message: result.failed
              ? `${tool.name}, called over MCP, was refused.`
              : `${tool.name} was called over MCP.`,
            detail: { tool: tool.name, failed: result.failed === true, read_only: options.readOnly === true },
          });
          return result.failed ? toolError(result.text) : { text: result.text };
        } catch (err) {
          /**
           * A handler that throws is a bug in Touchstone, not in the request — but it reaches
           * the caller as a tool result all the same (`rpc.ts`), so an agent mid-task gets a
           * sentence instead of a transport failure it cannot interpret.
           */
          const message = err instanceof Error ? err.message : String(err);
          app.log.error({ err, tool: tool.name }, 'admin MCP tool threw');
          options.events?.log({
            level: 'error',
            code: 'ADMIN_MCP_CALL',
            message: `${tool.name}, called over MCP, could not run.`,
            detail: { tool: tool.name, failed: true, read_only: options.readOnly === true },
          });
          return toolError(`${tool.name} could not run: ${message}`);
        }
      },
    });

    return out.body === undefined ? reply.code(out.code).send() : reply.code(out.code).send(out.body);
  });
};

export default routes;
