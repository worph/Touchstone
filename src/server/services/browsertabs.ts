/**
 * Close the tabs a run opened, once its lease on the browser is released.
 *
 * The prompt has every audit open a fresh isolated context and the rubric's first step is a
 * `new_page`, but nothing ever closed one: release only dropped the in-memory lease, and the
 * tabs waited out browser-mcp's idle collector (30 minutes unchanged). With runs back to back
 * that kept 7–14 live pages — Maison dashboards polling their demo host, a WebGL scene — in
 * one Chrome on yunderalabs (2026-10-27).
 *
 * **Which tabs are the run's** is answered by time, not by owner: chrome-devtools-mcp opens
 * them, so browser-mcp only observes them and records `owner: null`. A lease is exclusive,
 * so every tab first seen while it was held belongs to the run that held it. `GET /api/pages`
 * observes Chrome before it answers, so a tab opened seconds before release is there with a
 * `createdAt` inside the lease. Tabs from before the lease, and any tab a person asked to
 * keep, are left alone — the collector still owns those.
 *
 * Never throws and never waits on the caller: a browser that cannot be reached loses a
 * cleanup, never a run.
 */

import { browserBase } from '../routes/browser.js';
import type { EventLog } from './events.js';

interface PageRow {
  pageId: string;
  createdAt: number;
  keepUntil: number | null;
}

export interface CloseRunTabsInput {
  /** The leased sidecar's MCP url — `http://host:9746/mcp`. */
  url: string;
  /** When the lease was taken, ISO. */
  since: string;
  /** Who held it, for the event. */
  holder: string;
  events?: Pick<EventLog, 'log'>;
  fetch?: typeof fetch;
  now?: () => number;
}

export async function closeRunTabs(input: CloseRunTabsInput): Promise<{ closed: number; kept: number; failed: number }> {
  const doFetch = input.fetch ?? fetch;
  const now = input.now?.() ?? Date.now();
  const since = Date.parse(input.since);
  const base = browserBase(input.url);
  const result = { closed: 0, kept: 0, failed: 0 };
  if (Number.isNaN(since)) return result;

  let pages: PageRow[];
  try {
    const res = await doFetch(`${base}/api/pages`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return result;
    pages = ((await res.json()) as { pages?: PageRow[] }).pages ?? [];
  } catch {
    return result;
  }

  for (const page of pages) {
    if (!(page.createdAt >= since)) continue;
    if (page.keepUntil !== null && page.keepUntil > now) {
      result.kept += 1;
      continue;
    }
    try {
      const res = await doFetch(`${base}/api/pages/${encodeURIComponent(page.pageId)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(5000),
      });
      // 410 is "already gone", which is what was asked for.
      if (res.ok || res.status === 410) result.closed += 1;
      else result.failed += 1;
    } catch {
      result.failed += 1;
    }
  }

  if (result.closed + result.kept + result.failed > 0) {
    input.events?.log({
      level: result.failed > 0 ? 'warn' : 'info',
      code: 'BROWSER_TABS_CLOSED',
      message: `Closed ${result.closed} browser tab${result.closed === 1 ? '' : 's'} left by ${input.holder}`,
      detail: { browser: input.url, holder: input.holder, ...result },
    });
  }
  return result;
}
