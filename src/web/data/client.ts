/**
 * The data layer. Every page calls these functions and nothing else.
 *
 * There is no client-side fixture fallback. There used to be — the web stream was built
 * before the API existed and shipped a synthetic 69-subject dataset to stand in — but that
 * dataset ended up in the production bundle and, once the archive was real, it modelled a
 * schema the app no longer has. The server answers from `domain/fixtures.ts` when its index
 * is empty, so an empty archive is already handled one layer down, where there is exactly
 * one copy of it.
 */
import type { SubjectState, ReportResponse } from '@shared/types';
import type {
  AlertsResponse,
  BenchesResponse,
  EventsResponse,
  PushStatus,
} from '@shared/activity';
import type { SubjectDetail } from '../types';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * A 4xx with a JSON body is the API answering properly and must surface as an error. A
 * network failure, a 5xx, or a non-JSON body (Vite handing back index.html because nothing
 * is listening on the API port) means the API is not there, and that is worth saying
 * plainly rather than rendering an empty page.
 */
async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'The API is not reachable.');
  }

  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) {
    throw new ApiError(res.status, `The API returned ${res.status} (${ct || 'no content type'}).`);
  }

  const body = (await res.json()) as unknown;
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed with ${res.status}.`;
    throw new ApiError(res.status, msg);
  }

  return body as T;
}

// ------------------------------------------------------------------- api
export function getSubjects(): Promise<SubjectState[]> {
  return get<SubjectState[]>('/subjects');
}

export function getSubject(name: string): Promise<SubjectDetail> {
  return get<SubjectDetail>(`/subjects/${encodeURIComponent(name)}`);
}

export function getReport(subject: string, file: string): Promise<ReportResponse> {
  return get<ReportResponse>(
    `/reports/${encodeURIComponent(subject)}/${encodeURIComponent(file)}`,
  );
}

/**
 * A POST with no body to read. The three that exist — probe, subscribe, unsubscribe — are
 * all actions whose result is the new state, so they return the same shape as the GET.
 */
async function post<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'The API is not reachable.');
  }
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('json')) {
    throw new ApiError(res.status, `The API returned ${res.status} (${ct || 'no content type'}).`);
  }
  const parsed = (await res.json()) as unknown;
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed with ${res.status}.`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

// ---------------------------------------------------------------- activity
export interface EventFilters {
  level?: string;
  category?: string;
  subject?: string;
  limit?: number;
}

export function getEvents(filters: EventFilters = {}): Promise<EventsResponse> {
  const q = new URLSearchParams();
  if (filters.level && filters.level !== 'all') q.set('level', filters.level);
  if (filters.category && filters.category !== 'all') q.set('category', filters.category);
  if (filters.subject && filters.subject !== 'all') q.set('subject', filters.subject);
  if (filters.limit) q.set('limit', String(filters.limit));
  const qs = q.toString();
  return get<EventsResponse>(`/events${qs ? `?${qs}` : ''}`);
}

export function getAlerts(): Promise<AlertsResponse> {
  return get<AlertsResponse>('/alerts');
}

export function getBenches(): Promise<BenchesResponse> {
  return get<BenchesResponse>('/benches');
}

/** The `probe` / `probe all` buttons. Safe to press repeatedly — the server coalesces. */
export function probeBenches(): Promise<BenchesResponse> {
  return post<BenchesResponse>('/benches/probe');
}

async function put<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'PUT',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'The API is not reachable.');
  }
  const parsed = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const msg =
      parsed && typeof parsed === 'object' && 'error' in parsed
        ? String((parsed as { error: unknown }).error)
        : `Request failed with ${res.status}.`;
    throw new ApiError(res.status, msg);
  }
  return parsed as T;
}

// ── the protocol ───────────────────────────────────────────────────────────────────────

export interface ProtocolSummary {
  id: string;
  name: string;
  version: number;
  kind: 'orchestrator' | 'leaf';
  leg?: 'static' | 'functional';
  requires_bench?: boolean;
  imported_from?: string;
  file: string;
  bytes: number;
  modified_at: string;
}

export interface ProtocolDoc {
  meta: ProtocolSummary;
  body: string;
  html: string;
  file: string;
  bytes: number;
  modified_at: string;
}

export function getProtocols(): Promise<{ directory: string | null; protocols: ProtocolSummary[] }> {
  return get('/protocols');
}

export function getProtocol(id: string): Promise<ProtocolDoc> {
  return get<ProtocolDoc>(`/protocols/${encodeURIComponent(id)}`);
}

/** Saving bumps the version, because every assay records the version it was graded against. */
export function saveProtocol(id: string, body: string): Promise<ProtocolDoc> {
  return put<ProtocolDoc>(`/protocols/${encodeURIComponent(id)}`, { body });
}

// ── auditing one app by hand ───────────────────────────────────────────────────────────

export interface AssayStatus {
  enabled: boolean;
  /** What the running audit has settled so far. `null` when nothing is running. */
  progress: {
    verified: number;
    applicable: number;
    passed: number;
    failed: number;
    unverified: number;
    of_canonical: number;
    phases: number;
  } | null;
  running: { subject: string; depth: 'static' | 'full'; started_at: string } | null;
  last: {
    subject: string;
    depth: 'static' | 'full';
    started_at: string;
    finished_at: string;
    outcome:
      | { kind: 'verdict'; verdict: string; risk: number; files: string[] }
      | { kind: 'error'; reason: string }
      | { kind: 'agent_busy' }
      | { kind: 'blocked'; reason: string };
  } | null;
}

/**
 * Start an audit and return immediately.
 *
 * The server does not hold the request open, because a real audit runs for five to ten
 * minutes and a proxy closing the socket at minute four is indistinguishable from a failure.
 * Poll `getAssayStatus` and read `last` when `running` clears.
 */
export function startAssay(subject: string, depth: 'static' | 'full'): Promise<{ started: boolean }> {
  return post<{ started: boolean }>('/assays', { subject, depth });
}

export function getAssayStatus(): Promise<AssayStatus> {
  return get<AssayStatus>('/assays/current');
}

export function getPushStatus(): Promise<PushStatus> {
  return get<PushStatus>('/push');
}

export function subscribePush(sub: unknown): Promise<PushStatus> {
  return post<PushStatus>('/push/subscribe', sub);
}

export function unsubscribePush(endpoint: string): Promise<PushStatus> {
  return post<PushStatus>('/push/unsubscribe', { endpoint });
}
