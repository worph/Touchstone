/**
 * `GET|PUT /settings/context` and `GET /config` — the two things about *this instance* an
 * operator can look at from inside it.
 *
 * They sit together because they are the same question at two temperatures. The context
 * prompt is the half Touchstone owns and a page may write: it is prose for a model, so
 * there is nothing to get wrong but its size. `config.yaml` is the half a person edits on
 * the volume, and it is **read-only here on purpose** — it is loaded once at boot and half
 * of it (roots, the scheduler's constants, the agent's address) is handed to services that
 * would not see a change anyway, so a save button would be a lie about what it did.
 *
 * The config is redacted before it leaves the process. `redactConfig` matches on key names
 * rather than values, because `config.yaml` merges over the defaults with an index
 * signature: whatever the operator put in it also comes out of here.
 */

import type { FastifyPluginAsync } from 'fastify';

import { redactConfig, type TouchstoneConfig } from '../store/config.js';
import { ContextTooLarge, type ContextStore } from '../store/context.js';
import type { EventLog } from '../services/events.js';

export interface SettingsRoutesOptions {
  /** Absent, the context routes answer 503 — it is a real feature with nowhere to write. */
  context?: ContextStore;
  /** The config as loaded at boot. Absent in the route tests and in dev. */
  config?: TouchstoneConfig;
  events?: EventLog;
}

const routes: FastifyPluginAsync<SettingsRoutesOptions> = async (app, options) => {
  app.get('/settings/context', async (_req, reply) => {
    if (!options.context) {
      return reply.code(503).send({ error: 'no data directory to keep a context prompt in' });
    }
    return options.context.read();
  });

  app.put<{ Body?: { text?: unknown } }>('/settings/context', async (req, reply) => {
    if (!options.context) {
      return reply.code(503).send({ error: 'no data directory to keep a context prompt in' });
    }
    const text = req.body?.text;
    if (typeof text !== 'string') return reply.code(400).send({ error: 'text is required' });

    try {
      const saved = await options.context.write(text);
      options.events?.log({
        level: 'info',
        code: 'CONTEXT_EDITED',
        // Said in full because it is the one edit here with no version to trace it by: the
        // context is not recorded in an assay the way a protocol version is.
        message: saved.bytes
          ? 'The administrator context prompt was edited; the next turn will use it'
          : 'The administrator context prompt was cleared',
        detail: { bytes: saved.bytes },
      });
      return saved;
    } catch (err) {
      if (err instanceof ContextTooLarge) {
        return reply.code(400).send({ error: err.message });
      }
      throw err;
    }
  });

  /**
   * The effective configuration — defaults merged with `config.yaml`, which is what the app
   * is actually running on, not what the file says on its own.
   */
  app.get('/config', async () => ({
    path: options.config ? `${options.config.dataDir}/config.yaml` : null,
    /** The file is not re-read; this is the config the process booted with. */
    loaded_at: bootedAt,
    config: options.config ? redactConfig(options.config) : null,
  }));
};

/** When this process read `config.yaml`. Everything on that page is as of this moment. */
const bootedAt = new Date().toISOString();

export default routes;
