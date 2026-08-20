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

import { DEFAULT_ORIGIN, subjectKey, type SubjectKey } from '../../shared/subject.js';
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

interface RegistryFile {
  names: string[];
  fetched_at?: string;
}

export interface SubjectRegistryOptions {
  stateDir: string;
  events?: EventLog;
  url?: string;
  fetchTimeoutMs?: number;
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
  private names: string[] = [];
  private fetchedAt?: string;
  private timer?: ReturnType<typeof setInterval>;

  constructor(opts: SubjectRegistryOptions) {
    this.opts = opts;
    this.file = path.join(opts.stateDir, 'registry.json');
  }

  /** Restore the last good list, so a restart during a GitHub outage still knows the store. */
  async load(): Promise<void> {
    const stored = await readJson<RegistryFile>(this.file, { names: [] });
    if (Array.isArray(stored?.names) && stored.names.length > 0) {
      this.names = stored.names;
      this.fetchedAt = stored.fetched_at;
    }
  }

  /** Which store this registry reads. */
  get origin(): string {
    return this.opts.origin ?? DEFAULT_ORIGIN;
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
    const origin = this.origin;
    const fallback = this.opts.seed ?? (origin === DEFAULT_ORIGIN ? [...DEFAULT_APPS] : []);
    const base = (this.names.length > 0 ? this.names : fallback).map((n) => subjectKey(origin, n));
    const seen = new Set<string>(base);
    const out = [...base];
    for (const key of this.opts.archived?.() ?? []) {
      if (!seen.has(key)) {
        seen.add(key);
        out.push(key as SubjectKey);
      }
    }
    return out;
  }

  get lastFetchedAt(): string | undefined {
    return this.fetchedAt;
  }

  /** Whether the live list has ever been read, as opposed to falling back. */
  get isLive(): boolean {
    return this.names.length > 0;
  }

  async refresh(): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs ?? 30_000);
    try {
      const res = await fetch(this.opts.url ?? GITHUB_APPS_URL, {
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

      const changed = names.length !== this.names.length || names.some((n, i) => n !== this.names[i]);
      this.names = names;
      this.fetchedAt = new Date().toISOString();
      await this.persist();
      if (changed) {
        this.opts.events?.log({
          level: 'info',
          code: 'REGISTRY_REFRESHED',
          message: `The app registry changed — ${names.length} apps in the store`,
          detail: { count: names.length },
        });
      }
      return this.list();
    } catch (err) {
      // Keeping the previous list is the point: a registry that empties on a failed fetch
      // would report "backlog empty" and idle, which looks exactly like success.
      this.opts.events?.log({
        level: 'warn',
        code: 'REGISTRY_FAILED',
        message: this.isLive
          ? 'Could not re-read the app registry, so the last known list stands'
          : 'Could not read the app registry, so the built-in list stands',
        detail: { error: err instanceof Error ? err.message : String(err), live: this.isLive },
      });
      return this.list();
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
      await writeJsonAtomic(this.file, { names: this.names, fetched_at: this.fetchedAt });
    } catch (err) {
      console.error('could not write registry.json', err);
    }
  }
}
