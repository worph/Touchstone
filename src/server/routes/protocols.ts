/**
 * `GET /protocols`, `GET /protocols/:id`, `PUT /protocols/:id` — the rubric, readable and
 * editable from the app that enforces it.
 *
 * This is the answer to the largest hole the design had: the standard every verdict is
 * measured against lived in a wiki, and Touchstone held a slug. You could not see it, you
 * could not change it, and the plan to stop using that wiki would have stranded it.
 *
 * A save **bumps the version**, and that is not a nicety. Every assay records the standard
 * and version it was graded against, so an edit that left the number alone would make two
 * different rubrics indistinguishable in the archive — the archive would say the same thing
 * about runs that were judged by different rules.
 */

import type { FastifyPluginAsync } from 'fastify';

import { renderMarkdown } from '../domain/markdown.js';
import type { EventLog } from '../services/events.js';
import { isSafeId, type ProtocolStore } from '../store/protocols.js';

export interface ProtocolRoutesOptions {
  protocols?: ProtocolStore;
  events?: EventLog;
}

const routes: FastifyPluginAsync<ProtocolRoutesOptions> = async (app, options) => {
  app.get('/protocols', async () => {
    const all = (await options.protocols?.list()) ?? [];
    return {
      directory: options.protocols?.directory ?? null,
      // Metadata only. The bodies are thousands of words each and the list is a menu.
      protocols: all.map((p) => ({ ...p.meta, file: p.file, bytes: p.bytes, modified_at: p.modified_at })),
    };
  });

  app.get<{ Params: { id: string } }>('/protocols/:id', async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const found = await options.protocols?.get(req.params.id);
    if (!found) return reply.code(404).send({ error: 'no such protocol' });
    return { ...found, html: renderMarkdown(found.body) };
  });

  app.put<{ Params: { id: string }; Body?: { body?: string; bump_version?: boolean } }>(
    '/protocols/:id',
    async (req, reply) => {
      if (!options.protocols) return reply.code(503).send({ error: 'no protocol store' });
      if (!isSafeId(req.params.id)) return reply.code(400).send({ error: 'bad id' });
      const body = req.body?.body;
      if (typeof body !== 'string' || body.trim().length === 0) {
        // An empty rubric would grade every app against nothing and pass them all. Refusing
        // is the only safe answer, and it is cheaper than explaining the result later.
        return reply.code(400).send({ error: 'the protocol body cannot be empty' });
      }

      const saved = await options.protocols.save(req.params.id, body, {
        bumpVersion: req.body?.bump_version !== false,
      });
      if (!saved) return reply.code(404).send({ error: 'no such protocol' });

      options.events?.log({
        level: 'info',
        code: 'PROTOCOL_EDITED',
        message: 'The audit protocol was edited, and the next audit will use it',
        detail: { id: saved.meta.id, version: saved.meta.version, bytes: saved.bytes },
      });
      return { ...saved, html: renderMarkdown(saved.body) };
    },
  );
};

export default routes;
