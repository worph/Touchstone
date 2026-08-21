/**
 * What the administrator chat is allowed to do.
 *
 * The shape is Newsdesk's: a tool declares a name, a description, a JSON-Schema input and a
 * handler, and the catalogue the model reads is *rendered from this array*. Nothing else
 * describes the tools, so the prompt and the dispatcher cannot drift apart — a tool the model
 * is told about is by construction a tool that exists.
 *
 * Every one is a thin wrapper over something the API already does; the chat is a way of
 * reaching the app by conversation, not a second implementation of it.
 *
 * **Five of the six read, and only one acts.** The chat began with three tools, two of which
 * described the *live process* — `runner.status()`, the ledger — and that was the wrong half
 * of the app to know about. An audit takes minutes, a turn takes seconds, and `tsx watch`
 * restarts the process on any edit; so by the time the operator asked what came of a run,
 * the only thing the chat could see was gone, and it answered "nothing yet" over an archive
 * holding ten assays. `get_subject`, `get_fix_brief`, `list_activity` and `get_schedule`
 * read what is written down instead — the report frontmatter, the log, the backlog — which
 * is durable, is what the pages show, and is what the question was actually about.
 *
 * **There is no tool that writes a verdict, and there will not be one** — the same rule that
 * governs `routes/mcp.ts`. The moment a model can post an outcome, the protocol's gate stops
 * being a gate. `run_assay` starts an audit; what that audit concludes is the runner's to
 * record. Reading more does not weaken that rule: invariant 6 is about writes, and the read
 * surface being thin was never an argument, only an accident of what got built first.
 */

import { outcomeClause, type EventLevel, type EventRecord } from '../../shared/activity.js';
import { asSubjectKey, subjectName, type SubjectKey } from '../../shared/subject.js';
import type { AssayRecord, Section } from '../../shared/types.js';
import { buildFixReport } from '../domain/fixreport.js';
import { LEGS, subjectHallmark, subjectNames, type LegState } from '../domain/hallmark.js';
import { recordsForSubject, type AssayStore } from '../domain/store.js';
import { ambiguousMessage, resolveSubjectKey } from '../domain/subjects.js';
import type { Runner } from '../runner/index.js';
import type { Scheduler } from '../scheduler/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import type { RunLedger } from '../services/ledger.js';
import type { AlertStore } from '../services/alerts.js';
import type { EventLog } from '../services/events.js';
import type { PortProber } from '../services/ports.js';
import type { BenchProber } from '../services/bench.js';
import { coverageOf } from '../services/ledger.js';

export interface ChatToolContext {
  runner?: Runner;
  registry?: SubjectRegistry;
  ledger?: RunLedger;
  alerts?: AlertStore;
  ports?: PortProber;
  prober?: BenchProber;
  /** The archive. Absent means the read tools say so rather than answering emptily. */
  store?: AssayStore;
  events?: EventLog;
  scheduler?: Scheduler;
  /**
   * The conversation this call belongs to, set per turn by `runTurn`.
   *
   * Carried so a run started here can report back into the thread that asked for it. It is
   * not an argument the model supplies and there is no tool that takes one: a turn may only
   * write into its own conversation.
   */
  threadId?: string;
  /** How a started run is actually dispatched — the same path `POST /assays` takes. */
  startAssay?: (job: { subject: SubjectKey }, opts?: { threadId?: string }) => void;
}

export interface ChatToolResult {
  text: string;
  /** True when the call could not do what was asked. The row is kept either way. */
  failed?: boolean;
}

export interface ChatTool {
  name: string;
  description: string;
  /**
   * True for the one tool that makes something happen rather than reporting what already did.
   *
   * The chat itself does not read this — a turn may call everything in the registry. It exists
   * because the same registry is served over MCP (`routes/mcp-admin.ts`), where the caller is
   * not necessarily the operator sitting in front of the app, and an installation that wants
   * that surface to be answers-only needs the split to be a property of the tool rather than a
   * list of names kept somewhere else and forgotten when a second write tool is added.
   */
  writes?: boolean;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  handler: (input: Record<string, unknown>, ctx: ChatToolContext) => Promise<ChatToolResult>;
}

function ok(text: string): ChatToolResult {
  return { text };
}

function failed(text: string): ChatToolResult {
  return { text, failed: true };
}

/** Failed requirements quoted inline before the tool points at `get_fix_brief` instead. */
const MAX_FAILED = 8;

/** Backlog rows a turn is shown. Past this it is reading a table, not an answer. */
const QUEUE_ROWS = 10;

const ACTIVITY_LIMIT = 30;
const ACTIVITY_MAX = 200;

const EVENT_LEVELS: EventLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Which subject somebody means, resolved the way every other entry point resolves it.
 *
 * The archive first, then the registry — because "not in the archive" is not "not a subject":
 * an app that has never been assayed is in the registry and in no report, and it is exactly
 * the one an operator asks about. `routes/index.ts` does the same two passes for the same
 * reason; both call `resolveSubjectKey`, so there is still one matcher.
 *
 * Returns a `ChatToolResult` on failure so a caller can hand it straight back — a refusal the
 * model can act on ("call list_subjects"), not an exception.
 */
function locate(
  ctx: ChatToolContext,
  raw: string,
): { key: SubjectKey; records: readonly AssayRecord[] } | ChatToolResult {
  const subject = raw.trim();
  if (!subject) return failed('That needs an app name.');

  const store = ctx.store;
  const inArchive = resolveSubjectKey(subject, store ? subjectNames(store.all()) : []);
  if (inArchive.kind === 'ambiguous') {
    return failed(`${ambiguousMessage(subject, inArchive.candidates)}. Call list_subjects to see the ids.`);
  }
  if (inArchive.kind === 'ok' && store) {
    return { key: inArchive.key, records: recordsForSubject(store, inArchive.key) };
  }

  const inRegistry = resolveSubjectKey(subject, ctx.registry?.list() ?? []);
  if (inRegistry.kind === 'ambiguous') {
    return failed(`${ambiguousMessage(subject, inRegistry.candidates)}. Call list_subjects to see the ids.`);
  }
  if (inRegistry.kind === 'ok') return { key: inRegistry.key, records: [] };

  return failed(
    store
      ? `There is no subject called "${subject}". Call list_subjects to see the names.`
      : `There is no archive wired up, so nothing can be read about "${subject}".`,
  );
}

function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * One section of one subject, as sentences.
 *
 * `blocked` is spelled out as infra rather than as a result, every time — invariant 4. A model
 * shown `functional: blocked` beside `static: non-compliant` will otherwise report two
 * failures, and one of them is not the app's.
 */
function describeSection(id: Section, state: LegState): string[] {
  const current = state.current;
  if (!current) return [`${id}: never assayed.`];

  const meta = current.meta;
  const lines: string[] = [];

  if (meta.status === 'blocked') {
    lines.push(
      `${id}: blocked — ${meta.blocked_reason ?? 'no reason recorded'} (${meta.finished_at}). ` +
        'Infra prevented the assay; nothing was decided about the app.',
    );
  } else if (meta.status === 'running') {
    lines.push(`${id}: an assay started ${meta.started_at} and has no recorded end.`);
  } else {
    lines.push(
      `${id}: ${meta.verdict ?? 'no verdict recorded'}, top severity ${meta.top_severity}, ` +
        `risk ${meta.risk_score} — judged by ${meta.standard} v${meta.standard_version}, finished ${meta.finished_at}.`,
    );
    const cov = meta.coverage;
    if (cov) {
      lines.push(
        `  ${cov.verified} of ${cov.applicable} requirements settled — ` +
          `${cov.passed} passed, ${cov.failed} failed, ${cov.unverified} unverified, ${cov.not_applicable} not applicable.`,
      );
    }
    const failures = (meta.requirements ?? []).filter((r) => r.verdict === 'fail');
    for (const req of failures.slice(0, MAX_FAILED)) {
      lines.push(
        `  ✗ ${req.id}${req.severity ? ` (${req.severity})` : ''}` +
          (req.requirement ? ` — ${oneLine(req.requirement)}` : ''),
      );
    }
    if (failures.length > MAX_FAILED) {
      lines.push(`  …and ${failures.length - MAX_FAILED} more failed — get_fix_brief has all of them.`);
    }
  }

  // A newer blocked or running assay does not retract the verdict the subject still carries.
  if (meta.status !== 'done' && state.hallmark) {
    const stood = state.hallmark.meta;
    lines.push(
      `  The verdict it still carries is ${stood.verdict} (risk ${stood.risk_score}), from ${stood.finished_at}.`,
    );
  }
  lines.push(`  Report: ${current.path}`);
  return lines;
}

function describeEvent(event: EventRecord): string {
  return (
    `${event.at} ${event.level} ${event.code}` +
    (event.subject ? ` [${subjectName(event.subject)}${event.section ? `/${event.section}` : ''}]` : '') +
    ` — ${event.message}`
  );
}

export const CHAT_TOOLS: ChatTool[] = [
  {
    name: 'list_subjects',
    description:
      'The apps Touchstone knows about, from the AppStore registry. Call this when the operator names an app so you use its exact name — "filebrowser" is FileBrowser, and an audit started under the wrong spelling audits nothing.',
    inputSchema: {
      type: 'object',
      properties: {
        contains: { type: 'string', description: 'Optional case-insensitive filter.' },
      },
    },
    handler: async (input, ctx) => {
      const all = ctx.registry?.list() ?? [];
      if (all.length === 0) return failed('The subject registry is empty — it has not been read yet.');
      const needle = String(input.contains ?? '').toLowerCase();
      const hits = needle ? all.filter((s) => s.toLowerCase().includes(needle)) : all;
      if (hits.length === 0) return failed(`No subject matches "${input.contains}". There are ${all.length} in total.`);
      return ok(hits.join('\n'));
    },
  },

  {
    name: 'get_status',
    description:
      'What Touchstone is doing right now: the audit in flight and how far it has got, the last one to finish, open alerts, and whether the agent, the browser and the demo pool are answering. Needs no inference and works when everything else is broken — call it before guessing.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_input, ctx) => {
      const lines: string[] = [];
      const status = ctx.runner?.status();

      if (!ctx.runner?.enabled) lines.push('The runner is switched off, so no audit can start.');
      if (status?.running) {
        const live = ctx.ledger?.live();
        const cov = live ? coverageOf(live.requirements) : null;
        lines.push(
          `Running: ${status.running.subject}${status.running.sections?.length ? ` (${status.running.sections.join(' + ')})` : ''}, started ${status.running.started_at}` +
            (cov ? ` — ${cov.verified} of ${cov.applicable} requirements settled so far.` : '.'),
        );
      } else {
        lines.push('No audit is running.');
      }

      /**
       * In-memory, and only since this process started: a restart empties it while the
       * archive keeps every assay. So say where it came from and where the durable answer
       * is, or a turn reads "no last run" as "nothing has ever been audited".
       */
      if (status?.last) {
        lines.push(
          `Last finished in this process: ${subjectName(status.last.subject)} at ${status.last.finished_at} — ` +
            `${outcomeClause(status.last.outcome)}.`,
        );
      } else {
        lines.push(
          'Nothing has finished since this process started — which is not the same as nothing having been audited. ' +
            'get_subject reads the archive, and list_activity the log; both survive a restart.',
        );
      }

      const open = ctx.alerts?.openAlerts() ?? [];
      lines.push(
        open.length === 0
          ? 'No open alerts.'
          : `Open alerts: ${open.map((a) => a.title).join('; ')}.`,
      );

      for (const p of ctx.ports?.list() ?? []) lines.push(`Port ${p.name} (${p.kind}): ${p.status}.`);
      const benches = ctx.prober?.list() ?? [];
      if (benches.length > 0) {
        lines.push(
          `Demo pool: ${ctx.prober?.leasable().length ?? 0} of ${benches.length} usable — ` +
            benches.map((b) => `${b.name} ${b.status}`).join(', ') +
            '.',
        );
      }
      return ok(lines.join('\n'));
    },
  },

  {
    name: 'run_assay',
    writes: true,
    description:
      'Start an audit of one app. It returns as soon as the audit has STARTED — a real audit takes minutes, far longer than this conversation will wait, so do not expect a verdict here and do not call this twice hoping for one. The operator is notified when it finishes. An audit covers every section of the protocol; a section that needs something unavailable — a demo instance, a browser — is not attempted and is recorded as blocked, which never counts against the app.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'The app name, exactly as list_subjects gives it.' },
      },
      required: ['subject'],
    },
    handler: async (input, ctx) => {
      const subject = String(input.subject ?? '').trim();
      if (!subject) return failed('run_assay needs a subject.');

      const runner = ctx.runner;
      if (!runner) return failed('No runner is wired, so nothing can be audited.');
      if (!runner.enabled) {
        return failed('The runner is switched off — set runner.enabled in config.yaml. Nothing was started.');
      }
      if (runner.busy) {
        const running = runner.status().running;
        return failed(
          `An audit of ${running?.subject ?? 'another app'} is already running, and there is one agent. Nothing was started; try again when it finishes.`,
        );
      }

      // Resolve against the registry so a near-miss becomes a correction rather than an
      // audit of a name that does not exist. The same matcher the HTTP routes use — one
      // definition, so the chat and the button cannot disagree about what a name means.
      //
      // Note what is deliberately absent: there is no repo or ref parameter here, and there
      // must not be. The model may say *which* subject, never *where it comes from*. That is
      // invariant 6's reasoning one step on — the registry is the one surface a model reaches,
      // and repo+ref is the single input that would turn "audit an app" into "run `gh` against
      // a URL of the model's choosing", with the result treated as data inside an audit prompt.
      const known = ctx.registry?.list() ?? [];
      const resolved = resolveSubjectKey(subject, known);
      if (resolved.kind === 'ambiguous') {
        return failed(
          `${ambiguousMessage(subject, resolved.candidates)}. Call list_subjects to see the ids.`,
        );
      }
      if (known.length > 0 && resolved.kind !== 'ok') {
        return failed(`There is no subject called "${subject}". Call list_subjects to see the names.`);
      }

      const key = resolved.kind === 'ok' ? resolved.key : asSubjectKey(subject);
      // The thread comes from the turn, not from the model — when the audit ends, minutes
      // after this conversation has moved on, it reports back into the conversation that
      // asked for it. Without that the chat has no memory of work it started, and the
      // operator has to ask a second time to find out what it did.
      ctx.startAssay?.({ subject: key }, ctx.threadId ? { threadId: ctx.threadId } : undefined);
      return ok(
        `Started an audit of ${subjectName(key)}. It runs in the background; the operator gets a notification when it finishes.`,
      );
    },
  },

  {
    name: 'get_subject',
    description:
      'What the archive says about one app: the hallmark it carries, section by section — verdict, top severity, risk, which standard version judged it, when it finished, and which requirements failed. This reads the **record on disk**, so it answers after a run has ended, after a restart, and about an audit somebody else started. `get_status` is what is happening now; this is what was decided. When the operator asks how an app did, or what came of a run, this is the tool.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'The app name, exactly as list_subjects gives it.' },
      },
      required: ['subject'],
    },
    handler: async (input, ctx) => {
      const found = locate(ctx, String(input.subject ?? ''));
      if ('text' in found) return found;

      const { state, legs } = subjectHallmark(found.key, found.records);
      const lines = [
        `${state.label} (${state.origin}) — total risk ${state.risk}, ` +
          (state.age_days === null
            ? 'never assayed.'
            : `most recent assay ${state.age_days} day(s) old.`),
      ];

      // The two the Overview names first, then whatever else the protocol declared — the
      // order a person reading the table would expect, rather than the alphabet.
      const ids = [...LEGS, ...Object.keys(legs).filter((id) => !LEGS.includes(id))].filter(
        (id) => legs[id],
      );
      const known = ids.filter((id) => legs[id]?.current);
      if (known.length === 0) {
        lines.push('It is in the registry and nothing more: no assay of it exists yet.');
        return ok(lines.join('\n'));
      }
      for (const id of ids) lines.push(...describeSection(id, legs[id]!));
      return ok(lines.join('\n'));
    },
  },

  {
    name: 'get_fix_brief',
    description:
      'The findings themselves, composed for whoever has to fix the app: every failed requirement with its severity, the evidence the assay recorded, and the remedy it proposed — or, where it proposed none, the fact that it did not. Markdown, the same document `GET /subjects/:name/fix.md` serves. Call it when the operator asks *why* an app failed or what to do about it; `get_subject` is the summary, this is the detail.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'The app name, exactly as list_subjects gives it.' },
      },
      required: ['subject'],
    },
    handler: async (input, ctx) => {
      const found = locate(ctx, String(input.subject ?? ''));
      if ('text' in found) return found;

      const { state } = subjectHallmark(found.key, found.records);
      const markdown = buildFixReport({
        subject: state.label,
        sections: Object.values(state.sections)
          .filter((rec): rec is NonNullable<typeof rec> => Boolean(rec))
          .map((rec) => ({ meta: rec.meta, path: rec.path })),
      });
      // The route answers 404 here, and for the same reason: an empty brief would read as a
      // clean bill of health, which is the one thing "no assay" does not mean.
      if (!markdown) {
        return failed(
          `There is no assay of ${state.label} to brief anyone on. get_subject says what it does and does not have.`,
        );
      }
      return ok(markdown);
    },
  },

  {
    name: 'list_activity',
    description:
      'The log of what Touchstone has actually done, oldest first — audits starting and finishing, scheduler ticks, alerts, restarts. It is the only way to see how a run *ended*, including one cut short by a restart, and unlike the live status it survives one. Use it when the operator asks what happened, or when an audit they expected a result from appears to have gone missing.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Only rows about this app. Optional.' },
        level: {
          type: 'string',
          description: 'Least severe level to include: debug, info, warn or error. Defaults to info.',
        },
        limit: { type: 'number', description: `Rows to return, at most ${ACTIVITY_MAX}. Defaults to ${ACTIVITY_LIMIT}.` },
      },
    },
    handler: async (input, ctx) => {
      const log = ctx.events;
      if (!log) return failed('No event log is wired, so there is no record of what happened.');

      const rawLevel = String(input.level ?? '').toLowerCase();
      if (rawLevel && !EVENT_LEVELS.includes(rawLevel as EventLevel)) {
        return failed(`"${input.level}" is not a level. Use one of: ${EVENT_LEVELS.join(', ')}.`);
      }
      const level = (rawLevel || 'info') as EventLevel;

      // A subject filter is matched against the key the log actually writes, so "filebrowser"
      // finds `yundera~FileBrowser` rather than silently matching nothing.
      let subject: string | undefined;
      const asked = String(input.subject ?? '').trim();
      if (asked) {
        const found = locate(ctx, asked);
        if ('text' in found) return found;
        subject = found.key;
      }

      const limit = Math.min(Math.max(Number(input.limit) || ACTIVITY_LIMIT, 1), ACTIVITY_MAX);
      const rows = log
        .query({ level, limit, ...(subject ? { subject } : {}) })
        // `query` answers newest first, for a page that appends at the top. A turn reads it
        // as a story, so hand it back in the order it happened.
        .reverse();

      if (rows.length === 0) {
        return ok(
          subject
            ? `Nothing at ${level} or above about ${subjectName(subject)} is in the log.`
            : `Nothing at ${level} or above is in the log.`,
        );
      }
      return ok(rows.map(describeEvent).join('\n'));
    },
  },

  {
    name: 'get_schedule',
    description:
      'What the automatic loop thinks: whether it is armed, when it next decides, what the cooldown is, and the backlog in the order it would be worked. Call it when the operator asks why nothing is running, when an app will next be audited, or what is next.',
    inputSchema: { type: 'object', properties: {} },
    handler: async (_input, ctx) => {
      const scheduler = ctx.scheduler;
      if (!scheduler) return failed('No scheduler is wired, so nothing is being driven automatically.');

      const snap = scheduler.snapshot();
      const lines = [
        snap.armed
          ? `Automatic mode is on (${snap.armed_source === 'override' ? 'switched on from the Automation page' : 'from config.yaml'}).`
          : `Automatic mode is off (${snap.armed_source === 'override' ? 'switched off from the Automation page' : 'from config.yaml'}), so the loop decides every tick and claims nothing.`,
      ];
      if (ctx.runner && !ctx.runner.enabled) {
        lines.push('The runner is switched off as well, so nothing would run even if it were armed.');
      }
      if (snap.last_tick) lines.push(`Last decided ${snap.last_tick.at}: ${snap.last_tick.decision.reason}.`);
      if (snap.next_tick_at) lines.push(`Next decision at ${snap.next_tick_at}.`);
      if (snap.cooldown_left_min > 0) {
        lines.push(`Cooling down for another ${snap.cooldown_left_min} minute(s) after the last audit.`);
      }

      const queue = await scheduler.previewQueue();
      const eligible = queue.filter((row) => row.position !== undefined);
      if (eligible.length === 0) {
        lines.push('The backlog is empty — nothing is due.');
      } else {
        lines.push(`Backlog, in the order it would be worked (${eligible.length} due of ${queue.length} known):`);
        for (const row of eligible.slice(0, QUEUE_ROWS)) {
          lines.push(
            `  ${row.position}. ${subjectName(row.subject)} — ` +
              // `never` already says it; repeating the state as well reads as a stutter.
              (row.days === undefined
                ? 'never audited'
                : `${row.state}, ${row.days} day(s) since its last`) +
              (row.try_n > 1 ? `, try ${row.try_n}` : '') +
              '.',
          );
        }
        if (eligible.length > QUEUE_ROWS) lines.push(`  …and ${eligible.length - QUEUE_ROWS} more.`);
      }
      return ok(lines.join('\n'));
    },
  },
];

export function chatTool(name: string): ChatTool | undefined {
  return CHAT_TOOLS.find((t) => t.name === name);
}
