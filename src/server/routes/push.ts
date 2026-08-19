/**
 * Web-push registration.
 *
 * `GET /push` is what the browser needs before it can subscribe, and it is deliberately
 * shaped so an unconfigured instance says so in a field rather than by failing: the
 * Activity page has to render with push unconfigured (UX.md §2.3).
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { PushSubscription } from 'web-push';

import type { PushStatus } from '../../shared/activity.js';
import type { PushService } from '../services/push.js';

export interface PushRoutesOptions {
  push?: PushService;
}

function looksLikeSubscription(body: unknown): body is PushSubscription & { label?: string } {
  if (typeof body !== 'object' || body === null) return false;
  const sub = body as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  return (
    typeof sub.endpoint === 'string' &&
    sub.endpoint.startsWith('https://') &&
    typeof sub.keys?.p256dh === 'string' &&
    typeof sub.keys?.auth === 'string'
  );
}

const routes: FastifyPluginAsync<PushRoutesOptions> = async (app, options) => {
  const status = (): PushStatus => ({
    configured: options.push?.configured ?? false,
    public_key: options.push?.publicKey ?? null,
    devices: options.push?.deviceCount ?? 0,
  });

  app.get('/push', async (): Promise<PushStatus> => status());

  app.post('/push/subscribe', async (request, reply: FastifyReply) => {
    if (!options.push) return reply.code(503).send({ error: 'push is not available' });
    if (!looksLikeSubscription(request.body)) {
      return reply.code(400).send({ error: 'not a push subscription' });
    }
    await options.push.subscribe(request.body);
    return status();
  });

  app.post<{ Body: { endpoint?: string } }>('/push/unsubscribe', async (request, reply) => {
    if (!options.push) return reply.code(503).send({ error: 'push is not available' });
    const endpoint = request.body?.endpoint;
    if (typeof endpoint !== 'string') return reply.code(400).send({ error: 'endpoint is required' });
    await options.push.unsubscribe(endpoint);
    return status();
  });
};

export default routes;
