/**
 * The authoring surface — and above all what it does **not** offer.
 *
 * The workshop's whole safety argument is that the author cannot judge its own work
 * (docs/auto-app-pr.md §3). On this surface that is a property of the tool list, so it is
 * pinned here: no verdict, no trial, no GitHub. And the chat's `set_control`, which the admin
 * MCP also serves, must not be able to arm the workshop or raise its quota.
 */

import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { CHAT_TOOLS } from '../chat/registry.js';
import { CONTROLS, isOperatorOnly } from '../domain/controls.js';
import routes, { WORKSHOP_TOOLS } from './mcp-workshop.js';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method, params });

describe('the authoring surface', () => {
  it('offers editing and ending, and nothing that judges, trials or publishes', () => {
    const names = WORKSHOP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(['cannot', 'delete_file', 'list_files', 'read_file', 'read_store_file', 'stage', 'submit', 'write_file']);
    for (const banned of [/record/, /verdict/, /trial/, /assay/, /pull|merge|commit|branch|github/i]) {
      expect(names.some((n) => banned.test(n))).toBe(false);
    }
  });

  it('refuses a token it never minted', async () => {
    app = Fastify();
    const calls: string[] = [];
    await app.register(routes, {
      workshop: {
        listFiles: async (t: string) => {
          calls.push(t);
          throw new (await import('../store/workshop.js')).WorkshopError('unknown or expired session_token');
        },
      } as never,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/mcp/workshop',
      payload: rpc('tools/call', { name: 'list_files', arguments: { session_token: 'nope' } }),
    });
    const body = res.json() as { result: { isError?: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0]!.text).toContain('unknown or expired');
  });

  it('says it is not configured rather than failing, with no workshop', async () => {
    app = Fastify();
    await app.register(routes, {});
    const list = await app.inject({ method: 'POST', url: '/mcp/workshop', payload: rpc('tools/list') });
    expect((list.json() as { result: { tools: unknown[] } }).result.tools).toHaveLength(WORKSHOP_TOOLS.length);
    const call = await app.inject({
      method: 'POST',
      url: '/mcp/workshop',
      payload: rpc('tools/call', { name: 'stage', arguments: { session_token: 'x' } }),
    });
    expect(JSON.stringify(call.json())).toContain('not configured');
  });
});

describe('who may move the workshop', () => {
  it('its switch and its quota are operator-only', () => {
    expect(isOperatorOnly('workshop.armed')).toBe(true);
    expect(isOperatorOnly('workshop.prs_per_day')).toBe(true);
    expect(isOperatorOnly('scheduler.armed')).toBe(false);
    expect(CONTROLS.filter((c) => c.key.startsWith('workshop.')).length).toBe(2);
  });

  it('the chat refuses them, so the admin MCP does too', async () => {
    const tool = CHAT_TOOLS.find((t) => t.name === 'set_control')!;
    const out = await tool.handler({ key: 'workshop.armed', value: true }, { controls: {} });
    expect(out.failed).toBe(true);
    expect(out.text).toContain('only be changed by a person');
  });

  it('the only workshop tool the chat holds reads', () => {
    const ws = CHAT_TOOLS.filter((t) => /workshop|proposal|pull/i.test(t.name));
    expect(ws.map((t) => [t.name, t.writes ?? false])).toEqual([['get_workshop', false]]);
  });
});
