/**
 * What the administrator chat is allowed to do.
 *
 * The shape is Newsdesk's: a tool declares a name, a description, a JSON-Schema input and a
 * handler, and the catalogue the model reads is *rendered from this array*. Nothing else
 * describes the tools, so the prompt and the dispatcher cannot drift apart — a tool the model
 * is told about is by construction a tool that exists.
 *
 * Three of them, deliberately. Every one is a thin wrapper over something the API already
 * does; the chat is a way of reaching the app by conversation, not a second implementation
 * of it.
 *
 * **There is no tool that writes a verdict, and there will not be one** — the same rule that
 * governs `routes/mcp.ts`. The moment a model can post an outcome, the protocol's gate stops
 * being a gate. `run_assay` starts an audit; what that audit concludes is the runner's to
 * record.
 */

import { asSubjectKey, subjectName, type SubjectKey } from '../../shared/subject.js';
import { ambiguousMessage, resolveSubjectKey } from '../domain/subjects.js';
import type { Runner } from '../runner/index.js';
import type { SubjectRegistry } from '../store/registry.js';
import type { RunLedger } from '../services/ledger.js';
import type { AlertStore } from '../services/alerts.js';
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
  /** How a started run is actually dispatched — the same path `POST /assays` takes. */
  startAssay?: (job: { subject: SubjectKey }) => void;
}

export interface ChatToolResult {
  text: string;
  /** True when the call could not do what was asked. The row is kept either way. */
  failed?: boolean;
}

export interface ChatTool {
  name: string;
  description: string;
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

      if (status?.last) {
        const o = status.last.outcome;
        const how =
          o.kind === 'verdict'
            ? `${o.verdict} (risk ${o.risk})`
            : o.kind === 'blocked'
              ? `blocked — ${o.reason}`
              : o.kind === 'agent_busy'
                ? 'the agent was busy'
                : `failed — ${o.reason}`;
        lines.push(`Last finished: ${status.last.subject} at ${status.last.finished_at} — ${how}.`);
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
      ctx.startAssay?.({ subject: key });
      return ok(
        `Started an audit of ${subjectName(key)}. It runs in the background; the operator gets a notification when it finishes.`,
      );
    },
  },
];

export function chatTool(name: string): ChatTool | undefined {
  return CHAT_TOOLS.find((t) => t.name === name);
}
