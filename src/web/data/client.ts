/**
 * The data layer.
 *
 * Every page calls these five functions and nothing else. Each one tries the
 * real API first and falls back to the static fixture when the API is not
 * there — which is the normal condition while streams A and B are still being
 * built. The fallback is *visible*: `subscribeMode` drives a badge in the
 * top bar, because a UI silently showing invented numbers would be worse than
 * one that shows nothing.
 *
 * Override with `?data=fixture` / `?data=api` (sticky, stored in localStorage).
 */
import type { AssayRecord, RuleGroup, SubjectState, ReportResponse } from '@shared/types';
import type { DataMode, SubjectDetail, UnverifiedFinding } from '../types';
import * as fx from './fixtures';

const BASE = '/api/v1';
const STORE_KEY = 'touchstone.data';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ------------------------------------------------------------------- mode
type Forced = DataMode | null;

function readForced(): Forced {
  try {
    const q = new URLSearchParams(window.location.search).get('data');
    if (q === 'fixture' || q === 'api') {
      window.localStorage.setItem(STORE_KEY, q);
      return q;
    }
    const stored = window.localStorage.getItem(STORE_KEY);
    return stored === 'fixture' || stored === 'api' ? stored : null;
  } catch {
    return null;
  }
}

const forced: Forced = typeof window === 'undefined' ? null : readForced();

let mode: DataMode = forced ?? 'api';
/** Set once we have actually proven which source is answering. */
let settled = forced != null;

const listeners = new Set<(m: DataMode, settled: boolean) => void>();

export function getMode(): DataMode {
  return mode;
}
export function isModeSettled(): boolean {
  return settled;
}
export function isForced(): boolean {
  return forced != null;
}
export function subscribeMode(fn: (m: DataMode, settled: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function setMode(next: DataMode): void {
  const changed = mode !== next || !settled;
  mode = next;
  settled = true;
  if (changed) for (const fn of listeners) fn(mode, settled);
}

/** Flip the source at runtime; used by the badge in the top bar. */
export function forceMode(next: DataMode): void {
  try {
    window.localStorage.setItem(STORE_KEY, next);
  } catch {
    /* private mode — the reload below still applies the query param */
  }
  const url = new URL(window.location.href);
  url.searchParams.set('data', next);
  window.location.href = url.toString();
}

// ---------------------------------------------------------------- request
/**
 * A 4xx with a JSON body is the API answering properly and must surface as an
 * error. A network failure, a 5xx, or a non-JSON body (Vite handing back
 * index.html because nothing is listening on 8080) means the API is not there,
 * and we quietly switch to the fixture.
 */
async function get<T>(path: string, fallback: () => Promise<T>): Promise<T> {
  if (mode === 'fixture') return fallback();

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  } catch {
    if (forced === 'api') throw new ApiError(0, 'The API is not reachable.');
    setMode('fixture');
    return fallback();
  }

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json') || res.status >= 500) {
    if (forced === 'api') {
      throw new ApiError(res.status, `The API returned ${res.status} (${ct || 'no content type'}).`);
    }
    setMode('fixture');
    return fallback();
  }

  const body = (await res.json()) as unknown;
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with ${res.status}.`;
    setMode('api');
    throw new ApiError(res.status, msg);
  }

  setMode('api');
  return body as T;
}

// ------------------------------------------------------------------- api
export function getSubjects(): Promise<SubjectState[]> {
  return get<SubjectState[]>('/subjects', fx.loadSubjects);
}

export function getSubject(name: string): Promise<SubjectDetail> {
  return get<SubjectDetail>(`/subjects/${encodeURIComponent(name)}`, async () => {
    const [subjects, histories] = await Promise.all([fx.loadSubjects(), fx.loadHistories()]);
    const subject = subjects.find((s) => s.name === name);
    if (!subject) throw new ApiError(404, `No subject named "${name}".`);
    const history: AssayRecord[] = histories[name] ?? [];
    return { subject, history };
  });
}

export function getReport(subject: string, file: string): Promise<ReportResponse> {
  return get<ReportResponse>(
    `/reports/${encodeURIComponent(subject)}/${encodeURIComponent(file)}`,
    async () => {
      const reports = await fx.loadReports();
      const r = reports[`${subject}/${file}`];
      if (!r) throw new ApiError(404, `No report file at ${subject}/${file}.`);
      return r;
    },
  );
}

export function getRuleGroups(): Promise<RuleGroup[]> {
  return get<RuleGroup[]>('/findings?group=rule', fx.loadRuleGroups);
}

export function getUnverified(): Promise<UnverifiedFinding[]> {
  return get<UnverifiedFinding[]>('/findings?status=unverified', fx.loadUnverified);
}
