/**
 * Starting a trial — the part `POST /trials` and the chat's `run_trial` tool both need.
 *
 * It lives here rather than in the route because there are two callers, and a second
 * implementation of "what happens when a trial starts" is a second place for the record, the
 * log line and the dispatch to drift apart. That is the same reasoning that keeps the admin MCP
 * surface serving the chat's own registry instead of a parallel one.
 *
 * ## One pipeline, because a store zip is both halves of an audit
 *
 * A trial used to come in two shapes — a `repo@ref` the static section fetched with `gh`, and
 * an upload session whose bytes were inlined — with a spec builder, a slug, a prompt branch and
 * a `kind` field each. The two are now one: **whatever the caller names, it resolves to a store
 * zip**, and a store zip is simultaneously the files the static section reads and the bytes the
 * bench installs. That is not merely tidier. A ref trial used to read its bytes from a place
 * the bench never installed from, which is precisely the disagreement `functional.md` v6 had to
 * add a hand-written compose assertion to catch.
 *
 * Two steps, deliberately separate. `buildSpec` resolves and fetches, and is where a bad URL,
 * an empty session or an app that is not in the archive is refused; `dispatchTrial` writes the
 * row, saves the store, logs, and fires the run without waiting for it. The split is what lets
 * the route answer 400 or 404 with a status code while the tool answers the same refusals as a
 * sentence.
 */

import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { subjectKey } from '../../shared/subject.js';
import type { TrialRecord } from '../../shared/trials.js';
import { resolveSubjectKey } from '../domain/subjects.js';
import type { Runner } from '../runner/index.js';
import type { EventLog } from './events.js';
import { TrialInputError, trialSlug, validateTrial, type TrialStore } from '../store/trials.js';
import { buildIndex, type ReportIndex } from '../store/index.js';
import type { UploadStore } from '../store/uploads.js';
import type { OriginEntry } from '../store/config.js';
import {
  extractApp,
  fetchStoreZip,
  packAppStore,
  saveStoreZip,
  sourceOf,
  TrialStoreError,
  type TrialSource,
} from './trialstore.js';

/** What to audit, once it no longer matters how the caller said it. */
export interface TrialSpec {
  slug: string;
  subject: string;
  apps_path: string;
  /**
   * The **rubric anchor** — never a place a byte came from.
   *
   * `data/protocols/static.md` resolves the `assets` item against `<repo>@main` and reads that
   * repo's `CONTRIBUTING.md` as the definition of every checklist item, so a run carrying no
   * repo would throw a false Major on every asset URL and apply a rubric whose terms it could
   * not look up. Resolved from the configured origins rather than supplied by the caller,
   * because contribution rules belong to the store, not to the branch under trial.
   */
  repo: string;
  /** Where the archive came from, for the record. `upload:<id>` when there was no remote one. */
  source_url: string;
  upload_id?: string;
  /** The app's own files, read out of the archive and inlined into the prompt. */
  source: TrialSource;
  /**
   * A store holding **only this app**, saved into the trial's directory and re-served.
   *
   * Never the archive it was extracted from. A real store is 96 MB and fifty apps, and the
   * trial says nothing about the other forty-nine — copying it per trial would be gigabytes,
   * and it would hand the bench a catalogue to pick the wrong entry out of.
   */
  zip: Buffer;
  /** The unguessable name this trial's copy is served under. */
  store_token: string;
}

export interface TrialRunDeps {
  runner?: Runner;
  trials?: TrialStore;
  uploads?: UploadStore;
  trialsRoot?: string;
  events?: EventLog;
  /** Every subject key the loop knows, for resolving what the trial is about. */
  known?: () => string[];
  /** The configured stores, so a trial can be judged against the right CONTRIBUTING.md. */
  origins?: OriginEntry[];
  /**
   * Touchstone's own address as a demo bench would reach it, from `config.trials`.
   *
   * Empty is a supported state, not a misconfiguration — but it is the *only* thing now
   * standing between a trial and a full audit. Without it a trial cannot serve the archive it
   * fetched, so the functional section records `store_url_unconfigured` and says so.
   */
  publicBaseUrl?: string;
  /** Injected in tests so a trial can be started without reaching GitHub. */
  fetchImpl?: typeof fetch;
  onError?: (err: unknown, slug: string) => void;
}

export type Refusal = { ok: false; code: number; error: string };

/** Everything that must be true before any trial can start, in the order worth saying. */
export function trialsReady(deps: TrialRunDeps): Refusal | null {
  if (!deps.trials || !deps.trialsRoot) return { ok: false, code: 503, error: 'trials are not configured' };
  if (!deps.runner) return { ok: false, code: 503, error: 'no runner configured' };
  if (!deps.runner.enabled) {
    return { ok: false, code: 409, error: 'the runner is disabled — set runner.enabled in config.yaml' };
  }
  if (deps.runner.busy) {
    return { ok: false, code: 409, error: 'a run is already in progress' };
  }
  return null;
}

/**
 * Which store's rules this app is judged by.
 *
 * The origin the subject already belongs to, when it belongs to one — so a trial of an app in a
 * second store is judged against *that* store's `CONTRIBUTING.md` rather than Yundera's. A
 * branch adding an app no store has yet falls back to the first configured origin, which is the
 * only answer available and the right one in the single-store case that is every case today.
 */
function rubricRepo(deps: TrialRunDeps, compareTo: string | undefined): string {
  const origins = deps.origins ?? [];
  const originId = compareTo?.split('~')[0];
  const found = originId ? origins.find((o) => o.id === originId) : undefined;
  return found?.repo ?? origins[0]?.repo ?? 'Yundera/AppStore';
}

/**
 * Turn whatever the caller said into one auditable store.
 *
 * `{ upload }` zips the bytes in a session — nothing fetched, nothing that could be stale.
 * `{ store_url }` fetches an archive, through the allowlist in `services/trialstore.ts`. Past
 * this function the two are indistinguishable, which is the entire point.
 */
export async function buildSpec(
  deps: TrialRunDeps,
  body: Record<string, unknown>,
  at: string,
): Promise<{ ok: true; spec: TrialSpec; compare_to?: string } | Refusal> {
  const wantedUpload = String(body.upload ?? '').trim();

  let zip: Buffer;
  let sourceUrl: string;
  let subject: string;
  let appsPath: string;
  let uploadId: string | undefined;

  if (wantedUpload) {
    if (!deps.uploads) return { ok: false, code: 503, error: 'upload sessions are not configured' };
    const session = deps.uploads.get(wantedUpload);
    if (!session || deps.uploads.expired(session)) {
      return { ok: false, code: 404, error: `no such upload session: ${wantedUpload}` };
    }
    // Checked before zipping, so an empty session gets the answer it deserves. The generic
    // "no such directory in that archive" `readAppFromZip` would otherwise give is true but
    // useless here: the caller's mistake is not naming the wrong app, it is not having
    // uploaded anything yet.
    if (!(await deps.uploads.readText(session, 'docker-compose.yml'))) {
      return {
        ok: false,
        code: 400,
        error: 'that session has no docker-compose.yml — upload one before running the trial',
      };
    }
    zip = await deps.uploads.zipStore(session);
    sourceUrl = `upload:${session.id}`;
    subject = session.subject;
    // An upload session builds its zip in `Apps/<subject>/` unconditionally, so this is not a
    // caller's claim about the archive — it is a fact about how we just built it.
    appsPath = 'Apps';
    uploadId = session.id;
  } else {
    let input;
    try {
      input = validateTrial(body);
    } catch (err) {
      if (err instanceof TrialInputError) return { ok: false, code: 400, error: err.message };
      throw err;
    }
    try {
      zip = await fetchStoreZip(input.store_url, {
        publicBaseUrl: deps.publicBaseUrl,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
    } catch (err) {
      if (err instanceof TrialStoreError) return { ok: false, code: 400, error: err.message };
      return { ok: false, code: 502, error: `could not fetch the store: ${(err as Error).message}` };
    }
    sourceUrl = input.store_url;
    subject = input.subject;
    appsPath = input.apps_path;
  }

  // The app comes out of the archive once, and everything downstream is built from *those*
  // bytes: the prompt's view of the files, and the store the bench installs. They cannot
  // disagree, because there is only one copy.
  let source: TrialSource;
  let files: Map<string, Uint8Array>;
  try {
    files = extractApp(zip, appsPath, subject);
    source = sourceOf(files, appsPath, subject);
  } catch (err) {
    if (err instanceof TrialStoreError) return { ok: false, code: 400, error: err.message };
    throw err;
  }

  // What this trial is *about*, when the app also exists in a configured store — so the result
  // can be put beside what that subject currently carries, and so the rubric anchor is that
  // store's. A branch adding a new app has no counterpart, which is a normal PR and not an error.
  const match = resolveSubjectKey(subject, deps.known?.() ?? []);
  const compareTo = match.kind === 'ok' ? match.key : undefined;

  const slug = trialSlug(subject, at);
  return {
    ok: true,
    ...(compareTo ? { compare_to: compareTo } : {}),
    spec: {
      slug,
      subject,
      apps_path: appsPath,
      repo: rubricRepo(deps, compareTo),
      source_url: sourceUrl,
      ...(uploadId ? { upload_id: uploadId } : {}),
      source,
      zip: packAppStore(files, subject, slug),
      store_token: randomBytes(24).toString('base64url'),
    },
  };
}

/**
 * Save the store, write the row, log it, and fire the run without waiting for it.
 *
 * Fire-and-report, exactly as `POST /assays` does: a real audit takes minutes and a socket held
 * open that long is at the mercy of every proxy in between. The caller gets the record back
 * immediately and reads the outcome from the row afterwards.
 */
export async function dispatchTrial(
  deps: TrialRunDeps,
  spec: TrialSpec,
  startedAt: string,
  compareTo?: string,
): Promise<TrialRecord> {
  // `trialsReady` is the precondition, and both callers check it — but "both callers check it"
  // is the kind of contract that holds until there are three. Asserting it here means a third
  // caller that forgets fails loudly at the call rather than quietly on `undefined.run`.
  const { trials, runner, trialsRoot } = deps;
  if (!trials || !runner || !trialsRoot) {
    throw new Error('dispatchTrial called without trials, a runner or a trials root — check trialsReady first');
  }
  const root = path.join(trialsRoot, spec.slug);

  // The trial's own copy, inside its own directory — so it is deleted with the trial and there
  // is no second lifetime to keep in step. Saved *before* the row exists, because a row whose
  // store is missing would advertise a URL that 404s at the bench.
  await saveStoreZip(trials.storeZipPath(spec.slug), spec.zip);

  /**
   * The address the bench fetches. Minted per trial, so Maison's in-process store cache — the
   * one `functional.md` records having cost a day on 2026-08-20 — has never seen it and cannot
   * serve an older copy. Pointing the bench at the caller's own URL would have reintroduced
   * exactly that: a branch archive's URL is stable across pushes.
   */
  const benchStoreUrl = deps.publicBaseUrl
    ? `${deps.publicBaseUrl.replace(/\/+$/, '')}/api/v1/trialstore/${spec.store_token}.zip`
    : undefined;

  const record: TrialRecord = {
    slug: spec.slug,
    source_url: spec.source_url,
    ...(spec.upload_id ? { upload_id: spec.upload_id } : {}),
    repo: spec.repo,
    apps_path: spec.apps_path,
    subject: spec.subject,
    ...(compareTo ? { compare_to: compareTo } : {}),
    store_token: spec.store_token,
    started_at: startedAt,
  };
  await trials.add(record);

  deps.events?.log({
    level: 'info',
    code: 'TRIAL_STARTED',
    message: `Trialling ${spec.subject} from ${spec.source_url}`,
    detail: { slug: spec.slug, source: spec.source_url, subject: spec.subject },
  });
  if (spec.upload_id) await deps.uploads?.setTrial(spec.upload_id, spec.slug);

  void runner
    .run({
      // The slug is the synthetic origin, so the report path machinery is untouched.
      subject: subjectKey(spec.slug, spec.subject),
      try_n: 1,
      trial: {
        repo: spec.repo,
        apps_path: spec.apps_path,
        root,
        source: spec.source,
        ...(benchStoreUrl ? { store_url: benchStoreUrl } : {}),
      },
    })
    .then(async (outcome) => {
      const finished = new Date().toISOString();
      if (outcome.kind === 'verdict') {
        await trials.update(spec.slug, {
          finished_at: finished,
          outcome: 'verdict',
          verdict: outcome.verdict,
          risk_score: outcome.risk,
          files: outcome.files,
        });
        deps.events?.log({
          level: 'info',
          code: 'TRIAL_COMPLETED',
          message: `Trial of ${spec.subject} — ${outcome.verdict}`,
          detail: {
            slug: spec.slug,
            subject: spec.subject,
            verdict: outcome.verdict,
            risk: outcome.risk,
            files: outcome.files.length,
          },
        });
        return;
      }
      const reason = outcome.kind === 'agent_busy' ? 'the agent was busy' : outcome.reason;
      await trials.update(spec.slug, { finished_at: finished, outcome: outcome.kind, error: reason });
      deps.events?.log({
        level: 'warn',
        code: 'TRIAL_FAILED',
        message: `Trial of ${spec.subject} did not complete — ${reason}`,
        detail: { slug: spec.slug, subject: spec.subject, reason },
      });
    })
    .catch((err) => deps.onError?.(err, spec.slug));

  return record;
}

/**
 * A trial's own reports, read on demand.
 *
 * Built per call rather than held, because trials are rare and a warm index of debris is not
 * worth a cache. **`cacheFile: null` is load-bearing**: `defaultCacheFile()` derives
 * `<dirname(root)>/state/index.json`, which for `data/trials` is the *same file* the archive's
 * index uses. Two indexes writing it would clobber each other and cross-serve records — a
 * trial's verdict appearing as a subject's hallmark is exactly what trials exist to prevent.
 */
export function trialIndex(trialsRoot: string, slug: string): Promise<ReportIndex> {
  return buildIndex(path.join(trialsRoot, slug), { cacheFile: null });
}

/**
 * Every trial's reports, in one index — what the list needs to draw a row per section.
 *
 * One walk rather than one per trial. The slug is the synthetic origin, so a record's subject
 * key is already `<slug>~<subject>` and one index separates a hundred trials without knowing
 * anything about them; `subjectHallmark` then composes each row exactly as the Store page's
 * are composed. Denormalising the sections onto `TrialRecord` at write time was the other
 * option and is a second copy of what the files already say.
 *
 * `cacheFile: null` for the reason above, and doubly so here: this root *is* `data/trials`,
 * whose `defaultCacheFile()` collides with the archive's own `state/index.json`.
 */
export function trialsIndex(trialsRoot: string): Promise<ReportIndex> {
  return buildIndex(trialsRoot, { cacheFile: null });
}
