/**
 * Watching the audit work — the browser sidecar, proxied under Touchstone's own origin.
 *
 * The run card already says *what* the agent has settled: the ledger records each requirement
 * as it decides it, and the phase track says where it is. What it cannot say is what the
 * **browser** is doing, which is where a functional audit actually spends its half hour — and
 * "stuck on a login page" and "installing, slowly" look identical from a progress counter.
 *
 * Two viewers, deliberately, copying Newsdesk's shape:
 *
 * - **The live tab** (`/browser/live/<pageId>/screencast`) — one socket per page, which is the
 *   right thing for "what is this audit looking at".
 * - **noVNC** (`/browser/vnc/…`) — break-glass, for the things that live *outside* the page and
 *   which a per-tab screencast structurally cannot show: a download prompt, a crashed tab, a
 *   dialog the automation is stuck behind.
 *
 * **This is the only door, and that is the point.** The sidecar publishes no port and (from
 * browser-mcp 1.1.7) does not announce itself to Beacon, so these routes are the sole way to
 * reach it. Which also means they are, precisely, remote control of a browser — so they live
 * under `/api/v1`, behind the same AppShield gate as every other operator route.
 *
 * ⚠️ **In development there is no gate.** The dev stack has no AppShield in front, so these
 * paths are open on localhost. That is the same exposure as the rest of the operator API in
 * dev and is stated here rather than left to be discovered, because unguarded this one is
 * worse than the others.
 */

import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

export interface BrowserRoutesOptions {
  /**
   * The sidecar's MCP endpoint, e.g. `http://touchstone-browser-1:9746/mcp`. The viewer
   * surfaces sit beside it on the same origin, so the `/mcp` suffix is trimmed off.
   */
  browserUrl?: string;
  /** The run in flight, so the tab list can be narrowed to the audit's own context. */
  runningSubject?: () => string | null;
}

/** `http://host:9746/mcp` → `http://host:9746`. */
export function browserBase(mcpUrl: string): string {
  return mcpUrl.replace(/\/+$/, '').replace(/\/mcp$/, '');
}

/**
 * The isolated context the prompt tells the agent to open — `functional-<APP>-audit`.
 *
 * Kept in step with `runner/prompt.ts` by hand, which is a seam worth naming: if the prompt's
 * wording changes, this filter silently stops matching and the panel falls back to showing
 * every tab rather than this audit's. It degrades to noise, never to a wrong tab.
 */
export function contextForSubject(appName: string): string {
  return `functional-${appName}-audit`;
}

const LIVE_PREFIX = '/browser/live';
const VNC_PREFIX = '/browser/vnc';

const routes: FastifyPluginAsync<BrowserRoutesOptions> = async (app, options) => {
  const base = options.browserUrl ? browserBase(options.browserUrl) : null;

  /**
   * The tabs the sidecar is holding.
   *
   * `subject` narrows to the running audit's own context when there is one — the box may be
   * driving other tabs, and a panel that showed them would be answering a different question
   * than the one the operator asked.
   */
  app.get<{ Querystring: { all?: string } }>('/browser/pages', async (request, reply) => {
    if (!base) return reply.code(503).send({ error: 'no browser sidecar configured' });

    let pages: BrowserPage[];
    try {
      const res = await fetch(`${base}/api/pages`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return reply.code(502).send({ error: `the browser answered ${res.status}` });
      pages = ((await res.json()) as { pages?: BrowserPage[] }).pages ?? [];
    } catch (err) {
      // Unreachable is a normal state — invariant 7: the app stays diagnosable with every
      // outbound port broken, so this is a row that says so rather than a 500.
      return reply.code(200).send({
        pages: [],
        unreachable: err instanceof Error ? err.message : String(err),
      });
    }

    const subject = options.runningSubject?.() ?? null;
    const context = subject ? contextForSubject(subject) : null;
    const mine = context ? pages.filter((p) => (p.owner ?? '') === context) : [];

    return {
      pages: request.query.all === '1' || mine.length === 0 ? pages : mine,
      context,
      /** Whether the list was narrowed, so the UI can say "all tabs" honestly. */
      filtered: mine.length > 0 && request.query.all !== '1',
      live_prefix: LIVE_PREFIX,
      vnc_url: `${VNC_PREFIX}/vnc.html?autoconnect=1&resize=scale&reconnect=1`,
    };
  });

  /**
   * A still of the browser's **screen**, for images without the per-tab screencast.
   *
   * `/api/pages/<id>/screencast` arrived in browser-mcp 1.1.6; 1.1.5 has only this. Two things
   * make it a fallback rather than the answer:
   *
   * - It captures the display, not a chosen tab, so on a busy sidecar it may not be showing the
   *   audit's page at all. Measured on 1.1.5: navigating a tab to a real page left the capture
   *   byte-identical to the blank one before it.
   * - It is **slow** — 11 s on an idle sidecar. Hence the 20 s ceiling below, and why the UI
   *   polls it far apart rather than pretending to stream.
   */
  app.get('/browser/screenshot', async (_request, reply) => {
    if (!base) return reply.code(503).send({ error: 'no browser sidecar configured' });
    try {
      const res = await fetch(`${base}/api/screenshot`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return reply.code(502).send({ error: `the browser answered ${res.status}` });
      return reply
        .type(res.headers.get('content-type') ?? 'image/png')
        // A still is stale the moment it is taken; caching one would make the panel lie.
        .header('cache-control', 'no-store')
        .send(Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
};

interface BrowserPage {
  pageId: string;
  owner: string | null;
  url: string;
  title: string;
  idleForMs?: number;
}

/**
 * The two proxies.
 *
 * Registered apart from the routes above because a proxy's upstream is fixed when it is
 * registered, and because a deployment with no sidecar should not pay to load a proxy stack it
 * will never use — which is every test that boots the app, and any install running without a
 * browser.
 */
export async function registerBrowserProxy(
  app: FastifyInstance,
  browserUrl: string | undefined,
): Promise<void> {
  if (!browserUrl) return;
  const upstream = browserBase(browserUrl);

  const { default: httpProxy } = await import('@fastify/http-proxy');

  // The live view: one socket per tab, frames out and input in. The upgrade goes through
  // Fastify's router, so it sits behind the same gate as everything else on this origin.
  await app.register(httpProxy, {
    upstream,
    prefix: LIVE_PREFIX,
    rewritePrefix: '/api/pages',
    websocket: true,
  });

  await app.register(httpProxy, {
    upstream,
    prefix: VNC_PREFIX,
    rewritePrefix: '/vnc',
    websocket: true,
  });
}

export default routes;
