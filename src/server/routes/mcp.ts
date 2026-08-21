/**
 * `POST /mcp` — the surface the audit agent calls back on while it works.
 *
 * Not to be confused with its sibling `routes/mcp-admin.ts`, which is the *operator's* tools
 * made agent-callable. This one is scoped to a single run and can be reached by whatever is
 * holding that run's token; that one is scoped to an installation and is off by default. They
 * share only the envelope, in `rpc.ts`.
 *
 * Three tools, and the shape of the set is the design:
 *
 * | tool | what it does |
 * | --- | --- |
 * | `list_requirements` | this run's sections, and the canonical ids in each |
 * | `record_requirement` | one requirement settled: id, verdict, severity, note |
 * | `record_phase` | one phase of a section that has a phase plan |
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
import { dispatchRpc, toolError, toolText, type JsonRpcRequest, type McpToolDef } from './rpc.js';

export interface McpRoutesOptions {
  ledger?: RunLedger;
  /** Optional bearer, checked when set. The run token is the real authorisation. */
  token?: string;
}

const TOOLS: McpToolDef[] = [
  {
    name: 'list_requirements',
    description:
      'The sections of this audit and the canonical requirement ids in each. Call this FIRST and record against these ids rather than inventing wording — ids that drift between runs cannot be compared across apps. Each requirement names the section it belongs to, so you do not have to; you only pass a section when you record something the list does not name. An item you find that is not in this list is still worth recording; it will be marked unlisted so the protocol can be corrected.',
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
        section: {
          type: 'string',
          description:
            'Only for an item list_requirements does not name: which section of this audit it belongs to, as listed there. A canonical id already knows its section and this is ignored for one; a section that is not in the list is ignored too.',
        },
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
      'Record one phase of a section that has a phase plan — list_requirements gives the plan and its ids. A phase that could not run is `errored`, never skipped — there is no way to say you chose not to run one.',
    inputSchema: {
      type: 'object',
      properties: {
        run_token: { type: 'string' },
        phase: { type: 'string', description: 'The phase id from the section phase plan, e.g. "E9".' },
        section: {
          type: 'string',
          description: 'Only needed when more than one section has a phase plan. Otherwise inferred.',
        },
        result: { type: 'string', enum: ['pass', 'fail', 'errored', 'n-a'] },
        note: { type: 'string' },
      },
      required: ['run_token', 'phase', 'result'],
    },
  },
];

const routes: FastifyPluginAsync<McpRoutesOptions> = async (app, options) => {
  app.post<{ Body?: JsonRpcRequest }>('/mcp', async (req, reply) => {
    if (options.token) {
      const header = String(req.headers.authorization ?? '');
      if (header !== `Bearer ${options.token}`) return reply.code(401).send({ error: 'unauthorized' });
    }

    const out = await dispatchRpc(req.body ?? {}, {
      server: { name: 'touchstone', version: '1' },
      tools: () => TOOLS,
      call: async (name, args) => {
        const ledger = options.ledger;
        if (!ledger) return toolError('this installation has no run ledger');
        const token = String(args.run_token ?? '');

        if (name === 'list_requirements') {
          const found = ledger.planFor(token);
          if ('error' in found) return toolError(found.error);
          return toolText({
            // Sections first: they are the shape of this run, and a run does not always have
            // the same ones — a section whose prerequisites were missing is not attempted and
            // does not appear here.
            sections: found.sections,
            requirements: found.requirements,
            note: 'Record against these ids; each names its section. An item not listed here is still recorded, marked unlisted.',
          });
        }

        if (name === 'record_requirement') {
          const result = ledger.recordRequirement(token, args as never);
          if (!result.ok) return toolError(result.error);
          return toolText({
            recorded: result.recorded.id,
            section: result.recorded.section ?? null,
            verdict: result.recorded.verdict,
            unlisted: result.recorded.unlisted ?? false,
          });
        }

        if (name === 'record_phase') {
          const result = ledger.recordPhase(token, args as never);
          if (!result.ok) return toolError(result.error);
          return toolText({
            recorded: result.recorded.phase,
            section: result.recorded.section ?? null,
            result: result.recorded.result,
          });
        }

        return toolError(`no such tool: ${name}`);
      },
    });

    return out.body === undefined ? reply.code(out.code).send() : reply.code(out.code).send(out.body);
  });
};

export default routes;
