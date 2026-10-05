/**
 * The Workshop page's API — `/api/v1/workshop/*`. Operator frame only; nothing here is under
 * `/public`, and no chat or admin-MCP tool reaches the verbs that write (docs/auto-app-pr.md
 * §10): opening a pull request under a person's GitHub identity is an outward-facing act a
 * surface that authenticates nobody must not be able to cause.
 *
 * - `GET  /workshop` — everything the page draws.
 * - `GET  /workshop/proposals/:id` — one proposal, with its diff and the last round's feedback.
 * - `POST /workshop/proposals` — Propose: `{ subject, kind }` or `{ wish, kind: 'wish' }`.
 * - `POST /workshop/proposals/:id/submit` — Open PR, within the quota.
 * - `POST /workshop/proposals/:id/discard` — throw a proposal away; charges the task nothing.
 * - `POST /workshop/arm` — `{ armed: boolean | null }`; null returns to what config.yaml says.
 * - `DELETE /workshop/memory/:task` — forget what a task taught us, so it may be picked again.
 * - `PUT    /workshop/github` — `{ token }`: set the GitHub token, probed in the same response.
 * - `DELETE /workshop/github` — clear it, back to `github.token` / `TOUCHSTONE_GITHUB_TOKEN`.
 *
 * The token is **write-only**: nothing here or anywhere else returns it, only where it came
 * from and what the probe made of it.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import type { ProposalKind } from '../../shared/workshop.js';
import { GitHubTokenInvalid, normalizeToken } from '../store/githubtoken.js';
import { WorkshopRefusal, type Workshop } from '../services/workshop.js';

export interface WorkshopRoutesOptions {
  workshop?: Workshop;
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

const KINDS: ProposalKind[] = ['fix', 'currency', 'wish'];

const routes: FastifyPluginAsync<WorkshopRoutesOptions> = async (app, options) => {
  const ws = options.workshop;

  const guard = async <T>(reply: FastifyReply, work: () => Promise<T>) => {
    try {
      return await work();
    } catch (err) {
      if (err instanceof WorkshopRefusal) return fail(reply, err.code, err.message);
      throw err;
    }
  };

  app.get('/workshop', async (_req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    return ws.view();
  });

  app.get<{ Params: { id: string } }>('/workshop/proposals/:id', async (req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    const d = await ws.detail(req.params.id);
    return d ?? fail(reply, 404, `no such proposal: ${req.params.id}`);
  });

  app.post<{ Body?: { subject?: string; wish?: string; kind?: string } }>('/workshop/proposals', async (req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    const body = req.body ?? {};
    const kind = (body.kind ?? 'fix') as ProposalKind;
    if (!KINDS.includes(kind)) return fail(reply, 400, `kind must be one of ${KINDS.join(', ')}`);
    return guard(reply, async () => {
      const proposal = await ws.propose(
        { kind, ...(body.subject ? { subject: String(body.subject) } : {}), ...(body.wish ? { wish: String(body.wish) } : {}) },
        'operator',
      );
      return reply.code(202).send({ proposal });
    });
  });

  app.post<{ Params: { id: string } }>('/workshop/proposals/:id/submit', async (req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    return guard(reply, async () => ({ proposal: await ws.submitPr(req.params.id, 'operator') }));
  });

  app.post<{ Params: { id: string } }>('/workshop/proposals/:id/discard', async (req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    return guard(reply, async () => ({ proposal: await ws.discard(req.params.id, 'operator') }));
  });

  app.post<{ Body?: { armed?: boolean | null } }>('/workshop/arm', async (req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    const armed = req.body?.armed;
    if (armed === null) await ws.clearArmed('operator');
    else if (typeof armed === 'boolean') await ws.setArmed(armed, 'operator');
    else return fail(reply, 400, 'armed must be true, false or null');
    return { armed: ws.armed, armed_default: ws.armedDefault };
  });

  app.delete<{ Params: { task: string } }>('/workshop/memory/:task', async (req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    const forgotten = await ws.forget(decodeURIComponent(req.params.task), 'operator');
    return forgotten ? { forgotten } : fail(reply, 404, 'nothing remembered about that task');
  });

  app.put<{ Body?: { token?: unknown } }>('/workshop/github', async (req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    let token: string;
    try {
      token = normalizeToken(req.body?.token);
    } catch (err) {
      if (err instanceof GitHubTokenInvalid) return fail(reply, 400, err.message);
      throw err;
    }
    return guard(reply, async () => ({ github: await ws.setToken(token, 'operator'), github_token: ws.tokenInfo() }));
  });

  app.delete('/workshop/github', async (_req, reply) => {
    if (!ws) return fail(reply, 503, 'the workshop is not wired on this installation');
    return guard(reply, async () => ({ github: await ws.setToken(null, 'operator'), github_token: ws.tokenInfo() }));
  });
};

export default routes;
