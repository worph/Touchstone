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
 *
 * With one qualification the port did not have, added 2026-08-31: an archived app that a
 * *readable* store no longer offers is **delisted**. It keeps its row and its verdicts — that
 * is the rule above, unchanged — but it leaves `list()`, because `list()` is also the
 * scheduler's candidate set and a delisted app is one the loop would pick, fail to fetch and
 * pick again. See {@link SubjectRegistry.delisted}.
 */

import path from 'node:path';

import { DEFAULT_ORIGIN, splitSubjectKey, subjectKey, type SubjectKey } from '../../shared/subject.js';
import type { OriginEntry } from './config.js';
import { readJson, writeJsonAtomic } from './state.js';
import type { EventLog } from '../services/events.js';

export const GITHUB_APPS_URL = 'https://api.github.com/repos/Yundera/AppStore/contents/Apps';

/**
 * The contents API for one path in one origin.
 *
 * `?ref=` is not optional. Without it the API answers for the repo's default branch whatever
 * `ref` says, so an origin pinned to a branch would list `main`'s app directory and audit the
 * wrong set of apps — a wrong answer rather than an error, which is the worst kind.
 *
 * One builder for every read of a store's repo — the app list here, and any other file via
 * `services/storedoc.ts`. Two would be two places for the ref to go missing.
 */
export function contentUrlFor(origin: { repo: string; ref: string }, path: string): string {
  const clean = path.replace(/^\/+|\/+$/g, '');
  return (
    `https://api.github.com/repos/${origin.repo}/contents/${clean}` +
    `?ref=${encodeURIComponent(origin.ref)}`
  );
}

/** Where the apps live in one origin — `contentUrlFor` at that origin's `apps_path`. */
export function appsUrlFor(origin: { repo: string; ref: string; apps_path: string }): string {
  return contentUrlFor(origin, origin.apps_path);
}

/**
 * The whole tree of one origin at its pinned ref, in **one** request.
 *
 * This is the only affordable way to know what version of each app the store is offering.
 * The obvious implementation — `commits?path=Apps/<App>/docker-compose.yml` per app — is one
 * request per app, and there are 69 of them against an unauthenticated ceiling of 60 an hour
 * that `services/storedoc.ts` also spends from. It would drive the origin unreachable, and
 * `reachable()` is what gates dispatch, so the feature would *stop* auditing rather than
 * sharpen it (invariant 3). The recursive tree answers for every app at once.
 *
 * `?recursive=1` can be truncated on a very large repo, and the response says so; a truncated
 * tree is discarded rather than half-believed, because a missing entry is indistinguishable
 * from an app with no compose and would read as "nothing to compare".
 */
export function treeUrlFor(origin: { repo: string; ref: string }): string {
  return (
    `https://api.github.com/repos/${origin.repo}/git/trees/` +
    `${encodeURIComponent(origin.ref)}?recursive=1`
  );
}

/**
 * The file whose bytes decide whether an app has changed.
 *
 * A constant rather than a config knob: the AppStore requires this name, and the whole point
 * of keying on one file is that it is the one the audit actually reads. The **directory**
 * sha is right there in the contents listing for free, and is deliberately not used — an app
 * directory is the compose plus around 3 MB of icon and screenshots, so a screenshot refresh
 * would re-audit the app.
 */
export const SUBJECT_FILE = 'docker-compose.yml';

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
  /**
   * App name → the git blob sha of its `docker-compose.yml` at this origin's ref.
   *
   * Best-effort and **separate from `failed`**: the app list is what gates dispatch, so a
   * tree fetch that fails must not make the store unreachable. It keeps whatever it had,
   * and a subject with no entry simply has no version to compare — never "changed".
   */
  versions?: Record<string, string>;
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
  /** Overrides the tree URL built from the origin. Tests only. */
  treeUrl?: string;
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
    //
    // And only while the store has not *said* it is gone. `delisted()` is the same argument
    // one step in: an app the store has been read live and does not offer any more cannot be
    // fetched either, so keeping it here would make it a permanent backlog row that errors
    // every time it is picked. It keeps its verdicts — the archive is what it is — it simply
    // stops being something to audit.
    const configured = new Set(this.origins.map((o) => o.id));
    const gone = new Set<string>(this.delisted());
    for (const key of this.opts.archived?.() ?? []) {
      if (seen.has(key)) continue;
      if (!configured.has(splitSubjectKey(key).origin)) continue;
      if (gone.has(key)) continue;
      seen.add(key);
      out.push(key as SubjectKey);
    }
    return out;
  }

  /**
   * Subjects the archive knows and the store no longer offers — **delisted**.
   *
   * The distinction this draws is the whole point, and it is the one `list()` could not make
   * on its own: "the store is unreadable, keep what we knew" and "the store is readable and
   * this app is not in it" arrive at the same place — an archived key with no live entry —
   * and mean opposite things. So the answer is gated on {@link reachable}: a store whose last
   * fetch failed delists nobody, because a GitHub outage must never be able to retire 72 apps.
   *
   * Being delisted is not a verdict and not a finding. It says the subject of the verdicts is
   * no longer on sale, which is why it stops the subject being scheduled (the audit would
   * fetch a directory that is not there and error) while leaving every report it earned
   * exactly where it is. Removing those is a separate, deliberate act — `DELETE /subjects/:name`.
   */
  delisted(): SubjectKey[] {
    const live = new Set(this.origins.filter((o) => this.reachable(o.id)).map((o) => o.id));
    if (live.size === 0) return [];
    const offered = new Set<string>();
    for (const origin of this.origins) {
      if (!live.has(origin.id)) continue;
      for (const name of this.namesFor(origin)) offered.add(subjectKey(origin.id, name));
    }
    const out: SubjectKey[] = [];
    const seen = new Set<string>();
    for (const key of this.opts.archived?.() ?? []) {
      if (seen.has(key)) continue;
      if (!live.has(splitSubjectKey(key).origin)) continue;
      if (offered.has(key)) continue;
      seen.add(key);
      out.push(key as SubjectKey);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  /** Whether one subject key is delisted. The row badge and the delete guard both ask this. */
  isDelisted(key: string): boolean {
    return this.delisted().includes(key as SubjectKey);
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
    // Taken before, so the event below names what *this* refresh retired rather than
    // re-announcing every app that has been gone for a month.
    const before = new Set<string>(this.delisted());
    await Promise.allSettled(this.origins.map((o) => this.refreshOne(o)));
    await this.persist();
    const now = this.delisted().filter((key) => !before.has(key));
    if (now.length > 0) {
      this.opts.events?.log({
        level: 'info',
        code: 'SUBJECT_DELISTED',
        message:
          now.length === 1
            ? `${splitSubjectKey(now[0]!).name} is no longer in the store — it keeps its verdicts and leaves the backlog`
            : `${now.length} apps are no longer in the store — they keep their verdicts and leave the backlog`,
        detail: { subjects: [...now] },
      });
    }
    return this.list();
  }

  /**
   * One request: every app's `docker-compose.yml` blob sha at this origin's ref.
   *
   * Returns `undefined` on any doubt — a failed request, a truncated tree, a shape that is
   * not the tree API's — and the caller then keeps whatever it had. Never throws: this runs
   * inside the refresh that decides whether a store can be audited at all, and a version
   * lookup is not allowed to be the thing that stops an audit.
   */
  private async fetchVersions(origin: OriginEntry): Promise<Record<string, string> | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.fetchTimeoutMs ?? 30_000);
    try {
      const res = await fetch(this.opts.treeUrl ?? treeUrlFor(origin), {
        signal: controller.signal,
        headers: { 'user-agent': 'touchstone-registry', accept: 'application/vnd.github+json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body: unknown = await res.json();
      const tree = (body as { tree?: unknown; truncated?: unknown })?.tree;
      // A truncated tree is discarded rather than half-believed: a missing entry looks exactly
      // like an app with no compose, and would silently read as "nothing to compare".
      if ((body as { truncated?: unknown })?.truncated === true) {
        throw new Error('tree truncated');
      }
      if (!Array.isArray(tree)) throw new Error('not a tree');

      const prefix = `${origin.apps_path.replace(/^\/+|\/+$/g, '')}/`;
      const suffix = `/${SUBJECT_FILE}`;
      const out: Record<string, string> = {};
      for (const entry of tree as { path?: unknown; type?: unknown; sha?: unknown }[]) {
        if (entry?.type !== 'blob') continue;
        const p = typeof entry.path === 'string' ? entry.path : '';
        if (!p.startsWith(prefix) || !p.endsWith(suffix)) continue;
        // Exactly `<apps_path>/<App>/docker-compose.yml` — not one nested deeper, which would
        // key the app to a file the audit never reads.
        const name = p.slice(prefix.length, p.length - suffix.length);
        if (name === '' || name.includes('/')) continue;
        if (typeof entry.sha === 'string' && entry.sha !== '') out[name] = entry.sha;
      }
      return out;
    } catch (err) {
      this.opts.events?.log({
        level: 'warn',
        code: 'REGISTRY_VERSIONS_FAILED',
        message: `Could not read app versions from ${origin.repo}; the last known ones stand`,
        detail: { error: err instanceof Error ? err.message : String(err), origin: origin.id },
      });
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The version of every app the stores currently offer, as `<origin>~<name>` keys.
   *
   * A git **blob sha1**, not a sha256 — it is GitHub's identity for those bytes, and the only
   * thing it is ever compared against is another one of the same kind. An app with no entry is
   * absent rather than empty-string: "we do not know" and "it changed" must not collapse.
   */
  versions(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const origin of this.origins) {
      for (const [name, sha] of Object.entries(this.state.get(origin.id)?.versions ?? {})) {
        out[subjectKey(origin.id, name)] = sha;
      }
    }
    return out;
  }

  /** The version of one subject, or undefined when the store has not offered one. */
  versionOf(key: string): string | undefined {
    const { origin, name } = splitSubjectKey(key as SubjectKey);
    return this.state.get(origin)?.versions?.[name];
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
      // The app list is authoritative for `reachable()`; the versions are a bonus on top of
      // it, so they are fetched after and cannot fail the refresh. Keeping the previous map
      // on failure is the same instinct as keeping the previous names.
      const versions = (await this.fetchVersions(origin)) ?? previous?.versions;
      this.state.set(origin.id, {
        names,
        fetched_at: new Date().toISOString(),
        ...(versions ? { versions } : {}),
      });
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
      this.state.set(origin.id, {
        names: previous?.names ?? [],
        ...(previous?.fetched_at ? { fetched_at: previous.fetched_at } : {}),
        ...(previous?.versions ? { versions: previous.versions } : {}),
        failed: error,
      });
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
