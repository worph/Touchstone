/**
 * `/mcp/admin` — the operator's tools, served to an agent.
 *
 * What is worth testing here is the boundary, not the tools: they are the chat's, tested where
 * the chat is. So — that a disabled installation serves no address at all, that the bearer is
 * checked when there is one, that `read_only` both hides `run_assay` *and* refuses it, and that
 * the envelope is the one a discovery client expects (a `202` for the notification, an
 * `isError` result rather than a transport failure). Every one of those is a way the surface
 * could be wider than the operator believes it is.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { DEFAULT_ORIGIN, subjectKey } from '../../shared/subject.js';
import { fixtureStore } from '../domain/fixtures.js';
import { CHAT_TOOLS } from '../chat/registry.js';
import routes from './index.js';
import type { AdminMcpOptions } from './mcp-admin.js';

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function serve(adminMcp: Omit<AdminMcpOptions, 'ctx' | 'events'>): Promise<FastifyInstance> {
  const instance = Fastify();
  await instance.register(routes, {
    prefix: '/api/v1',
    store: fixtureStore(),
    adminMcp,
    // The context the surface is handed: the chat's, verbatim. Nothing here is wired to a
    // runner, so `run_assay` refuses on its own terms rather than on this surface's.
    chat: {
      ctx: {
        store: fixtureStore(),
        registry: { list: () => [subjectKey(DEFAULT_ORIGIN, 'FileBrowser')] } as never,
      },
    },
  });
  await instance.ready();
  app = instance;
  return instance;
}

const rpc = async (
  instance: FastifyInstance,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) => instance.inject({ method: 'POST', url: '/api/v1/mcp/admin', payload: body, headers });

const call = (name: string, args: Record<string, unknown> = {}) => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'tools/call',
  params: { name, arguments: args },
});

/** The text of a tool result, and whether it was reported as a failure. */
function result(raw: string): { text: string; isError: boolean } {
  const parsed = JSON.parse(raw) as {
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  return {
    text: parsed.result?.content?.[0]?.text ?? '',
    isError: parsed.result?.isError === true,
  };
}

describe('off by default', () => {
  it('registers no route at all when disabled', async () => {
    const instance = await serve({ enabled: false });
    const res = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.statusCode).toBe(404);
  });
});

describe('the envelope', () => {
  it('answers initialize with a protocol version and a server name', async () => {
    const instance = await serve({ enabled: true });
    const res = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(body.result.protocolVersion).toBe('2024-11-05');
    expect(body.result.serverInfo.name).toBe('touchstone-admin');
  });

  it('answers the initialized notification 202 with no body, which is what a client waits for', async () => {
    const instance = await serve({ enabled: true });
    const res = await rpc(instance, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.statusCode).toBe(202);
    expect(res.body).toBe('');
  });

  it('reports an unknown tool as a result, not as a transport error', async () => {
    const instance = await serve({ enabled: true });
    const res = await rpc(instance, call('delete_everything'));
    expect(res.statusCode).toBe(200);
    expect(result(res.body).isError).toBe(true);
    expect(result(res.body).text).toMatch(/no such tool/);
  });
});

describe('the scope', () => {
  it('is the administrator chat’s registry, run_assay included', async () => {
    const instance = await serve({ enabled: true });
    const res = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (res.json() as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'list_subjects',
        'get_status',
        'get_subject',
        'get_fix_brief',
        'get_report',
        'get_board',
        'list_activity',
        'get_schedule',
        'run_assay',
      ]),
    );
  });

  it('answers a read, and the arguments reach the tool', async () => {
    const instance = await serve({ enabled: true });
    const found = await rpc(instance, call('list_subjects', { contains: 'file' }));
    expect(result(found.body).isError).toBe(false);
    expect(result(found.body).text).toContain('FileBrowser');

    const missing = await rpc(instance, call('list_subjects', { contains: 'nothing-like-this' }));
    expect(result(missing.body).isError).toBe(true);
  });

  /**
   * This used to bar `protocol` from the tool names as well, and dropping that is a deliberate
   * widening rather than a relaxed test. `edit_protocol` exists now, and what invariant 6
   * forbids is a model **writing a verdict** — which stays impossible here, and stays
   * impossible for a different reason than a name check: `ProtocolStore.save()` carries the
   * frontmatter over as bytes, so no caller of this surface can mint a section, name an
   * executor, or reach the gate. What it can do is rewrite prose, recorded as a revision with
   * a reason, and hidden entirely when `read_only` is set.
   */
  it('mints no verdict tool — the gate is not reachable from here', async () => {
    const instance = await serve({ enabled: true });
    const res = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (res.json() as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names.some((name) => /record|verdict|hallmark|compliant/.test(name))).toBe(false);
  });
});

describe('read_only', () => {
  /**
   * Every tool that acts, not a list of names kept here and forgotten. The registry marks its
   * own write tools, and this reads that mark — so a tool added with `writes: true` is covered
   * the day it lands, and one added *without* it shows up here as a failure rather than as a
   * surface an operator believed was answers-only.
   */
  const writers = CHAT_TOOLS.filter((tool) => tool.writes).map((tool) => tool.name);

  it('knows which tools act, and there is more than one', () => {
    expect(writers).toEqual(
      // `edit_protocol` is the one that changes what every *future* audit concludes, so an
      // installation that wanted this surface answers-only must not be served it.
      expect.arrayContaining(['run_assay', 'open_trial', 'run_trial', 'edit_protocol']),
    );
  });

  it('hides every tool that acts', async () => {
    const instance = await serve({ enabled: true, readOnly: true });
    const res = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (res.json() as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    for (const writer of writers) expect(names).not.toContain(writer);
    expect(names).toContain('list_subjects');
  });

  it('refuses them when asked for anyway — hidden is not absent', async () => {
    const instance = await serve({ enabled: true, readOnly: true });
    for (const writer of writers) {
      const res = await rpc(instance, call(writer, { subject: 'FileBrowser' }));
      expect(result(res.body).isError, `${writer} was served`).toBe(true);
      expect(result(res.body).text).toMatch(/no such tool/);
    }
  });

  it('still serves the reads that were added beside them', async () => {
    const instance = await serve({ enabled: true, readOnly: true });
    const res = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const names = (res.json() as { result: { tools: { name: string }[] } }).result.tools.map(
      (tool) => tool.name,
    );
    expect(names).toEqual(expect.arrayContaining(['get_report', 'get_board', 'get_trial']));
  });
});

describe('the bearer', () => {
  it('rejects a call without it when one is configured', async () => {
    const instance = await serve({ enabled: true, token: 'shibboleth' });
    const res = await rpc(instance, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts the one that matches', async () => {
    const instance = await serve({ enabled: true, token: 'shibboleth' });
    const res = await rpc(
      instance,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { authorization: 'Bearer shibboleth' },
    );
    expect(res.statusCode).toBe(200);
  });
});
