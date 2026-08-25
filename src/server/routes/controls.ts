/**
 * `GET /controls`, `PUT /controls/:key` and `DELETE /controls/:key` — the configuration an
 * operator may change without editing a file on the volume and restarting.
 *
 * Its own prefix rather than a branch of `/settings` for one dull, load-bearing reason:
 * `/settings/context` already exists, so `/settings/:key` would be a parametric route living
 * behind a static one that shares its shape. Fastify resolves that correctly today and the
 * next person to add `/settings/something` would have to know it. `/controls` has no such
 * neighbour, and the noun is the one `domain/controls.ts` defines.
 *
 * The route knows nothing about any individual control: it resolves the key, hands the value
 * to `setControl` and returns the row that came back. Every rule about what a control means,
 * what it accepts and what applying it does is in the domain, which is what lets the chat
 * tool and this share it rather than agree with each other.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { ControlsResponse } from '../../shared/controls.js';
import { listControls, resetControl, setControl, type ControlPorts } from '../domain/controls.js';

export type ControlsRoutesOptions = ControlPorts;

const routes: FastifyPluginAsync<ControlsRoutesOptions> = async (app, options) => {
  const answer = (): ControlsResponse => ({
    controls: listControls(options),
    file: options.controls?.file ?? null,
  });

  app.get('/controls', async () => answer());

  app.put<{ Params: { key: string }; Body?: { value?: unknown } }>(
    '/controls/:key',
    async (req, reply) => {
      if (!options.controls) {
        return reply.code(503).send({ error: 'There is no data directory to keep a setting in.' });
      }
      const result = await setControl(options, req.params.key, req.body?.value, 'operator');
      if (!result.ok) return reply.code(400).send({ error: result.error });
      // The whole list, not the one row: changing the cooldown changes what the page says
      // about the countdown beside it, and a caller that has to re-fetch to see that has a
      // window where the page disagrees with itself.
      return { ...answer(), changed: result.changed };
    },
  );

  app.delete<{ Params: { key: string } }>('/controls/:key', async (req, reply) => {
    if (!options.controls) {
      return reply.code(503).send({ error: 'There is no data directory to keep a setting in.' });
    }
    const result = await resetControl(options, req.params.key, 'operator');
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ...answer(), changed: result.changed };
  });
};

export default routes;
