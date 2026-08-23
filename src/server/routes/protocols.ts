/**
 * `GET /protocols`, `GET /protocols/:id`, `PUT /protocols/:id` — the rubric, readable and
 * editable from the app that enforces it — and `/protocols/:id/revisions*`, its history.
 *
 * This is the answer to the largest hole the design had: the standard every verdict is
 * measured against lived in a wiki, and Touchstone held a slug. You could not see it, you
 * could not change it, and the plan to stop using that wiki would have stranded it.
 *
 * A save **records a revision**, and that is not a nicety. Every assay records the sha256 of
 * the protocol that graded it, and these routes are what turn that hash back into the text —
 * otherwise the archive names a rubric nobody can read. A save also requires a **reason**: the
 * one thing a diff cannot tell you is why, and the contrast with a `.md` edited on the volume
 * (recorded, but with nothing to say for itself) is the point rather than an inconsistency.
 *
 * There is deliberately **no restore route**. Putting an old revision back is "open it, load
 * it into the editor, save it forward" — an ordinary `PUT` with a reason. A rewind endpoint
 * would let the admin MCP that authenticates nobody quietly revert the standard that every
 * subsequent audit is judged against, which is invariant 6 wearing a different hat.
 */

import type { FastifyPluginAsync } from 'fastify';

import { lineDiff } from '../../shared/linediff.js';
import { renderMarkdown } from '../domain/markdown.js';
import { saveProtocol } from '../domain/protocoledit.js';
import type { EventLog } from '../services/events.js';
import { isSafeId, parseExecutor, type ProtocolStore } from '../store/protocols.js';
import type { RevisionStore } from '../store/revisions.js';

export interface ProtocolRoutesOptions {
  protocols?: ProtocolStore;
  revisions?: RevisionStore;
  events?: EventLog;
}

const routes: FastifyPluginAsync<ProtocolRoutesOptions> = async (app, options) => {
  /**
   * Which files a section is made of: its rubric, and the script it names if it names one.
   *
   * The history is shown per **section**, not per file, because that is the question an
   * operator has — "what has changed about the currency check" covers both `currency.md` and
   * `currency.sh`, and the two are edited for the same reasons.
   */
  const filesOf = async (id: string): Promise<string[] | null> => {
    const found = await options.protocols?.get(id);
    if (!found) return null;
    const executor = parseExecutor(found.meta.executor);
    return [found.file, ...(executor.kind === 'script' ? [executor.file] : [])];
  };

  app.get('/protocols', async () => {
    const all = (await options.protocols?.list()) ?? [];
    const log = (await options.revisions?.all()) ?? [];
    return {
      directory: options.protocols?.directory ?? null,
      history_failed: options.revisions?.failed ?? null,
      // Metadata only. The bodies are thousands of words each and the list is a menu.
      protocols: all.map((p) => ({
        ...p.meta,
        file: p.file,
        sha256: p.sha256,
        bytes: p.bytes,
        modified_at: p.modified_at,
        // The head row, so the tab strip can label a protocol without a second request.
        revision: log.find((r) => r.file === p.file) ?? null,
      })),
    };
  });

  app.get<{ Params: { id: string } }>('/protocols/:id', async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const found = await options.protocols?.get(req.params.id);
    if (!found) return reply.code(404).send({ error: 'no such protocol' });
    const log = (await options.revisions?.forFiles([found.file])) ?? [];
    return { ...found, revision: log[0] ?? null, html: renderMarkdown(found.body) };
  });

  /** One section's history: its rubric and its script, interleaved, newest first. */
  app.get<{ Params: { id: string } }>('/protocols/:id/revisions', async (req, reply) => {
    if (!isSafeId(req.params.id)) return reply.code(400).send({ error: 'bad id' });
    const files = await filesOf(req.params.id);
    if (!files) return reply.code(404).send({ error: 'no such protocol' });
    return {
      files,
      failed: options.revisions?.failed ?? null,
      revisions: (await options.revisions?.forFiles(files)) ?? [],
    };
  });

  /**
   * One revision, and the bytes it names.
   *
   * `body` is null when the log has the row but not the snapshot — an operator emptied
   * `.history/`, say. Saying so is better than 404: the row is evidence that the edit
   * happened, which is worth something even when the text is gone.
   */
  app.get<{ Params: { id: string; sha: string } }>(
    '/protocols/:id/revisions/:sha',
    async (req, reply) => {
      if (!isSafeId(req.params.id)) return reply.code(400).send({ error: 'bad id' });
      const found = await options.revisions?.get(req.params.sha);
      if (!found) return reply.code(404).send({ error: 'no such revision' });
      return {
        revision: found.revision,
        body: found.text,
        html: found.revision.file.endsWith('.md') ? renderMarkdown(stripFrontmatter(found.text)) : null,
      };
    },
  );

  /**
   * What changed. Against the parent by default, which is the question the history asks; or
   * against any other revision of the same file with `?against=`.
   *
   * Computed here rather than in the browser: the page would otherwise fetch two 27 KB bodies
   * to render a two-line change, and `data/client.ts` hands pages finished shapes rather than
   * raw material.
   */
  app.get<{ Params: { id: string; sha: string }; Querystring: { against?: string; seq?: string } }>(
    '/protocols/:id/revisions/:sha/diff',
    async (req, reply) => {
      if (!isSafeId(req.params.id)) return reply.code(400).send({ error: 'bad id' });
      // `seq` names the row, and the row is what a diff is about. Without it a hash that
      // appears twice — a file restored to an earlier state has the identity it had then —
      // resolves to the first occurrence, and the answer is the right bytes diffed against
      // somebody else's parent. The page always sends it; a hand-written URL need not.
      const seq = Number(req.query.seq);
      const to =
        (Number.isInteger(seq) ? await options.revisions?.at(seq) : null) ??
        (await options.revisions?.get(req.params.sha));
      if (!to) return reply.code(404).send({ error: 'no such revision' });
      if (Number.isInteger(seq) && to.revision.seq !== seq) {
        return reply.code(404).send({ error: 'no such revision' });
      }

      const againstSha = req.query.against ?? to.revision.parent;
      const from = againstSha ? await options.revisions?.get(againstSha) : null;
      if (from && from.revision.file !== to.revision.file) {
        // Diffing a rubric against a script is not a question anybody meant to ask.
        return reply.code(400).send({ error: 'those revisions are of different files' });
      }
      return {
        from: from?.revision ?? null,
        to: to.revision,
        diff: lineDiff(from?.text ?? '', to.text),
      };
    },
  );

  app.put<{ Params: { id: string }; Body?: { body?: string; message?: string } }>(
    '/protocols/:id',
    async (req, reply) => {
      if (!options.protocols) return reply.code(503).send({ error: 'no protocol store' });
      if (!isSafeId(req.params.id)) return reply.code(400).send({ error: 'bad id' });
      // The empty-body and no-reason refusals, the sweep and the event all live in
      // `domain/protocoledit.ts`, because the administrator chat saves protocols too and a
      // second copy of this sequence is a second place to forget the history.
      const result = await saveProtocol(options, {
        id: req.params.id,
        body: req.body?.body,
        message: req.body?.message,
        via: 'api',
      });
      if (!result.ok) return reply.code(result.status).send({ error: result.error });

      const saved = result.protocol;
      return { ...saved, revision: result.revision, html: renderMarkdown(saved.body) };
    },
  );
};

/**
 * Drop a snapshot's frontmatter before rendering it.
 *
 * A revision is the whole file, because the whole file is what the hash covers. The page
 * wants the prose — the same view `GET /protocols/:id` gives, where `body` is already split.
 */
function stripFrontmatter(raw: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return (m ? raw.slice(m[0].length) : raw).trim();
}

export default routes;
