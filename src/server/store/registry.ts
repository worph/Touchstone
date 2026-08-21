/**
 * The subject registry — row B1.
 *
 * What exists to be audited is the AppStore's `Apps/` directory, read from the GitHub
 * contents API. n8n carries a 55-entry hardcoded list beside it, and that list is *not*
 * redundant: it is what keeps the loop running through a GitHub outage or a rate-limit,
 * which is the one condition under which "the registry is empty" would otherwise quietly
 * mean "there is nothing to audit". It is a cold-start fallback, never a source.
 *
 * Two rules the port keeps from `Pick next target`:
 *
 * - **Directories only.** A file under `Apps/` is not an app.
 * - **Anything already in the archive stays in the registry**, appended after the live list.
 *   An app removed from the store still has reports and still deserves a row; dropping it
 *   would make the roll-up quietly shrink and take its history out of view.
 */

import path from 'node:path';

import { DEFAULT_ORIGIN, splitSubjectKey, subjectKey, type SubjectKey } from '../../shared/subject.js';
import type { OriginEntry } from './config.js';
import { readJson, writeJsonAtomic } from './state.js';
import type { EventLog } from '../services/events.js';

export const GITHUB_APPS_URL = 'https://api.github.com/repos/Yundera/AppStore/contents/Apps';

/**
 * The contents API for one origin.
 *
 * `?ref=` is not optional. Without it the API answers for the repo's default branch whatever
 * `ref` says, so an origin pinned to a branch would list `main`'s app directory and audit the
 * wrong set of apps — a wrong answer rather than an error, which is the worst kind.
 */
export function appsUrlFor(origin: { repo: string; ref: string; apps_path: string }): string {
  const path = origin.apps_path.replace(/^\/+|\/+$/g, '');
  return (
    `https://api.github.com/repos/${origin.repo}/contents/${path}` +
    `?ref=${encodeURIComponent(origin.ref)}`
  );
}

/**
 * n8n's cold-start list, verbatim as of 2026-08-19. Deliberately not sorted or tidied: it is
 * a copy of what the other system falls back to, and a difference here is a difference in
 * what the two systems audit.
 */
export const DEFAULT_APPS = [
  'Beacon', 'BrowserMCP', 'Caddy', 'ChronosMCP', 'ClaudeCode', 'ClaudeCodeRoot', 'ConvertX',
  'Crafty', 'Docmost', 'DocmostMCP', 'DokuWiki', 'Dufs', 'Duplicati', 'FileBrowser', 'Guacamole',
  'Hubs', 'Immich', 'Jellyfin', 'Lidarr', 'Mealie', 'N8NMCP', 'Navidrome', 'Netdata', 'Nextcloud',
  'NextcloudMCP', 'Nginx', 'NoteDiscovery', 'Ntfy', 'Odoo', 'Ollama', 'OllamaNvidia', 'OpenClaw',
  'Outline', 'Prowlarr', 'PsiTransfer', 'Radarr', 'Samba', 'Seafile', 'SegmentPlayer',
  'SegmentStremioAddon', 'Sonarr', 'Spliit', 'Stirling-PDF', 'Stremio', 'Suwayomi', 'TINCatan',
  'Tailscale', 'TelegramMCP', 'Terminal', 'Tribler', 'Vaultwarden', 'WireGuardEasy',
  'WireGuardEasyHost', 'n8n', 'qBittorrent',
] as const;

/**
 * `state/registry.json`.
 *
 * Was `{names, fetched_at}` when there was one store. Now one bucket per origin, because the
 * failure that matters is **isolation**: one store's GitHub outage must not empty another's
 * list. The old shape is still read, as the default origin's bucket — three lines, no separate
 * migration, and a restart during an outage still knows every store it knew before.
 */
interface OriginState {
  names: string[];
  fetched_at?: string;
  /** The last fetch failed. Reported per store, and what gates dispatching to it. */
  failed?: string;
}

interface RegistryFile {
  /** The pre-2026-08-20 shape: one flat list, the default origin's. */
  names?: string[];
  fetched_at?: string;
  origins?: Record<string, OriginState>;
}

export interface SubjectRegistryOptions {
  stateDir: string;
  events?: EventLog;
  /** Overrides the URL built from the origin. Tests only. */
  url?: string;
  fetchTimeoutMs?: number;
  /** Every store to read. Order is render order. */
  origins?: OriginEntry[];
  /**
   * Which store this registry reads. Subjects come back as `<origin>~<name>` keys.
   *
   * One origin for now — a second is R10 step 3, and it turns `names` into a per-origin map.
   */
  origin?: string;
  /**
   * A cold-start list for this origin, used only until the contents API answers once.
   *
   * The Yundera store's list is `DEFAULT_APPS` below and stays in code deliberately — see the
   * comment on it. This is what a *second* origin gets, and it is legitimately empty: a new
   * store cold-starting with nothing is honest, whereas the known store emptying is the
   * failure that list exists to prevent.
   */
  seed?: string[];
  /**
   * Subject **keys** already in the archive, appended to whatever the live list returns.
   *
   * These are already keys, so they are not re-namespaced: an archived subject belongs to the
   * origin its own reports say it does.
   */
  archived?: () => string[];
}

export class SubjectRegistry {
  private readonly file: string;
  private readonly opts: SubjectRegistryOptions;
  /** Per origin, so one store's outage cannot empty another's list. */
  private state = new Map<string, OriginState>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: SubjectRegistryOptions) {
    this.opts = opts;
    this.file = path.join(opts.stateDir, 'registry.json');
  }

  /** The stores this registry reads, in render order. */
  get origins(): OriginEntry[] {
    return this.opts.origins?.length
      ? this.opts.origins
      : [{ id: DEFAULT_ORIGIN, repo: 'Yundera/AppStore', ref: 'main', apps_path: 'Apps' }];
  }

  /** Restore the last good lists, so a restart during an outage still knows every store. */
  async load(): Promise<void> {
    const stored = await readJson<RegistryFile>(this.file, {});
    if (stored?.origins && typeof stored.origins === 'object') {
      for (const [id, row] of Object.entries(stored.origins)) {
        if (Array.isArray(row?.names)) this.state.set(id, { ...row, names: row.names });
      }
      return;
    }
    // The pre-2026-08-20 shape: one flat list, which was the default origin's.
    if (Array.isArray(stored?.names) && stored.names.length > 0) {
      this.state.set(DEFAULT_ORIGIN, { names: stored.names, fetched_at: stored.fetched_at });
    }
  }

  private seedFor(origin: OriginEntry): string[] {
    if (origin.seed) return origin.seed;
    // `DEFAULT_APPS` stays in code rather than in config: it is a copy of what n8n falls back
    // to, and a difference in it is a difference in what the two systems audit. A *new* store
    // cold-starting empty is honest — the dangerous case is the known store emptying.
    return origin.id === DEFAULT_ORIGIN ? [...DEFAULT_APPS] : [];
  }

  /** The names one store currently offers: its live list, or its cold-start list. */
  private namesFor(origin: OriginEntry): string[] {
    const known = this.state.get(origin.id)?.names ?? [];
    return known.length > 0 ? known : this.seedFor(origin);
  }

  /**
   * Whether a store's list has ever been read live, as opposed to falling back.
   *
   * The runner asks this before dispatching: auditing a subject against a store we have never
   * reached would error and burn the subject's retry budget for an infra condition, which is
   * exactly what invariant 3 forbids.
   */
  reachable(id: string): boolean {
    const row = this.state.get(id);
    // The **last** fetch succeeded — not "we have a list from some time". A store whose latest
    // read failed cannot be audited either: the agent fetches the app's files from the same
    // place, so the run would error against a dead source and burn the subject's try. Blocking
    // instead costs nothing (invariant 3 restores the subject untouched) and the next tick
    // retries, so a transient blip delays an audit rather than parking an innocent app.
    return Boolean(row && row.names.length > 0 && !row.failed);
  }

  /** Why a store is not reachable, in one clause a person reads. */
  failureOf(id: string): string | undefined {
    return this.state.get(id)?.failed;
  }

  /**
   * The registry, in render order: the live list, then anything only the archive knows.
   *
   * Returns `<origin>~<name>` **keys**. The names GitHub gives are bare, so they are namespaced
   * here; the archived ones already are keys and are passed through untouched, because a subject
   * belongs to whichever origin its own reports say it does — including an origin that is no
   * longer configured.
   *
   * Never empty while `DEFAULT_APPS` exists — an empty registry would read as "backlog
   * empty" and idle the loop forever on the one failure it is least able to notice.
   */
  list(): SubjectKey[] {
    const seen = new Set<string>();
    const out: SubjectKey[] = [];
    for (const origin of this.origins) {
      for (const name of this.namesFor(origin)) {
        const key = subjectKey(origin.id, name);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
    }
    // Archived subjects are already keys and are passed through untouched — a subject belongs
    // to whichever origin its own reports say it does.
    //
    // But only under a **configured** origin. A store removed from config.yaml still has
    // reports and stays reachable by URL, and must not stay schedulable: it cannot be fetched
    // or audited, so leaving it in the backlog would park it as the permanent stalest row and
    // starve every app behind it.
    const configured = new Set(this.origins.map((o) => o.id));
    for (const key of this.opts.archived?.() ?? []) {
      if (seen.has(key)) continue;
      if (!configured.has(splitSubjectKey(key).origin)) continue;
      seen.add(key);
      out.push(key as SubjectKey);
    }
    return out;
  }

  /** The newest fetch across all stores — what the Automation page dates the registry by. */
  get lastFetchedAt(): string | undefined {
    const stamps = [...this.state.values()]
      .map((r) => r.fetched_at)
      .filter((t): t is string => Boolean(t))
      .sort();
    return stamps[stamps.length - 1];
  }

  /**
   * Whether **every** configured store has been read live.
   *
   * Deliberately not "any": this drives the "the built-in list stands" caption, and a caption
   * saying the registry is live while one store is falling back to a cold-start list would be
   * the more misleading of the two answers.
   */
  get isLive(): boolean {
    return this.origins.every((o) => this.reachable(o.id));
  }

  /** Per-store detail, for the Automation page and the alerts. */
  status(): { id: string; repo: string; ref: string; count: number; live: boolean; fetched_at?: string; error?: string }[] {
    return this.origins.map((o) => {
      const row = this.state.get(o.id);
      return {
        id: o.id,
        repo: o.repo,
        ref: o.ref,
        count: this.namesFor(o).length,
        live: this.reachable(o.id),
        ...(row?.fetched_at ? { fetched_at: row.fetched_at } : {}),
        ...(row?.failed ? { error: row.failed } : {}),
      };
    });
  }

  /**
   * Re-read every store. One store's failure is isolated to that store.
   *
   * `Promise.allSettled`, not `all`: a rejection in one must not skip the rest, and each
   * origin's catch keeps its own previous list rather than emptying it.
   */
  async refresh(): Promise<SubjectKey[]> {
    await Promise.allSettled(this.origins.map((o) => this.refreshOne(o)));
    await this.persist();
    return this.list();
  }

  private async refreshOne(origin: OriginEntry): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs ?? 30_000);
    const previous = this.state.get(origin.id);
    try {
      const res = await fetch(this.opts.url ?? appsUrlFor(origin), {
        signal: controller.signal,
        headers: { 'user-agent': 'touchstone-registry', accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows: unknown = await res.json();
      if (!Array.isArray(rows)) throw new Error('not a list');
      const names = (rows as { type?: string; name?: string }[])
        .filter((r) => r?.type === 'dir' && typeof r.name === 'string')
        .map((r) => r.name!);
      if (names.length === 0) throw new Error('no directories');

      const before = previous?.names ?? [];
      const changed = names.length !== before.length || names.some((n, i) => n !== before[i]);
      this.state.set(origin.id, { names, fetched_at: new Date().toISOString() });
      if (changed) {
        this.opts.events?.log({
          level: 'info',
          code: 'REGISTRY_REFRESHED',
          message:
            `The app registry changed — ${names.length} apps in ${origin.repo}` +
            (origin.ref === 'main' ? '' : ` at ${origin.ref}`),
          detail: { count: names.length, origin: origin.id },
        });
      }
      if (previous?.failed) {
        this.opts.events?.log({
          level: 'info',
          code: 'REGISTRY_RECOVERED',
          message: `${origin.repo} is readable again — ${names.length} apps`,
          detail: { count: names.length, origin: origin.id },
        });
      }
    } catch (err) {
      // Keeping the previous list is the point: a registry that empties on a failed fetch
      // would report "backlog empty" and idle, which looks exactly like success.
      const error = err instanceof Error ? err.message : String(err);
      const live = (previous?.names.length ?? 0) > 0;
      this.state.set(origin.id, { names: previous?.names ?? [], ...(previous?.fetched_at ? { fetched_at: previous.fetched_at } : {}), failed: error });
      this.opts.events?.log({
        level: 'warn',
        code: 'REGISTRY_FAILED',
        message: live
          ? `Could not re-read ${origin.repo}, so the last known list stands`
          : `Could not read ${origin.repo}, so nothing from that store can be audited`,
        detail: { error, live, origin: origin.id },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.refresh().catch((err) => console.error('registry refresh failed', err));
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async persist(): Promise<void> {
    try {
      await writeJsonAtomic(this.file, { origins: Object.fromEntries(this.state) });
    } catch (err) {
      console.error('could not write registry.json', err);
    }
  }
}
