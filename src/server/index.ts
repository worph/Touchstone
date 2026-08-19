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
import { SubjectRegistry } from './store/registry.js';
import { Scheduler } from './scheduler/index.js';

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
  poolUrl: cfg.bench.pool_url,
  minRemainingMin: cfg.bench.min_remaining_min,
  probeTimeoutMs: cfg.bench.probe_timeout_ms,
});
await prober.load();

// The driver. Ships dry-run: with `scheduler.armed: false` it decides and logs and claims
// nothing, which is what lets its pick be diffed against the live n8n loop's before it is
// ever allowed to drive.
const registry = new SubjectRegistry({
  stateDir: cfg.stateDir,
  events,
  archived: () => store.subjects(),
});
await registry.load();

const scheduler = new Scheduler({
  constants: cfg.scheduler,
  armed: cfg.scheduler.armed,
  stateDir: cfg.stateDir,
  index: store,
  registry,
  events,
  prober,
});
await scheduler.load();

await app.register(registerRoutes, {
  prefix: '/api/v1',
  store,
  events,
  alerts,
  prober,
  push,
  scheduler,
  registry,
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
const importOnce = async () => {
    try {
      const summary = await runImport({ dataDir, index: store });
      // n8n's own cooldown anchor, and its try counts and parks. The archive supplies
      // neither, and a shadow diff missing them is noise — see scheduler/adopt.ts.
      scheduler.noteExternalFinish(summary.lastAuditFinished);
      await scheduler.adoptRollup(summary.rollupSchedule);
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

if (cfg.importer.enabled) {
  const timer = setInterval(() => void importOnce(), cfg.importer.interval_min * 60_000);
  timer.unref?.();
}

/**
 * The tick.
 *
 * Runs whether or not the scheduler is armed, because a dry-run tick is the entire point of
 * shadow mode: it writes its decision to the event log every hour and claims nothing, so the
 * two systems' picks accumulate side by side. The registry refresh is hourly for the same
 * reason n8n re-reads it every tick — the store is what is being audited, and a new app
 * should not wait a day to be seen.
 */
void registry.refresh().catch((err) => app.log.error({ err }, 'first registry refresh failed'));
registry.start(60 * 60_000);

/**
 * The boot sequence, and the order is the point.
 *
 * The first tick has to come *after* the first import, because the import is what carries
 * n8n's cooldown anchor and its try counts and parks. A tick before it decides on an archive
 * with no scheduling state at all and reports a backlog of every app in the store — which,
 * on a dry run being compared against n8n, is a divergence we manufactured ourselves rather
 * than one worth reading. Found by running it: 69 against n8n's 32.
 *
 * Both steps are async and neither blocks the server, which is already listening.
 */
setTimeout(() => {
  void (async () => {
    if (cfg.importer.enabled) await importOnce();
    await scheduler.tick();
  })().catch((err) => app.log.error({ err }, 'boot sequence failed'));
}, 15_000).unref?.();
scheduler.start(cfg.scheduler.tick_min * 60_000);
app.log.info(
  { armed: cfg.scheduler.armed, tick_min: cfg.scheduler.tick_min },
  cfg.scheduler.armed ? 'scheduler ARMED' : 'scheduler in dry-run',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    prober.stop();
    registry.stop();
    scheduler.stop();
    void events.flush().finally(() => process.exit(0));
  });
}
