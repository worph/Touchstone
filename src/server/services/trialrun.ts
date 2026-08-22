/**
 * Starting a trial — the part `POST /trials` and the chat's `run_trial` tool both need.
 *
 * It lives here rather than in the route because there are now two callers, and a second
 * implementation of "what happens when a trial starts" is a second place for the record, the
 * log line and the dispatch to drift apart. That is the same reasoning that keeps the admin MCP
 * surface serving the chat's own registry instead of a parallel one.
 *
 * Two steps, deliberately separate. `specFromUpload` turns a session id into something
 * auditable and is where an empty or lapsed session is refused; `dispatchTrial` writes the row,
 * logs, and fires the run without waiting for it. The split is what lets the route answer 400
 * or 404 with a status code while the tool answers the same refusals as a sentence.
 */

import path from 'node:path';

import { subjectKey } from '../../shared/subject.js';
import type { TrialRecord } from '../../shared/trials.js';
import { resolveSubjectKey } from '../domain/subjects.js';
import type { Runner } from '../runner/index.js';
import type { EventLog } from './events.js';
import { uploadSlug, type TrialStore } from '../store/trials.js';
import { buildIndex, type ReportIndex } from '../store/index.js';
import type { UploadStore } from '../store/uploads.js';

/** What to audit, once it no longer matters how the caller said it. */
export interface TrialSpec {
  repo: string;
  ref: string;
  apps_path: string;
  subject: string;
  slug: string;
  /** Present for an upload trial: the app's own bytes, and the session they came from. */
  source?: { files: string[]; compose: string; rationale?: string | null };
  upload_id?: string;
  /** Where a bench can fetch these files as a store. Absent, the functional section blocks. */
  store_url?: string;
}

export interface TrialRunDeps {
  runner?: Runner;
  trials?: TrialStore;
  uploads?: UploadStore;
  trialsRoot?: string;
  events?: EventLog;
  /** Every subject key the loop knows, for resolving what the trial is about. */
  known?: () => string[];
  /**
   * Touchstone's own address as a demo bench would reach it, from `config.trials`.
   *
   * Empty is a supported state, not a misconfiguration: without it a trial cannot hand a bench
   * a store, so the functional section records `store_not_installable` exactly as it did
   * before uploads existed.
   */
  publicBaseUrl?: string;
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
 * Turn an upload session into something auditable.
 *
 * `repo` and `ref` come out **nominal** and that is not a formality. `data/protocols/static.md`
 * resolves the `assets` item against `<repo>@main` and reads that repo's `CONTRIBUTING.md` as
 * the definition of every checklist item, so a run carrying neither would throw a false Major
 * on every asset URL and apply a rubric whose terms it could not look up. `main` specifically,
 * because `runner/prompt.ts` rebinds the asset rule to the ref under audit whenever the ref is
 * anything else — correct for a PR branch, wrong for files that were never on a branch at all.
 */
export async function specFromUpload(
  uploads: UploadStore | undefined,
  uploadId: string,
  at: string,
  publicBaseUrl?: string,
): Promise<{ ok: true; spec: TrialSpec } | Refusal> {
  if (!uploads) return { ok: false, code: 503, error: 'upload sessions are not configured' };

  const session = uploads.get(uploadId);
  if (!session || uploads.expired(session)) {
    return { ok: false, code: 404, error: `no such upload session: ${uploadId}` };
  }

  const compose = await uploads.readText(session, 'docker-compose.yml');
  // The one failure worth catching before the run rather than during it: with no compose there
  // is nothing for the static rubric to read, and the audit would spend its minutes concluding
  // that an app has no compose file — a fact about the upload, dressed as a finding about the
  // app, and recorded where a finding about the app goes.
  if (!compose) {
    return {
      ok: false,
      code: 400,
      error: 'that session has no docker-compose.yml — upload one before running the trial',
    };
  }

  return {
    ok: true,
    spec: {
      repo: session.repo,
      ref: 'main',
      apps_path: 'Apps',
      subject: session.subject,
      slug: uploadSlug(session.id, at),
      upload_id: session.id,
      // The bench fetches this from the public internet, so it is built from the configured
      // external address rather than from anything about the incoming request.
      ...(publicBaseUrl
        ? { store_url: `${publicBaseUrl.replace(/\/+$/, '')}/api/v1/trialstore/${session.token}.zip` }
        : {}),
      source: {
        files: (await uploads.manifest(session)).map((f) => f.path),
        compose,
        rationale: await uploads.readText(session, 'rationale.md'),
      },
    },
  };
}

/**
 * Write the row, log it, and fire the run without waiting for it.
 *
 * Fire-and-report, exactly as `POST /assays` does: a real audit takes minutes and a socket held
 * open that long is at the mercy of every proxy in between. The caller gets the record back
 * immediately and reads the outcome from the row afterwards.
 */
export async function dispatchTrial(
  deps: TrialRunDeps,
  spec: TrialSpec,
  startedAt: string,
): Promise<TrialRecord> {
  // `trialsReady` is the precondition, and both callers check it — but "both callers check it"
  // is the kind of contract that holds until there are three. Asserting it here means a third
  // caller that forgets fails loudly at the call rather than quietly on `undefined.run`.
  const { trials, runner, trialsRoot } = deps;
  if (!trials || !runner || !trialsRoot) {
    throw new Error('dispatchTrial called without trials, a runner or a trials root — check trialsReady first');
  }
  const root = path.join(trialsRoot, spec.slug);

  // What this trial is *about*, when the app also exists in a configured store — so the result
  // can be put beside what that subject currently carries. A branch adding a new app has no
  // counterpart, which is a normal PR and not an error.
  const match = resolveSubjectKey(spec.subject, deps.known?.() ?? []);

  const record: TrialRecord = {
    slug: spec.slug,
    kind: spec.upload_id ? 'upload' : 'ref',
    ...(spec.upload_id ? { upload_id: spec.upload_id } : {}),
    repo: spec.repo,
    ref: spec.ref,
    apps_path: spec.apps_path,
    subject: spec.subject,
    ...(match.kind === 'ok' ? { compare_to: match.key } : {}),
    started_at: startedAt,
  };
  await trials.add(record);

  deps.events?.log({
    level: 'info',
    code: 'TRIAL_STARTED',
    message: spec.upload_id
      ? `Trialling ${spec.subject} from uploaded files (session ${spec.upload_id})`
      : `Trialling ${spec.subject} from ${spec.repo}@${spec.ref}`,
    detail: { slug: spec.slug, repo: spec.repo, ref: spec.ref, subject: spec.subject },
  });
  if (spec.upload_id) await deps.uploads?.setTrial(spec.upload_id, spec.slug);

  /** How this trial is named in the log. "at main" would be a lie about supplied files. */
  const what = spec.upload_id ? 'uploaded files' : spec.ref;

  void runner
    .run({
      // The slug is the synthetic origin, so the report path machinery is untouched.
      subject: subjectKey(spec.slug, spec.subject),
      try_n: 1,
      trial: {
        repo: spec.repo,
        ref: spec.ref,
        apps_path: spec.apps_path,
        root,
        ...(spec.source ? { source: spec.source } : {}),
        ...(spec.store_url ? { store_url: spec.store_url } : {}),
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
          message: `Trial of ${spec.subject} at ${what} — ${outcome.verdict}`,
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
        message: `Trial of ${spec.subject} at ${what} did not complete — ${reason}`,
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
