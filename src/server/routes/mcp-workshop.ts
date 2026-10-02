/**
 * The authoring surface — `POST /api/v1/mcp/workshop`.
 *
 * What a workshop session's agent may do, and the whole of it: read and edit one app's
 * working copy, read the store it belongs to, stage the copy for a bench, and end the session
 * with `submit` or `cannot`. Every tool takes the `session_token` its prompt carried; a token
 * is minted per session, dies with it, and names exactly one proposal.
 *
 * **A surface of its own, not more tools on `/mcp`**, and the separation is the point
 * (docs/auto-app-pr.md §3): the auditor's `tools/list` never offers `write_file`, and the
 * author's never offers `record_requirement`. There is no tool here that records a verdict,
 * starts a trial or touches GitHub — the test pins their absence.
 */

import type { FastifyPluginAsync } from 'fastify';

import type { Workshop } from '../services/workshop.js';
import { WorkshopError } from '../store/workshop.js';
import { StoreDocError } from '../services/storedoc.js';
import { dispatchRpc, toolError, toolText, type JsonRpcRequest, type McpToolDef } from './rpc.js';

const TOKEN = { session_token: { type: 'string', description: 'The token your prompt gave you.' } };

export const WORKSHOP_TOOLS: McpToolDef[] = [
  {
    name: 'list_files',
    description: 'Every file in the working copy of the app directory, with its size.',
    inputSchema: { type: 'object', properties: { ...TOKEN }, required: ['session_token'] },
  },
  {
    name: 'read_file',
    description: 'Read one file of the working copy. Use encoding base64 for binary files.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TOKEN,
        path: { type: 'string', description: 'Relative to the app directory, e.g. docker-compose.yml' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
      },
      required: ['session_token', 'path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or replace one file of the working copy. Plain relative paths only.',
    inputSchema: {
      type: 'object',
      properties: {
        ...TOKEN,
        path: { type: 'string' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'base64 for icons and other binaries.' },
      },
      required: ['session_token', 'path', 'content'],
    },
  },
  {
    name: 'delete_file',
    description: 'Remove one file from the working copy.',
    inputSchema: { type: 'object', properties: { ...TOKEN, path: { type: 'string' } }, required: ['session_token', 'path'] },
  },
  {
    name: 'read_store_file',
    description:
      'Read a file (or list a directory) of the store repository at the commit this proposal is built on — CONTRIBUTING.md, or another app as an example.',
    inputSchema: {
      type: 'object',
      properties: { ...TOKEN, path: { type: 'string', description: 'e.g. CONTRIBUTING.md or Apps/FileBrowser/docker-compose.yml' } },
      required: ['session_token', 'path'],
    },
  },
  {
    name: 'stage',
    description:
      'Publish the working copy as it is now and get back a store_url the leased demo host can install from. Stage again after every change you want to try.',
    inputSchema: { type: 'object', properties: { ...TOKEN }, required: ['session_token'] },
  },
  {
    name: 'submit',
    description:
      'You are finished. The summary is what the reviewer reads first: what you changed and why, citing the findings or release notes it answers. Ends the session.',
    inputSchema: {
      type: 'object',
      properties: { ...TOKEN, summary: { type: 'string' } },
      required: ['session_token', 'summary'],
    },
  },
  {
    name: 'cannot',
    description:
      'This cannot be done in a store listing. Say exactly why (no multi-arch image, needs code changes, …). Ends the session.',
    inputSchema: {
      type: 'object',
      properties: { ...TOKEN, reason: { type: 'string' } },
      required: ['session_token', 'reason'],
    },
  },
];

export interface McpWorkshopOptions {
  workshop?: Workshop;
}

const routes: FastifyPluginAsync<McpWorkshopOptions> = async (app, options) => {
  app.post<{ Body?: JsonRpcRequest }>('/mcp/workshop', async (req, reply) => {
    const out = await dispatchRpc(req.body ?? {}, {
      server: { name: 'touchstone-workshop', version: '1' },
      instructions:
        'Edit one app listing in a working copy, try it on the leased demo host, and end with submit or cannot. Every tool takes your session_token. There is no tool for a verdict: your work is audited afterwards, separately.',
      tools: () => WORKSHOP_TOOLS,
      call: async (name, args) => {
        const ws = options.workshop;
        if (!ws) return toolError('the workshop is not configured on this installation');
        const token = String(args.session_token ?? '');
        const path = String(args.path ?? '');
        const encoding = args.encoding === 'base64' ? 'base64' : 'utf8';
        try {
          switch (name) {
            case 'list_files':
              return toolText({ files: await ws.listFiles(token) });
            case 'read_file':
              return toolText({ path, encoding, content: await ws.readFile(token, path, encoding) });
            case 'write_file':
              return toolText({ written: await ws.writeFile(token, path, String(args.content ?? ''), encoding) });
            case 'delete_file':
              return toolText({ deleted: await ws.deleteFile(token, path) });
            case 'read_store_file':
              return toolText(await ws.readStoreFile(token, path));
            case 'stage':
              return toolText({
                ...(await ws.stage(token)),
                note: 'Open <demo host>/store/<app>?store=<store_url URL-encoded>. Stage again after each change.',
              });
            case 'submit':
              ws.submit(token, String(args.summary ?? ''));
              return toolText({ ended: 'submit', note: 'Thank you. Uninstall what you installed if you have not, then stop.' });
            case 'cannot':
              ws.cannotDo(token, String(args.reason ?? ''));
              return toolText({ ended: 'cannot', note: 'Recorded. Uninstall what you installed if you have not, then stop.' });
            default:
              return toolError(`no such tool: ${name}`);
          }
        } catch (err) {
          if (err instanceof WorkshopError || err instanceof StoreDocError) return toolError(err.message);
          throw err;
        }
      },
    });
    return out.body === undefined ? reply.code(out.code).send() : reply.code(out.code).send(out.body);
  });
};

export default routes;
