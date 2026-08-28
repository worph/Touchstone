import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import registerRoutes from './routes/index.js';
import { readStandards } from './domain/standards.js';
import { buildIndex } from './store/index.js';
import { logArchiveMigration, migrateArchiveLayout } from './store/migrate.js';
import { splitSubjectKey } from '../shared/subject.js';
import { TrialStore } from './store/trials.js';
import { UploadStore } from './store/uploads.js';
import { ensureConfigFile, loadConfig, resolveDataDir } from './store/config.js';
import { AlertStore } from './services/alerts.js';
import { BenchProber } from './services/bench.js';
import { EventLog } from './services/events.js';
import { Notifier } from './services/notify.js';
import { PushService } from './services/push.js';
import { SubjectRegistry } from './store/registry.js';
import { Scheduler } from './scheduler/index.js';
import { Runner } from './runner/index.js';
import { PortProber } from './services/ports.js';
import { ensureProtocolFiles, ProtocolStore } from './store/protocols.js';
import { ensureKbFiles, KbStore } from './store/kb.js';
import { RevisionStore } from './store/revisions.js';
import { StoreDocReader } from './services/storedoc.js';
import { RunLedger } from './services/ledger.js';
import { outcomeClause, type RunOutcome } from '../shared/activity.js';
import { subjectName } from '../shared/subject.js';
import { ChatThreads } from './chat/thread.js';
import { ContextStore } from './store/context.js';
import { ControlStore } from './store/controls.js';
import { applyStoredControls, type ControlPorts } from './domain/controls.js';
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

// The rubric has to be *on disk in the data dir*, not merely in the image: it is editable in
// the app, and every assay records the sha256 of the file that judged it. In a
// container the data dir is an empty volume on first boot, and an empty protocol directory
// means every run blocks `no_protocol`. Seeding never overwrites — an operator's edit outranks
// the image's copy, or a redeploy would quietly change the standard.
const seededProtocols = await ensureProtocolFiles(cfg.protocolsDir);

// The knowledge base, on the same terms and for the same reason: an empty volume would
// otherwise leave the agent operating a platform it has been told nothing about. Missing
// entirely is a supported state — the prompt is then what it was before the KB existed — so
// this failing is never fatal.
const seededKb = await ensureKbFiles(cfg.kbDir);

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
// Every configured store. `cfg.origins[0]` is always the default one — `resolveOrigins` puts
// it there — and each store's list is fetched and cached independently, so one store's GitHub
// outage cannot empty another's.
const registry = new SubjectRegistry({
  stateDir: cfg.stateDir,
  events,
  origins: cfg.origins,
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
 * What the rubric used to say, and when it stopped saying it.
 *
 * Swept here rather than lazily: the log has to be recording *before* anything reads a
 * protocol, so the bytes an audit was judged against are already captured when it starts. On
 * a box that predates this file, the first sweep records whatever is on the volume — changelog
 * sections and stale `version:` keys and all — which is how the pre-cutover text survives.
 */
const revisions = new RevisionStore(cfg.protocolsDir, {
  onWarn: (message) =>
    events.log({
      level: 'warn',
      code: 'PROTOCOL_HISTORY_FAILED',
      message: `The protocol history is not being recorded — ${message}`,
      detail: { dir: cfg.protocolsDir },
    }),
  onRecorded: (rev) => {
    // Only the ones nobody announced. A `save` already has PROTOCOL_EDITED and a `seed`
    // already has PROTOCOL_SEEDED; an `observed` row is the one that says the standard
    // changed on the volume while the app was not looking.
    if (rev.source !== 'observed') return;
    events.log({
      level: 'info',
      code: 'PROTOCOL_REVISED',
      message: `${rev.file} changed on disk outside the app, and was recorded as revision ${rev.seq}`,
      detail: { file: rev.file, sha256: rev.sha256, seq: rev.seq },
    });
  },
});
await revisions.sweep();

/**
 * The knowledge base, and its own history.
 *
 * A second `RevisionStore` rather than a second directory inside the first: the protocol
 * history's file names are bare (`functional.md`), so one log over two directories could not
 * say which `maison.md` it meant. Two logs, two `.history/` folders, one class.
 *
 * The KB is **not** the standard — `domain/standards.ts` never reads it, an edit here puts no
 * chip on a row and re-eligibles nobody — but it is still recorded, because a page can change
 * what an audit concludes and a hash on an assay that resolves to nothing is the problem this
 * class exists to end. See `store/kb.ts`.
 */
const kb = new KbStore(cfg.kbDir);
const kbRevisions = new RevisionStore(cfg.kbDir, {
  onWarn: (message) =>
    events.log({
      level: 'warn',
      code: 'KB_HISTORY_FAILED',
      message: `The knowledge base history is not being recorded — ${message}`,
      detail: { dir: cfg.kbDir },
    }),
  onRecorded: (rev) => {
    if (rev.source !== 'observed') return;
    events.log({
      level: 'info',
      code: 'KB_REVISED',
      message: `${rev.file} changed on disk outside the app, and was recorded as revision ${rev.seq}`,
      detail: { file: rev.file, sha256: rev.sha256, seq: rev.seq },
    });
  },
});
await kbRevisions.sweep();

/**
 * Reading the store's own documents — the contribution guide the rubric is meant to track.
 *
 * Constructed here rather than per request because the cache is the point: GitHub is read
 * unauthenticated and the 60-an-hour budget is shared with the registry refresh, so a
 * conversation re-reading CONTRIBUTING.md must not be able to make an origin unreachable and
 * stop the runner dispatching. See `services/storedoc.ts`.
 */
const storedoc = new StoreDocReader();

/**
 * Where the agent records requirements while it works. See `services/ledger.ts` — the point
 * is that a run which dies two-thirds through keeps what it established.
 */
const ledger = new RunLedger({ events });

const runner = new Runner({
  enabled: cfg.runner.enabled,
  reportsRoot: cfg.reportsRoot,
  origins: cfg.origins,
  storeReachable: (id) => registry.reachable(id),
  storeFailure: (id) => registry.failureOf(id),
  // Recorded onto every assay this run writes, so the archive can later say whether a verdict
  // is about the app as it currently stands.
  subjectVersion: (key) => registry.versionOf(key),
  events,
  index: store,
  prober,
  ports,
  protocols,
  revisions,
  kb,
  kbRevisions,
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
/**
 * Trials — auditing a ref without touching what a subject carries.
 *
 * The store is separate and the index over it is built per request, so the scheduler and the
 * subject registry are never handed it. That is what makes "a trial cannot move a hallmark"
 * true by construction rather than by a rule somebody has to keep remembering.
 */
const trials = new TrialStore(cfg.stateDir, cfg.trialsRoot);
await trials.load();
// Report directories with no row — the orphans a crash between the two writes can strand,
// and the ones the old row-only eviction left behind before trials owned their own files.
const sweptTrials = await trials.sweepOrphans();
if (sweptTrials.length > 0) {
  events.log({
    level: 'info',
    code: 'TRIAL_SWEPT',
    message: `Removed ${sweptTrials.length} trial report folder(s) with no record`,
    detail: { slugs: sweptTrials },
  });
}

/**
 * Upload sessions — the files a trial audits when there is no ref to fetch them from.
 *
 * Swept at boot rather than on a timer: a session's whole life is one debug loop, and a timer
 * is a thing a restart forgets. Anything that lapsed while the process was down goes now.
 */
const uploads = new UploadStore(cfg.stateDir, cfg.uploadsRoot, cfg.uploads);
await uploads.load();
const sweptUploads = await uploads.sweepExpired();
if (sweptUploads.length > 0) {
  events.log({
    level: 'info',
    code: 'TRIAL_SWEPT',
    message: `Removed ${sweptUploads.length} lapsed upload session(s)`,
    detail: { slugs: sweptUploads },
  });
}

const chatThreads = new ChatThreads(cfg.stateDir);
await chatThreads.load();

/**
 * The operator's standing instructions for the administrator chat — `data/context.md`.
 *
 * Not loaded here: the store reads per call, so an edit on the Settings page governs the
 * next thing the operator says rather than the next restart.
 */
const chatContext = new ContextStore(cfg.dataDir);

const chatPrompt = await fs
  .readFile(fileURLToPath(new URL('./chat/prompt.md', import.meta.url)), 'utf8')
  .catch(() => null);
if (!chatPrompt) {
  app.log.warn('the chat prompt could not be read; the administrator chat will refuse to run');
}

const scheduler = new Scheduler({
  constants: cfg.scheduler,
  armed: cfg.scheduler.armed,
  // The cadence is the object's own, so a `scheduler.tick_min` control restored below has
  // somewhere to land before `start()` arms the timer at whatever it ended up being.
  tickMin: cfg.scheduler.tick_min,
  stateDir: cfg.stateDir,
  index: store,
  registry,
  events,
  prober,
  // Read per tick, not captured at boot: `data/protocols/` is a volume somebody edits over
  // SSH, and the sweep that records such an edit runs before the answer is asked for.
  standardMovedAt: async () => (await readStandards(protocols, revisions)).moved_at,
  // The registry's own cached map — the tree fetch rides its refresh, so a tick costs no
  // GitHub request of its own. That matters: the budget is 60 an hour and an origin driven
  // unreachable stops the runner dispatching (invariant 3).
  subjectVersions: () => registry.versions(),
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

/**
 * The configuration that can be changed while this is running — `domain/controls.ts`.
 *
 * Loaded and applied here, after every object a control drives exists and before the first
 * tick: an override is a value the process is supposed to be running on, so a boot that
 * decided once on the config file's figure and then switched would be reporting a decision
 * nobody could reproduce. `config.yaml` remains the default in the only sense that matters —
 * delete `state/controls.json` and the instance is back to what the file asks for.
 */
const controlStore = new ControlStore({ stateDir: cfg.stateDir });
await controlStore.load();
const controlPorts: ControlPorts = {
  controls: controlStore,
  defaults: { scheduler: cfg.scheduler, runner: cfg.runner, bench: cfg.bench },
  scheduler,
  runner,
  prober,
  events,
};
const restored = await applyStoredControls(controlPorts);
if (restored.applied.length > 0) {
  app.log.info({ controls: restored.applied }, 'restored settings changed since boot config');
}

/**
 * Liveness, for the container healthcheck and nothing else.
 *
 * Outside `/api/v1` and deliberately trivial: it answers whether the process is up, not
 * whether the environment is well — the agent, the browser and the bench pool all being
 * unreachable is a legitimate running state (invariant 7, the app must stay diagnosable with
 * every outbound port broken), and a healthcheck that failed on it would have Docker restart
 * a process that is working correctly and reporting the outage.
 */
app.get('/healthz', async () => ({ ok: true, subjects: store.subjects().length }));

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
  revisions,
  ledger,
  browser: {
    ...(cfg.browsers[0] ? { browserUrl: cfg.browsers[0].url } : {}),
    // Only while a run is in flight; the panel narrows the tab list to that audit's own
    // isolated context, so it answers "what is THIS audit looking at" rather than "what is
    // on the box".
    runningSubject: () => {
      const live = runner.status().running;
      return live ? splitSubjectKey(live.subject).name : null;
    },
  },
  trials: {
    runner,
    trials,
    trialsRoot: cfg.trialsRoot,
    events,
    store,
    known: () => registry.list(),
    uploads,
    origins: cfg.origins,
    protocols,
    publicBaseUrl: cfg.trials.public_base_url,
  },
  uploads: { uploads, maxFileBytes: cfg.uploads.max_file_bytes, events },
  boardUrl: cfg.bench.board_url,
  // This instance about itself: the context prompt the chat is handed, and the config this
  // process booted with — redacted on the way out, `routes/settings.ts`.
  settings: { context: chatContext, config: cfg },
  /** The same bundle the chat's `set_control` is given, so both surfaces move one instance. */
  controls: controlPorts,
  /**
   * The chat's tools over MCP, for an agent rather than for a person. Off unless the operator
   * said otherwise; it takes the `chat.ctx` below rather than a context of its own.
   */
  adminMcp: {
    enabled: cfg.admin_mcp.enabled,
    ...(cfg.admin_mcp.token ? { token: cfg.admin_mcp.token } : {}),
    readOnly: cfg.admin_mcp.read_only,
  },
  chat: {
    threads: chatThreads,
    ...(chatPrompt ? { template: chatPrompt } : {}),
    context: async () => (await chatContext.read()).text,
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
      /**
       * The rubric, its history, and the store repo it is supposed to track.
       *
       * The same three objects the Protocols page is served from, so an edit made by
       * conversation is written, recorded and logged exactly as one made in the editor —
       * `domain/protocoledit.ts` is the single path both take. `storedoc` is what makes
       * "is this still current?" answerable rather than inferable: it reads the store's own
       * CONTRIBUTING.md at the ref this instance audits against.
       */
      protocols,
      revisions,
      storedoc,
      /**
       * The instance's own settings — the cadence, the two safety switches, the bench guard.
       *
       * The same `ControlPorts` the routes take, so "change the re-audit window to 14 days"
       * asked in the chat and typed on the Automation page are the same write, logged the
       * same way. What it cannot reach is anything read once at boot: the set is
       * `domain/controls.ts`'s, and a value with no live reader is deliberately not in it.
       */
      controls: controlPorts,
      /**
       * The same bundle `POST /trials` uses, so a trial started by conversation is written,
       * logged and dispatched identically to one started over HTTP. `onError` is the only
       * difference, and only because there is no request to attribute the failure to.
       */
      trials: {
        runner,
        trials,
        uploads,
        trialsRoot: cfg.trialsRoot,
        events,
        known: () => registry.list(),
        origins: cfg.origins,
        publicBaseUrl: cfg.trials.public_base_url,
        onError: (err: unknown, slug: string) => app.log.error({ err, slug }, 'trial failed'),
      },
      /**
       * Which repo an origin's apps belong to, so `open_trial` can inherit it. Nothing is
       * fetched from it — it is what the asset rule and CONTRIBUTING.md resolve against.
       */
      originRepo: (origin: string) => cfg.origins.find((o) => o.id === origin)?.repo,
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

if (seededProtocols.seeded.length > 0) {
  events.log({
    level: 'info',
    code: 'PROTOCOL_SEEDED',
    message: `The rubric was written into the data directory — ${seededProtocols.seeded.join(', ')}`,
    detail: { files: seededProtocols.seeded, dir: cfg.protocolsDir },
  });
}
if (seededKb.seeded.length > 0) {
  events.log({
    level: 'info',
    code: 'KB_SEEDED',
    message: `The knowledge base was written into the data directory — ${seededKb.seeded.join(', ')}`,
    detail: { files: seededKb.seeded, dir: cfg.kbDir },
  });
}
if (seededKb.failed) {
  // Softer than the rubric's: an audit with no reference material still runs and still judges.
  app.log.warn({ err: seededKb.failed }, 'could not seed the knowledge base into the data dir');
}
if (seededProtocols.failed) {
  // Not fatal: whatever is already on disk still loads, and a read-only data dir is a real
  // deployment. But a *first* boot that lands here has no rubric at all, which the Protocols
  // page and the first blocked run will both say.
  app.log.warn({ err: seededProtocols.failed }, 'could not seed the rubric into the data dir');
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
    // On the boot row because it is a surface, not a setting: an operator wondering how an
    // audit they did not start got started should be able to see, from the log alone, that
    // something outside the browser could ask for one.
    admin_mcp: cfg.admin_mcp.enabled ? (cfg.admin_mcp.read_only ? 'read-only' : 'on') : 'off',
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
// No argument: the cadence is the scheduler's, and a restored `tick_min` control has
// already changed it.
scheduler.start();
app.log.info(
  { armed: scheduler.armed, tick_min: scheduler.tickMinutes, runner: runner.enabled },
  scheduler.armed ? 'scheduler ARMED' : 'scheduler in dry-run',
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
