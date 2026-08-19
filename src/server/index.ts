import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import registerRoutes from './routes/index.js';
import { buildIndex } from './store/index.js';
import { ensureConfigFile, loadConfig, resolveDataDir } from './store/config.js';
import { AlertStore } from './services/alerts.js';
import { BenchProber } from './services/bench.js';
import { EventLog } from './services/events.js';
import { Notifier } from './services/notify.js';
import { PushService } from './services/push.js';
import { runImport } from './services/importer.js';

const PORT = Number(process.env.TOUCHSTONE_PORT ?? 8080);
const HOST = process.env.TOUCHSTONE_HOST ?? '0.0.0.0';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// Configuration first: from P2 the prober needs credentials, and an operator who has to
// guess the file's shape has no way to supply them. Seeding is inert — every value in the
// seeded file equals the default — so this changes nothing about how the app then runs.
const dataDir = resolveDataDir(process.env.TOUCHSTONE_DATA_DIR);
let seededConfig: string | null = null;
try {
  seededConfig = await ensureConfigFile(dataDir);
} catch (err) {
  app.log.warn({ err }, 'could not seed config.yaml; running on defaults');
}
const cfg = await loadConfig(dataDir);

// The index is the entire data layer: scan the archive, parse frontmatter, hold it in
// memory. `state/index.json` only makes a restart cheaper — deleting it is always safe.
const store = await buildIndex(cfg.reportsRoot, {
  onError: (file, err) => app.log.warn({ file, err }, 'unreadable report, skipped'),
});
app.log.info(
  { subjects: store.subjects().length, assays: store.all().length, broken: store.broken.length },
  'index built',
);

// ── services ───────────────────────────────────────────────────────────────────────────
// Constructed in dependency order and wired by callback rather than by an event bus: there
// are four of them, and a bus would be indirection standing in for two function references.

const events = new EventLog(cfg.stateDir, {
  onWriteError: (err, event) => app.log.error({ err, code: event.code }, 'event not written'),
});
await events.load();

const push = new PushService({ stateDir: cfg.stateDir, events, subject: cfg.notify.push_subject });
await push.load();

const notifier = new Notifier({
  outlets: cfg.notify.outlets,
  events,
  push,
  beaconUrl: cfg.docmost.beaconUrl,
});

const alerts = new AlertStore(cfg.stateDir, {
  events,
  onTransition: (alert, kind) => notifier.handleAlert(alert, kind),
});
await alerts.load();

// Attached after `alerts.load()` so restoring a two-day-old outage from disk does not
// notify about it again.
events.subscribe((event) => notifier.handleEvent(event));

const prober = new BenchProber({
  benches: cfg.benches,
  stateDir: cfg.stateDir,
  events,
  alerts,
  boardUrl: cfg.bench.board_url,
  probeTimeoutMs: cfg.bench.probe_timeout_ms,
});
await prober.load();

await app.register(registerRoutes, {
  prefix: '/api/v1',
  store,
  events,
  alerts,
  prober,
  push,
  boardUrl: cfg.bench.board_url,
});

// In production the built SPA sits next to the compiled server. In dev, Vite serves it
// instead and proxies /api here, so a missing dist/web is expected and not an error.
const webRoot = fileURLToPath(new URL('../web', import.meta.url));
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.sendFile('index.html');
  });
}

app.listen({ port: PORT, host: HOST }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});

// ── timers ─────────────────────────────────────────────────────────────────────────────

if (seededConfig) {
  events.log({
    level: 'info',
    code: 'CONFIG_SEEDED',
    message: 'A starter configuration file was written into the data directory',
  });
}

events.log({
  level: 'info',
  code: 'SERVER_STARTED',
  message: 'Touchstone started and read the archive',
  detail: {
    subjects: store.subjects().length,
    assays: store.all().length,
    benches: cfg.benches.length,
    outlets: cfg.notify.outlets.length,
  },
});

if (cfg.benches.length === 0) {
  app.log.warn('no benches configured — the functional queue stays paused');
} else {
  // Probe once at boot rather than waiting out the first interval: a restart during an
  // outage should not show a stale ✅ for five minutes.
  void prober.probeAll().catch((err) => app.log.error({ err }, 'first bench probe failed'));
  prober.start(cfg.bench.probe_interval_min * 60_000);
}

/**
 * The transitional data feed.
 *
 * n8n still owns the loop and rewrites its Docmost roll-up every tick, so re-reading it is
 * how Touchstone stays current with zero changes to n8n. It runs in-process, and upserts
 * into the live index, because the index is built at boot and never re-scanned — a shelled
 * out import would rewrite files this process keeps ignoring.
 */
if (cfg.importer.enabled) {
  const importOnce = async () => {
    try {
      const summary = await runImport({ dataDir, index: store });
      events.log({
        level: 'info',
        code: 'IMPORT_COMPLETED',
        message: 'Re-read the audit roll-up from the wiki',
        detail: {
          subjects: summary.subjects,
          written: summary.written,
          unchanged: summary.unchanged,
        },
      });
    } catch (err) {
      events.log({
        level: 'warn',
        code: 'IMPORT_FAILED',
        message: 'The audit roll-up could not be read, so the archive may be behind',
        detail: { error: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  // Not at boot: the index was just built from the same files, and a cold start should
  // serve a page before it spends two minutes on someone else's wiki.
  const timer = setInterval(() => void importOnce(), cfg.importer.interval_min * 60_000);
  timer.unref?.();
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    prober.stop();
    void events.flush().finally(() => process.exit(0));
  });
}
