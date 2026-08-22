/**
 * `/uploads/:token/*` — writing the files a trial will audit.
 *
 * Three verbs and one credential. A session is opened elsewhere (`open_trial`, which is how an
 * agent gets a token at all); this is only the door its files come through.
 *
 * **Why `PUT` and not WebDAV.** WebDAV earns its complexity when a *person* wants to mount the
 * space in Finder and drag things into it. The writer here is Claude Code working through MCP,
 * which wants one verb per file, so this is one verb per file: `PUT` to write, `DELETE` to
 * remove, `GET` to see what is there. If a human ever does want to mount it, WebDAV can be laid
 * over the same `UploadStore` without any of this changing.
 *
 * **Why under `/api/v1` and not `/public`.** Two reasons, and they point the same way. The
 * caller is on `pcs`, where the beaconified MCP surface already reaches the backend directly,
 * so nothing needs an anonymous prefix to get here — and from outside the box these paths sit
 * behind the AppShield gate like every other operator route. `/public` meanwhile is read-only
 * by a boot-time check (invariant 10); a write route under it would not merely be unwise, it
 * would fail to start. Being under `/api/` also keeps these clear of the SPA catch-all, which
 * answers any other unknown path with `index.html` and a 200.
 *
 * **The token is the whole credential**, so a token that is unknown *or* lapsed gets the same
 * 404. "Expired" and "never existed" are the same answer to anybody who should not be holding
 * it, and telling the two apart is a small oracle for no benefit.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import type { EventLog } from '../services/events.js';
import { UploadError, type UploadSession, type UploadStore } from '../store/uploads.js';

export interface UploadRoutesOptions {
  uploads?: UploadStore;
  /** Per-file ceiling, so the body is refused by the framework before it is buffered. */
  maxFileBytes?: number;
  events?: EventLog;
}

function fail(reply: FastifyReply, code: number, error: string) {
  return reply.code(code).send({ error });
}

/** What a caller may see about its own session. Never the token — it already has it. */
function describe(session: UploadSession, files: { path: string; bytes: number }[]) {
  return {
    id: session.id,
    subject: session.subject,
    repo: session.repo,
    created_at: session.created_at,
    expires_at: session.expires_at,
    trial_slug: session.trial_slug ?? null,
    total_bytes: files.reduce((sum, f) => sum + f.bytes, 0),
    files,
  };
}

const routes: FastifyPluginAsync<UploadRoutesOptions> = async (app, options) => {
  const store = options.uploads;
  if (!store) return;

  const limit = options.maxFileBytes ?? 2 * 1024 * 1024;

  // Every content type arrives as a Buffer. An app folder is a compose, a rationale and some
  // PNGs, and the caller should not have to describe which is which for the bytes to survive
  // — a JSON parser in this path would reject a YAML body outright and, worse, would silently
  // re-encode one that happened to parse. Encapsulated to this plugin, so the JSON API is
  // untouched.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: limit }, (_req, body, done) => {
    done(null, body);
  });

  /** The session a token names, having answered the request itself if there is none. */
  const session = (token: string, reply: FastifyReply): UploadSession | null => {
    const found = store.byToken(token);
    if (!found) {
      void fail(reply, 404, 'no such upload session');
      return null;
    }
    return found;
  };

  app.get<{ Params: { token: string } }>('/uploads/:token', async (request, reply) => {
    const found = session(request.params.token, reply);
    if (!found) return reply;
    return describe(found, await store.manifest(found));
  });

  app.put<{ Params: { token: string; '*': string } }>(
    '/uploads/:token/*',
    { bodyLimit: limit },
    async (request, reply) => {
      const found = session(request.params.token, reply);
      if (!found) return reply;

      const body = request.body;
      if (!Buffer.isBuffer(body)) return fail(reply, 400, 'expected a request body');

      try {
        const written = await store.put(found, request.params['*'], body);
        options.events?.log({
          level: 'debug',
          code: 'UPLOAD_WRITTEN',
          message: `A file was written into upload session ${found.id}`,
          detail: { upload: found.id, path: written.path, bytes: written.bytes },
        });
        return reply.code(200).send(written);
      } catch (err) {
        if (err instanceof UploadError) return fail(reply, 400, err.message);
        throw err;
      }
    },
  );

  app.delete<{ Params: { token: string; '*': string } }>(
    '/uploads/:token/*',
    async (request, reply) => {
      const found = session(request.params.token, reply);
      if (!found) return reply;

      try {
        const removed = await store.del(found, request.params['*']);
        if (!removed) return fail(reply, 404, `no such file: ${request.params['*']}`);
        return reply.code(200).send({ removed: request.params['*'] });
      } catch (err) {
        if (err instanceof UploadError) return fail(reply, 400, err.message);
        throw err;
      }
    },
  );
};

export default routes;
