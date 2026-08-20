import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EventLog } from './events.js';
import { PortProber, probeMcp, toolNames, type PortConfig } from './ports.js';

const AGENT: PortConfig = {
  name: 'agent',
  kind: 'agent',
  url: 'http://agent.example/mcp',
  expectTool: 'claude-code__query_claude',
};
const BROWSER: PortConfig = { name: 'browser-1', kind: 'browser', url: 'http://browser.example/mcp' };

/** The SSE framing Beacon and browser-mcp both answer `tools/list` with. */
function toolList(names: string[]): Response {
  const body = `event: message\ndata: ${JSON.stringify({
    result: { tools: names.map((name) => ({ name })) },
  })}\n\n`;
  return new Response(body, { status: 200 });
}

function answering(names: string[]): typeof fetch {
  return (async () => toolList(names)) as unknown as typeof fetch;
}

let dir: string;
let events: EventLog;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'touchstone-ports-'));
  events = new EventLog(dir);
});

afterEach(async () => {
  await events.flush();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('reading a tool list', () => {
  it('takes it out of an SSE frame', () => {
    expect(toolNames(`data: ${JSON.stringify({ result: { tools: [{ name: 'click' }] } })}`)).toEqual(['click']);
  });

  it('reads a plain JSON body too', () => {
    expect(toolNames(JSON.stringify({ result: { tools: [{ name: 'a' }, { name: 'b' }] } }))).toEqual(['a', 'b']);
  });

  /** `null` is "that was not an MCP answer", which is different from "no tools". */
  it('says nothing at all when the answer is not MCP', () => {
    expect(toolNames('<!DOCTYPE html><html>hello</html>')).toBeNull();
  });
});

describe('probing one port', () => {
  it('calls the MCP surface, not a health page', async () => {
    const calls: { url: string; body: string }[] = [];
    const probe = await probeMcp(BROWSER, 8000, (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return toolList(['click', 'fill']);
    }) as unknown as typeof fetch);

    expect(probe.status).toBe('healthy');
    expect(calls[0]?.url).toBe('http://browser.example/mcp');
    expect(calls[0]?.body).toContain('tools/list');
  });

  /**
   * `browser-mcp` serves a landing page on `/health` that answers 200 whether or not Chrome
   * can be reached. Probing the surface the work actually uses is the only honest check —
   * this codebase has been burned twice by an endpoint that answered while being useless.
   */
  it('does not accept an HTML page as a healthy endpoint', async () => {
    const probe = await probeMcp(BROWSER, 8000, (async () =>
      new Response('<!DOCTYPE html><html>Browser MCP</html>', { status: 200 })) as unknown as typeof fetch);
    expect(probe.status).toBe('unreachable');
    expect(probe.detail).toContain('not with an MCP tool list');
  });

  it('calls a surface with no tools unreachable rather than healthy', async () => {
    const probe = await probeMcp(BROWSER, 8000, answering([]));
    expect(probe.status).toBe('unreachable');
    expect(probe.tools).toBe(0);
  });

  it('checks the agent really offers the tool the runner will call', async () => {
    const wrong = await probeMcp(AGENT, 8000, answering(['some_other_tool']));
    expect(wrong.status).toBe('unreachable');
    expect(wrong.detail).toContain('claude-code__query_claude');

    const right = await probeMcp(AGENT, 8000, answering(['claude-code__query_claude']));
    expect(right.status).toBe('healthy');
    expect(right.hasExpected).toBe(true);
  });

  it('reads a refused connection as unreachable', async () => {
    const probe = await probeMcp(BROWSER, 8000, (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    expect(probe.status).toBe('unreachable');
  });

  it('says so rather than guessing when there is no url', async () => {
    expect((await probeMcp({ ...BROWSER, url: '' })).status).toBe('unconfigured');
  });
});

describe('the pool', () => {
  function prober(ports: PortConfig[], fetchImpl: typeof fetch): PortProber {
    return new PortProber({ ports, stateDir: dir, events, fetchImpl });
  }

  it('reports each port and lets the runner ask for a healthy browser', async () => {
    const p = prober([AGENT, BROWSER], answering(['claude-code__query_claude', 'click']));
    await p.probeAll();
    expect(p.healthy('browser').map((x) => x.name)).toEqual(['browser-1']);
    expect(p.healthy('agent')).toHaveLength(1);
  });

  it('offers no browser when the sidecar is down', async () => {
    const p = prober([BROWSER], (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    await p.probeAll();
    expect(p.healthy('browser')).toEqual([]);
  });

  it('logs a port going down once, not once per probe', async () => {
    const p = prober([BROWSER], (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    for (let i = 0; i < 6; i++) await p.probeAll();
    await events.flush();
    expect(events.query({ code: 'PORT_UNREACHABLE' })).toHaveLength(1);
  });

  it('says plainly when it is the agent that is gone', async () => {
    const p = prober([AGENT], (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch);
    await p.probeAll();
    await events.flush();
    expect(events.query({ code: 'PORT_UNREACHABLE' })[0]?.message).toContain('no audit can run');
  });

  it('keeps the last healthy time across a restart', async () => {
    const first = prober([BROWSER], answering(['click']));
    await first.probeAll();
    const healthyAt = first.list()[0]?.healthy_at;
    expect(healthyAt).toBeTruthy();

    const second = prober([BROWSER], (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch);
    await second.load();
    await second.probeAll();
    expect(second.list()[0]?.status).toBe('unreachable');
    expect(second.list()[0]?.healthy_at).toBe(healthyAt);
  });
});
