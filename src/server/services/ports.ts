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
 * The probe is the same for both: `tools/list` over MCP. It is the honest one, because it is
 * the surface the work actually uses — `browser-mcp` serves a landing page on `/health` that
 * answers `200` whether or not Chrome is reachable, which is precisely the kind of green
 * light this codebase has been burned by twice.
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
    return {
      status: hasExpected === false ? 'unreachable' : 'healthy',
      detail: hasExpected === false ? `${port.expectTool} is not on this endpoint` : undefined,
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
 * paused by the bench gate) or it is total (no agent → nothing runs, and the failed assay
 * says so with its own event). Adding a third alert source would mean one outage opening
 * three cards, which is the thing alerts exist to stop.
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
