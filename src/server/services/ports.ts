/**
 * The ports — every external thing Touchstone depends on, and whether it is actually there.
 *
 * There are three, and until now only one of them was visible. The bench pool had a prober,
 * an alert and a row on the page; the **agent** and the **browser** had a line in
 * `config.yaml` and nothing else. That asymmetry is a bug in its own right: an audit needs
 * all three, and a dependency you cannot see the state of is one you find out about from a
 * failed run.
 *
 * | port | what it is | what breaks without it |
 * | --- | --- | --- |
 * | `agent` | Claude Code, direct or through a Beacon aggregator | every assay |
 * | `browser` | our own `browser-mcp` sidecar, §5.4 | the functional leg only |
 * | bench | the demo instances — `services/bench.ts`, which keeps its own prober | the functional leg only |
 *
 * The probe starts the same for both: `tools/list` over MCP. It is the honest one, because it
 * is the surface the work actually uses — `browser-mcp` serves a landing page on `/health`
 * that answers `200` whether or not Chrome is reachable, which is precisely the kind of green
 * light this codebase has been burned by twice.
 *
 * For a **browser** it is not sufficient, which is the third burn. On 2026-08-24 the sidecar's
 * `stop()` failed to reap Chrome and every relaunch bound nothing, leaving four Chromes on one
 * profile and the CDP port held by an orphan: `tools/list` kept answering — the MCP wrapper
 * was fine — while every call through it timed out on `Network.enable`. Six audits were
 * dispatched into that and came back errored, which invariant 4 exists to forbid: infra must
 * make a section `blocked`, never a verdict. So a browser gets a second, liveness sub-probe —
 * `browserLiveness` below — and only a **positive** wedge signal downgrades it, because a
 * browser endpoint that is not our sidecar (an aggregator, say) has no such endpoints and
 * "cannot tell" must not read as "broken".
 */

import path from 'node:path';

import { readJson, writeJsonAtomic } from '../store/state.js';
import type { EventLog } from './events.js';

export type PortKind = 'agent' | 'browser';

export type PortStatus = 'healthy' | 'unreachable' | 'unconfigured' | 'unknown';

export interface PortConfig {
  name: string;
  kind: PortKind;
  url: string;
  /** For the agent: the tool the runner will call, so the probe can say it is really there. */
  expectTool?: string;
  enabled?: boolean;
}

export interface PortHealth {
  name: string;
  kind: PortKind;
  url: string;
  status: PortStatus;
  detail?: string;
  /** How many tools the endpoint offers. A surface with none is not usable. */
  tools?: number;
  /** Whether `expectTool` was among them. `undefined` when nothing was expected. */
  has_expected?: boolean;
  latency_ms?: number;
  probed_at?: string;
  healthy_at?: string;
}

export interface ProbeResult {
  status: Exclude<PortStatus, 'unknown'>;
  detail?: string;
  tools?: number;
  hasExpected?: boolean;
  latencyMs: number;
}

/**
 * Ask an MCP endpoint what it can do.
 *
 * Deliberately dependency-free and deliberately not the client the runner uses: health has
 * to be able to report on a broken port rather than fail with it.
 */
export async function probeMcp(
  port: PortConfig,
  timeoutMs = 8000,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  if (!port.url) return { status: 'unconfigured', detail: 'no url in config.yaml', latencyMs: 0 };

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(port.url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const latencyMs = Date.now() - started;
    const text = await res.text();
    if (!res.ok) {
      return { status: 'unreachable', detail: `HTTP ${res.status}`, latencyMs };
    }

    const names = toolNames(text);
    if (names === null) {
      return { status: 'unreachable', detail: 'answered, but not with an MCP tool list', latencyMs };
    }
    if (names.length === 0) {
      // Reachable and useless are different from reachable and working, and the difference
      // matters: an empty surface will fail every call while looking up.
      return { status: 'unreachable', detail: 'the endpoint offers no tools', tools: 0, latencyMs };
    }
    const hasExpected = port.expectTool ? names.includes(port.expectTool) : undefined;
    if (hasExpected === false) {
      return {
        status: 'unreachable',
        detail: `${port.expectTool} is not on this endpoint`,
        tools: names.length,
        hasExpected,
        latencyMs,
      };
    }

    // The surface is there. For a browser that is only half the question — see the header.
    if (port.kind === 'browser') {
      const live = await browserLiveness(port.url, Math.min(timeoutMs, 4000), fetchImpl);
      if (live.wedged) {
        return {
          status: 'unreachable',
          detail: live.detail ?? 'the browser is not drivable',
          tools: names.length,
          hasExpected,
          latencyMs: Date.now() - started,
        };
      }
    }

    return {
      status: 'healthy',
      tools: names.length,
      hasExpected,
      latencyMs,
    };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      status: 'unreachable',
      detail: aborted ? `timed out after ${timeoutMs}ms` : String(err instanceof Error ? err.message : err),
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The sidecar's REST base, from the MCP endpoint we were configured with.
 *
 * `null` for any shape that is not `…/mcp`, which is the whole safety property: a browser
 * reached through a Beacon aggregator, or any endpoint that is not our `browser-mcp`, has no
 * `/api/status` to ask and must come back "cannot tell" rather than "broken".
 */
export function sidecarBase(mcpUrl: string): string | null {
  try {
    const u = new URL(mcpUrl);
    if (!/\/mcp\/?$/.test(u.pathname)) return null;
    u.pathname = u.pathname.replace(/\/mcp\/?$/, '');
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * Is the browser behind this MCP endpoint actually drivable?
 *
 * `tools/list` cannot answer that: it is served by the Node wrapper, which stays up and
 * cheerful while Chrome is unreachable underneath it. Two endpoints can:
 *
 * - **`/api/status`** does a real CDP round-trip. `running: false` on its own is *not* a
 *   fault — it is the normal state after the idle reaper has freed Chrome's RSS, and the next
 *   call relaunches it. Treating it as unreachable would block every functional section
 *   between runs, which is why this function exists rather than a one-line status check.
 * - **`/api/health`** reports Chrome's lifecycle, and **how much it can be trusted depends on
 *   the sidecar's age**, which is the whole shape of what follows.
 *
 * A sidecar that carries a `cdp` field in `/api/health` has confirmed the state against the
 * CDP port itself, and says `wedged` when it cannot: its `chrome` is an answer, and we take
 * it. One without that field only ever held a process handle up to the light, so `running`
 * meant "I have a child process", which for eight days on one box was true of a Chrome that
 * answered nothing — `{"chrome":"running"}` beside `{"running":false}`, six audits dispatched
 * into it. For those, and only for those, the contradiction between the two endpoints is
 * inferred from outside.
 *
 * **The two endpoints do not answer the same question**, and reading them as though they did
 * is what made this wrong. `health.chrome` is about the *process* — up, and drivable.
 * `status.running` is about the *client* — whether it currently holds a page. On a
 * self-diagnosing sidecar `chrome: "running"` beside `running: false` is the ordinary state of
 * a browser that is up with no tab open: for the minute it is launching, and for the whole
 * gap between a run releasing its page and the idle reaper firing. Inferring a wedge from it
 * flapped `browser-1` down for ~30 minutes of every hour on 2026-08-31 and recorded fifteen
 * functional sections blocked against a browser that was working.
 *
 * Only a positive signal downgrades. Anything unreadable — a 404, a non-JSON body, an
 * endpoint that is not ours — is `wedged: false`, because a browser we cannot interrogate is
 * not the same as a browser we know is broken.
 */
export async function browserLiveness(
  mcpUrl: string,
  timeoutMs = 4000,
  fetchImpl: typeof fetch = fetch,
): Promise<{ wedged: boolean; detail?: string }> {
  const base = sidecarBase(mcpUrl);
  if (!base) return { wedged: false };

  const get = async (path: string): Promise<{ body: Record<string, unknown> | null; timedOut: boolean }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${base}${path}`, { signal: controller.signal });
      const text = await res.text();
      try {
        const parsed: unknown = JSON.parse(text);
        return { body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null, timedOut: false };
      } catch {
        return { body: null, timedOut: false };
      }
    } catch {
      return { body: null, timedOut: controller.signal.aborted };
    } finally {
      clearTimeout(timer);
    }
  };

  const [status, health] = await Promise.all([get('/api/status'), get('/api/health')]);

  // The wrapper answered `tools/list` a moment ago, so a status call that hangs is the
  // browser layer hanging rather than the box being away.
  if (status.timedOut) return { wedged: true, detail: 'the browser did not answer /api/status' };
  if (!status.body) return { wedged: false };

  const chrome = typeof health.body?.['chrome'] === 'string' ? (health.body['chrome'] as string) : null;
  const running = status.body['running'] === true;

  // Does this sidecar check CDP for itself? The `cdp` field is the marker, and it is read as
  // presence rather than value: `null` is what a self-diagnosing sidecar reports for a Chrome
  // that is off, and that is exactly a box we want to stop second-guessing.
  const selfDiagnosing = health.body !== null && 'cdp' in health.body;

  // The sidecar's own word for it, once it is new enough to say so.
  if (chrome === 'wedged') return { wedged: true, detail: 'the sidecar reports Chrome wedged' };

  // …and the same condition inferred from outside, on an image that cannot say it. Only
  // there: on a sidecar that does check CDP, this pair is a browser that is up with no page
  // open, which is the normal state between runs and says nothing about drivability.
  if (!selfDiagnosing && chrome === 'running' && !running) {
    return { wedged: true, detail: '/api/health says Chrome is running but nothing can be driven through it' };
  }
  if (chrome === 'failing') return { wedged: true, detail: 'Chrome is failing to launch' };

  return { wedged: false };
}

/** Tool names out of a JSON-RPC answer, SSE-framed or plain. `null` means it was neither. */
export function toolNames(payload: string): string[] | null {
  const candidates: string[] = [];
  for (const line of payload.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) candidates.push(t.slice(5).trim());
  }
  if (candidates.length === 0) candidates.push(payload);

  for (const raw of candidates.reverse()) {
    if (!raw) continue;
    try {
      const o = JSON.parse(raw) as { result?: { tools?: { name?: string }[] } };
      const tools = o?.result?.tools;
      if (Array.isArray(tools)) {
        return tools.map((x) => String(x?.name ?? '')).filter(Boolean);
      }
    } catch {
      /* try the next frame */
    }
  }
  return null;
}

export interface PortProberOptions {
  ports: PortConfig[];
  stateDir: string;
  events: EventLog;
  probeTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Probes each port, keeps `state/ports.json`, and logs only transitions.
 *
 * No alerts here on purpose. A bench outage pauses a queue and deserves a card; a port being
 * down is either the same thing said twice (no browser → the functional queue is already
 * paused by the bench gate) or it is total. Adding a third alert source would mean one outage
 * opening three cards, which is the thing alerts exist to stop.
 *
 * The total case *is* worth a card, and since 2026-08-31 it gets one — but from the **runner**,
 * as `agent.auth`, not from here. That is not a hedge: this prober asks `tools/list`, which a
 * Claude Code endpoint answers perfectly well while its own session is dead, so for three days
 * in August it reported the agent healthy beside audits that were failing to authenticate. A
 * dead session is only ever observable to the code making the call. The clause this comment
 * used to carry — "the failed assay says so with its own event" — was the other half of that
 * mistake: an event is not an alert, and the banner, the chat and `get_status` all read alerts.
 */
export class PortProber {
  private readonly file: string;
  private readonly opts: PortProberOptions;
  private health = new Map<string, PortHealth>();
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<PortHealth[]>;

  constructor(opts: PortProberOptions) {
    this.opts = opts;
    this.file = path.join(opts.stateDir, 'ports.json');
  }

  async load(): Promise<void> {
    const rows = await readJson<PortHealth[]>(this.file, []);
    if (Array.isArray(rows)) for (const row of rows) if (row?.name) this.health.set(row.name, row);
    for (const port of this.enabled()) {
      if (!this.health.has(port.name)) {
        this.health.set(port.name, { name: port.name, kind: port.kind, url: port.url, status: 'unknown' });
      }
    }
  }

  list(): PortHealth[] {
    return [...this.health.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Ports of one kind that answered last time. The runner leases out of this. */
  healthy(kind: PortKind): PortHealth[] {
    return this.list().filter((p) => p.kind === kind && p.status === 'healthy');
  }

  probeAll(): Promise<PortHealth[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.run().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.probeAll().catch((err) => console.error('port probe failed', err));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async flush(): Promise<void> {
    await this.inFlight;
  }

  private enabled(): PortConfig[] {
    return this.opts.ports.filter((p) => p.enabled !== false);
  }

  private async run(): Promise<PortHealth[]> {
    const ports = this.enabled();
    if (ports.length === 0) return this.list();
    const now = new Date().toISOString();

    const rows = await Promise.all(
      ports.map(async (port) => {
        const previous = this.health.get(port.name);
        const probe = await probeMcp(port, this.opts.probeTimeoutMs, this.opts.fetchImpl);
        const next: PortHealth = {
          name: port.name,
          kind: port.kind,
          url: port.url,
          status: probe.status,
          detail: probe.detail,
          tools: probe.tools,
          has_expected: probe.hasExpected,
          latency_ms: probe.latencyMs,
          probed_at: now,
          healthy_at: probe.status === 'healthy' ? now : previous?.healthy_at,
        };
        this.health.set(port.name, next);
        this.logTransition(previous, next);
        return next;
      }),
    );

    await writeJsonAtomic(this.file, this.list()).catch((err) =>
      console.error('could not write ports.json', err),
    );
    return rows;
  }

  /** Only what changed. A port down for two days is one event, not one every five minutes. */
  private logTransition(previous: PortHealth | undefined, next: PortHealth): void {
    if (previous?.status === next.status) return;
    if (next.status === 'unconfigured') return;

    if (next.status === 'healthy') {
      this.opts.events.log({
        level: 'info',
        code: 'PORT_HEALTHY',
        message:
          previous === undefined || previous.status === 'unknown'
            ? `The ${next.name} endpoint is answering`
            : `The ${next.name} endpoint is answering again`,
        detail: { port: next.name, kind: next.kind, tools: next.tools ?? 0 },
      });
      return;
    }

    this.opts.events.log({
      level: 'error',
      code: 'PORT_UNREACHABLE',
      message:
        next.kind === 'agent'
          ? 'The audit agent cannot be reached, so no audit can run'
          : `The ${next.name} endpoint is not answering`,
      detail: { port: next.name, kind: next.kind, url: next.url, error: next.detail ?? 'no response' },
    });
  }
}
