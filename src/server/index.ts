import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import registerRoutes from './routes/index.js';
import { buildIndex } from './store/index.js';
import { logArchiveMigration, migrateArchiveLayout } from './store/migrate.js';
import { ensureConfigFile, loadConfig, resolveDataDir } from './store/config.js';
import { AlertStore } from './services/alerts.js';
import { BenchProber } from './services/bench.js';
import { EventLog } from './services/events.js';
import { Notifier } from './services/notify.js';
import { PushService } from './services/push.js';
import { appsUrlFor, SubjectRegistry } from './store/registry.js';
import { Scheduler } from './scheduler/index.js';
import { Runner } from './runner/index.js';
import { PortProber } from './services/ports.js';
import { ProtocolStore } from './store/protocols.js';
import { RunLedger } from './services/ledger.js';
import { outcomeClause, type RunOutcome } from '../shared/activity.js';
import { subjectName } from '../shared/subject.js';
import { ChatThreads } from './chat/thread.js';
import { CHAT_TOOLS } from './chat/registry.js';

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

// Reports moved under a store folder when the store became a configured value:
// `reports/<Subject>/` → `reports/<origin>/<Subject>/`. This runs before the index, or the
// index and its cache would hold paths that are about to move. It is tidying and nothing more —
// `coerceMeta` defaults a missing `origin`, so an archive this fails to move still reads
// correctly — which is why it cannot throw and why its event is emitted later, once there is an
// event log to emit it to.
const migration = await migrateArchiveLayout(cfg.reportsRoot);

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
// Deferred from before the index was built, because that is when the move had to happen and
// this is the first moment there is anywhere to say so.
logArchiveMigration(migration, events);

const push = new PushService({ stateDir: cfg.stateDir, events, subject: cfg.notify.push_subject });
await push.load();

const notifier = new Notifier({
  outlets: cfg.notify.outlets,
  events,
  push,
  beaconUrl: cfg.notify.beacon_url,
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
// One origin today. `cfg.origins[0]` is always the default one — `resolveOrigins` puts it
// there — and a second store is R10 step 3, which turns this into one registry per origin.
const origin = cfg.origins[0]!;
const registry = new SubjectRegistry({
  stateDir: cfg.stateDir,
  events,
  origin: origin.id,
  url: appsUrlFor(origin),
  ...(origin.seed ? { seed: origin.seed } : {}),
  archived: () => store.subjects(),
});
await registry.load();

/**
 * The runner. Ships disabled — `runner.enabled: false` — so an armed scheduler would claim
 * and be told the runner is off, which is a legitimate and visible state. Validation is a
 * single hand-run assay through `POST /assays`, never a loop: `AppStore PR Review` is still
 * in n8n on the same agent endpoint.
 */
/**
 * The ports — the agent and the browser sidecars.
 *
 * They were configuration and nothing else until now: an audit needs both, and a dependency
 * whose state you cannot see is one you learn about from a failed run. The bench pool has had
 * a prober since P2; these two get the same treatment.
 */
const ports = new PortProber({
  ports: [
    {
      name: 'agent',
      kind: 'agent',
      url: cfg.runner.agent_url,
      // Through an aggregator the namespaced tool is not in `tools/list` — the aggregator's
      // own `call` is — so only a direct endpoint can be asked for the tool by name.
      ...(cfg.runner.agent_via === 'direct' ? { expectTool: cfg.runner.agent_tool } : {}),
    },
    ...cfg.browsers.map((b) => ({ name: b.name, kind: 'browser' as const, url: b.url, enabled: b.enabled })),
  ],
  stateDir: cfg.stateDir,
  events,
});
await ports.load();

/**
 * The rubric. Local markdown, read per run — see `store/protocols.ts` for why it stopped
 * being three wiki pages fetched by the agent.
 */
const protocols = new ProtocolStore(cfg.protocolsDir);

/**
 * Where the agent records requirements while it works. See `services/ledger.ts` — the point
 * is that a run which dies two-thirds through keeps what it established.
 */
const ledger = new RunLedger({ events });

const runner = new Runner({
  enabled: cfg.runner.enabled,
  reportsRoot: cfg.reportsRoot,
  events,
  index: store,
  prober,
  ports,
  protocols,
  ledger,
  callbackUrl: cfg.runner.callback_url,
  busyBackoffMs: cfg.runner.busy_backoff_min * 60_000,
  agent: { url: cfg.runner.agent_url, tool: cfg.runner.agent_tool, via: cfg.runner.agent_via },
  dumpDir: cfg.stateDir,
});

/**
 * The administrator chat.
 *
 * It runs on the same agent the runner audits with, so there is no second credential and
 * nothing new pointing out of the box. The tools it holds are thin wrappers over the API —
 * and none of them writes a verdict, for the reason `routes/mcp.ts` gives at length.
 */
const chatThreads = new ChatThreads(cfg.stateDir);
await chatThreads.load();

const chatPrompt = await fs
  .readFile(fileURLToPath(new URL('./chat/prompt.md', import.meta.url)), 'utf8')
  .catch(() => null);
if (!chatPrompt) {
  app.log.warn('the chat prompt could not be read; the administrator chat will refuse to run');
}

const scheduler = new Scheduler({
  constants: cfg.scheduler,
  armed: cfg.scheduler.armed,
  stateDir: cfg.stateDir,
  index: store,
  registry,
  events,
  prober,
  // The seam between the two halves: the scheduler claims, the runner audits, and the
  // outcome comes back through `record` — which is where E5's "a busy agent costs nothing"
  // is actually applied.
  dispatch: async (job) => {
    const outcome = await runner.run(job);
    await scheduler.record(
      job.subject,
      outcome.kind === 'verdict'
        ? { kind: 'verdict' }
        : outcome.kind === 'agent_busy'
          ? { kind: 'agent_busy' }
          : outcome.kind === 'blocked'
            ? { kind: 'blocked', reason: outcome.reason }
            : { kind: 'error', reason: outcome.reason },
    );
  },
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
  runner,
  registry,
  ports,
  protocols,
  ledger,
  boardUrl: cfg.bench.board_url,
  chat: {
    threads: chatThreads,
    ...(chatPrompt ? { template: chatPrompt } : {}),
    ask: { agent: { url: cfg.runner.agent_url, tool: cfg.runner.agent_tool, via: cfg.runner.agent_via } },
    ctx: {
      runner,
      registry,
      ledger,
      alerts,
      ports,
      prober,
      // The archive, the log and the backlog: what the chat's read tools answer from. All
      // three are durable, which is the point — the live runner state they used to be limited
      // to is empty after a restart, and an audit that ended is exactly what gets asked about.
      store,
      events,
      scheduler,
      // The same path `POST /assays` takes, so a run started by conversation is recorded,
      // notified and charged to the schedule exactly as a hand-run one is.
      startAssay: (job, opts) => {
        void runner
          .run({ ...job, try_n: 1 })
          .then(async (outcome) => {
            try {
              await scheduler.record(
                job.subject,
                outcome.kind === 'verdict'
                  ? { kind: 'verdict' }
                  : outcome.kind === 'agent_busy'
                    ? { kind: 'agent_busy' }
                    : outcome.kind === 'blocked'
                      ? { kind: 'blocked', reason: outcome.reason }
                      : { kind: 'error', reason: outcome.reason },
              );
            } finally {
              // `finally`, so a schedule that could not be written does not also cost the
              // operator the answer. The two are independent: one is bookkeeping, the other
              // is the reply to a question somebody actually asked.
              await noteFinished(outcome, opts?.threadId);
            }
          })
          .catch((err) => app.log.error({ err, subject: job.subject }, 'chat-started assay failed'));

        /**
         * Tell the conversation that asked for it.
         *
         * The turn that started this ended minutes ago, so there is nobody to return to; the
         * row is written into the thread instead, and the next turn reads it in its history
         * like any other. Without it the assistant is asked "what came of it?" and has to go
         * looking for work it did itself.
         *
         * Best-effort on purpose: a thread file that cannot be appended to must not turn a
         * completed audit into a logged failure.
         */
        async function noteFinished(outcome: RunOutcome, threadId?: string): Promise<void> {
          if (!threadId) return;
          await chatThreads
            .append({
              threadId,
              role: 'note',
              content: `The audit of ${subjectName(job.subject)} you started has finished: ${outcomeClause(outcome)}.`,
            })
            .catch((err) => app.log.warn({ err }, 'could not note a finished audit in its thread'));
        }
      },
    },
    status: async () => {
      const tool = CHAT_TOOLS.find((t) => t.name === 'get_status');
      if (!tool) return 'unavailable';
      const result = await tool.handler({}, { runner, registry, ledger, alerts, ports, prober });
      return result.text;
    },
  },
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

// `benches:` is the *override* for pinning a fixed box and is empty in every normal install;
// the pool is discovered from `bench.pool_url`. Gating the prober on the override alone meant
// the discovered case never probed at all — the app logged "no benches configured", never
// asked the pool anything again, and the scheduler's D7/D8 gate read whatever was last
// written to disk. An open bench alert could then never resolve on its own.
if (cfg.benches.length === 0 && !cfg.bench.pool_url) {
  app.log.warn('no benches configured and no pool to discover — the functional queue stays paused');
} else {
  // Probe once at boot rather than waiting out the first interval: a restart during an
  // outage should not show a stale ✅ for five minutes.
  void prober.probeAll().catch((err) => app.log.error({ err }, 'first bench probe failed'));
  prober.start(cfg.bench.probe_interval_min * 60_000);
}

// The ports are probed on the same cadence as the benches, and at boot for the same reason:
// a restart during an outage should not show a stale green for five minutes.
void ports.probeAll().catch((err) => app.log.error({ err }, 'first port probe failed'));
ports.start(cfg.bench.probe_interval_min * 60_000);

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
  void scheduler.tick().catch((err) => app.log.error({ err }, 'first tick failed'));
}, 15_000).unref?.();
scheduler.start(cfg.scheduler.tick_min * 60_000);
app.log.info(
  { armed: cfg.scheduler.armed, tick_min: cfg.scheduler.tick_min, runner: cfg.runner.enabled },
  cfg.scheduler.armed ? 'scheduler ARMED' : 'scheduler in dry-run',
);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    prober.stop();
    ports.stop();
    registry.stop();
    scheduler.stop();
    void events.flush().finally(() => process.exit(0));
  });
}
