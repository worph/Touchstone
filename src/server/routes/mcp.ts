/**
 * `POST /mcp` — the surface the audit agent calls back on while it works.
 *
 * Three tools, and the shape of the set is the design:
 *
 * | tool | what it does |
 * | --- | --- |
 * | `list_requirements` | the canonical ids for this run's protocol |
 * | `record_requirement` | one requirement settled: id, verdict, severity, note |
 * | `record_phase` | one functional phase: A, C, D, E8, E9, E10, F, G |
 *
 * **There is no `record_result`, and there will not be one.** The moment an agent can post
 * its own verdict, the protocol's gate — *any Critical is non-compliant unconditionally* —
 * becomes advisory, and a run that says `compliant` walks past the whole rubric. The agent
 * judges each requirement; Touchstone computes the outcome from what was recorded.
 *
 * `list_requirements` exists to solve a smaller problem that would otherwise be permanent:
 * left to free text an agent writes `cpu_shares` on one run and `cpu_shares set on all
 * services` on the next, and any cross-app question — *which apps fail this?* — quietly stops
 * working. Handing it the ids means it maps rather than invents.
 *
 * **Authentication is the run token, passed as an argument on every call.** Not a header:
 * a beaconify sidecar in front of this adds its own static `Authorization`, which guards the
 * endpoint but says nothing about *which run* is writing. The token is minted per dispatch
 * and dies with the run, so a stale agent still writing after we gave up is rejected and
 * visible rather than silently accepted.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { RunLedger } from '../services/ledger.js';

export interface McpRoutesOptions {
  ledger?: RunLedger;
  /** Optional bearer, checked when set. The run token is the real authorisation. */
  token?: string;
}

interface JsonRpc {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

const TOOLS = [
  {
    name: 'list_requirements',
    description:
      'The canonical requirement ids for the audit you are running. Call this FIRST and record against these ids rather than inventing wording — ids that drift between runs cannot be compared across apps. An item you find that is not in this list is still worth recording; it will be marked unlisted so the protocol can be corrected.',
    inputSchema: {
      type: 'object',
      properties: { run_token: { type: 'string', description: 'The run token given to you in the prompt.' } },
      required: ['run_token'],
    },
  },
  {
    name: 'record_requirement',
    description:
      'Record one requirement as soon as you have settled it — do not wait until the end. Recording as you go means a run that is interrupted keeps what it established, and that a mistake in the shape is caught while you can still fix it.',
    inputSchema: {
      type: 'object',
      properties: {
        run_token: { type: 'string' },
        id: { type: 'string', description: 'A canonical id from list_requirements where one fits.' },
        requirement: { type: 'string', description: 'The requirement in your own words, as evidence.' },
        verdict: { type: 'string', enum: ['pass', 'fail', 'n-a', 'unverified'] },
        severity: {
          type: 'string',
          enum: ['Critical', 'Major', 'Minor'],
          description: 'Required on a fail. The verdict gate reads this, not the count of failures.',
        },
        note: { type: 'string', description: 'Why. One or two sentences, the evidence for the verdict.' },
      },
      required: ['run_token', 'id', 'verdict'],
    },
  },
  {
    name: 'record_phase',
    description:
      'Record one functional phase (A, C, D, E8, E9, E10, F, G). A phase that could not run is `errored`, never skipped — there is no way to say you chose not to run one.',
    inputSchema: {
      type: 'object',
      properties: {
        run_token: { type: 'string' },
        phase: { type: 'string', description: 'The phase letter or code, e.g. "E9".' },
        result: { type: 'string', enum: ['pass', 'fail', 'errored', 'n-a'] },
        note: { type: 'string' },
      },
      required: ['run_token', 'phase', 'result'],
    },
  },
];

const routes: FastifyPluginAsync<McpRoutesOptions> = async (app, options) => {
  app.post<{ Body?: JsonRpc }>('/mcp', async (req, reply) => {
    if (options.token) {
      const header = String(req.headers.authorization ?? '');
      if (header !== `Bearer ${options.token}`) return reply.code(401).send({ error: 'unauthorized' });
    }

    const body = req.body ?? {};
    const id = body.id ?? null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
    /** A tool-level failure is a *result* with `isError`, not a transport error — that is how
     *  the agent gets told what to fix rather than seeing the call blow up. */
    const toolError = (message: string) =>
      ok({ isError: true, content: [{ type: 'text', text: message }] });
    const text = (value: unknown) =>
      ok({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });

    switch (body.method) {
      case 'initialize':
        return ok({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'touchstone', version: '1' },
        });

      case 'notifications/initialized':
        return reply.code(204).send();

      case 'tools/list':
        return ok({ tools: TOOLS });

      case 'tools/call': {
        const ledger = options.ledger;
        if (!ledger) return toolError('this installation has no run ledger');
        const name = String(body.params?.name ?? '');
        const args = body.params?.arguments ?? {};
        const token = String(args.run_token ?? '');

        if (name === 'list_requirements') {
          const found = ledger.requirementsFor(token);
          if ('error' in found) return toolError(found.error);
          return text({
            requirements: found,
            note: 'Record against these ids. An item not listed here is still recorded, marked unlisted.',
          });
        }

        if (name === 'record_requirement') {
          const out = ledger.recordRequirement(token, args as never);
          if (!out.ok) return toolError(out.error);
          return text({ recorded: out.recorded.id, verdict: out.recorded.verdict, unlisted: out.recorded.unlisted ?? false });
        }

        if (name === 'record_phase') {
          const out = ledger.recordPhase(token, args as never);
          if (!out.ok) return toolError(out.error);
          return text({ recorded: out.recorded.phase, result: out.recorded.result });
        }

        return toolError(`no such tool: ${name}`);
      }

      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${body.method}` } };
    }
  });
};

export default routes;
