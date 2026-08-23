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
import type { AssayRecord, SubjectState, ReportResponse } from '@shared/types';
import type { TrialRecord, TrialRequest, TrialResponse } from '@shared/trials';
import type {
  AlertsResponse,
  BenchesResponse,
  ChatMessage,
  ChatState,
  EventsResponse,
  PushStatus,
  RunStatus,
} from '@shared/activity';
import type { ScheduleResponse } from '@shared/schedule';
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

/**
 * The same rules, for an endpoint that answers in markdown.
 *
 * `fix.md` is a document, not a payload — asking for JSON and unwrapping a string field
 * would put an encoding between the audit's words and the person reading them.
 */
async function getText(path: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { headers: { accept: 'text/markdown, text/plain' } });
  } catch {
    throw new ApiError(0, 'The API is not reachable.');
  }
  const body = await res.text();
  if (!res.ok) {
    // The error path still answers in JSON, so read it if it looks like one.
    let msg = `Request failed with ${res.status}.`;
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (parsed.error) msg = String(parsed.error);
    } catch {
      /* not JSON; keep the status line */
    }
    throw new ApiError(res.status, msg);
  }
  return body;
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

/** Automated mode: the switch, the queue, and what the last tick decided. */
export function getSchedule(): Promise<ScheduleResponse> {
  return get<ScheduleResponse>('/schedule');
}

/**
 * Start or stop automated mode.
 *
 * The response is the fresh state, so the page never has to guess what the switch did — on
 * start the server has already run a tick by the time this resolves, and `last_tick` says
 * whether it claimed anything or why it did not.
 */
export function setArmed(armed: boolean): Promise<ScheduleResponse> {
  return post<ScheduleResponse>('/schedule/arm', { armed });
}

/** Decide now rather than at the top of the hour. Claims only if armed. */
export function tickNow(): Promise<ScheduleResponse> {
  return post<ScheduleResponse>('/schedule/tick');
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
  /** A `leaf` is one section of an audit; its id is the section id. */
  kind: 'orchestrator' | 'leaf';
  /** Where it sits in a run, and what it cannot run without. */
  order?: number;
  requires?: string[];
  phases?: { id: string; label?: string }[];
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

// ── this instance: the context prompt, and the config it booted with ───────────────────

/** The administrator's standing instructions — `data/context.md`. */
export interface ContextDoc {
  text: string;
  bytes: number;
  /** null when nothing has ever been written. */
  modified_at: string | null;
  path: string;
  max_bytes: number;
}

/** The effective config — defaults merged with `config.yaml`, credentials redacted. */
export interface ConfigResponse {
  path: string | null;
  loaded_at: string;
  config: Record<string, unknown> | null;
}

export function getContext(): Promise<ContextDoc> {
  return get<ContextDoc>('/settings/context');
}

/** Takes effect on the operator's next message, not on the next restart. */
export function saveContext(text: string): Promise<ContextDoc> {
  return put<ContextDoc>('/settings/context', { text });
}

export function getConfig(): Promise<ConfigResponse> {
  return get<ConfigResponse>('/config');
}

// ── auditing one app by hand ───────────────────────────────────────────────────────────

/**
 * Start an audit and return immediately.
 *
 * The server does not hold the request open, because a real audit runs for five to ten
 * minutes and a proxy closing the socket at minute four is indistinguishable from a failure.
 * Poll `getAssayStatus` and read `last` when `running` clears.
 */
export function startAssay(subject: string): Promise<{ started: boolean }> {
  return post<{ started: boolean }>('/assays', { subject });
}

/** The run in flight, its progress and the last one to finish. See `data/runStatus.ts`:
 *  nothing should call this directly on a timer — there is one poller and everything shares it. */
export function getAssayStatus(): Promise<RunStatus> {
  return get<RunStatus>('/assays/current');
}

/**
 * The audit, addressed to whoever has to fix the app. Markdown, meant to be pasted into an
 * assistant or handed to a dev — see `server/domain/fixreport.ts`.
 */
export function getFixReport(name: string): Promise<string> {
  return getText(`/subjects/${encodeURIComponent(name)}/fix.md`);
}

// ── the public board ──────────────────────────────────────────────────
// The three calls the read-only board makes, and the only three. Kept apart from the operator
// calls above deliberately: `/public/*` is the one prefix that may be served without a login,
// so the pages under `/public` must be provably unable to reach anything else. A public page
// that quietly used `getSubjects()` would work in dev and 401 in production, which is the
// worst way to find out.

export function getPublicSubjects(): Promise<SubjectState[]> {
  return get<SubjectState[]>('/public/subjects');
}

/** The row alone. No history and no run state — see `server/routes/public.ts`. */
export function getPublicSubject(name: string): Promise<SubjectState> {
  return get<SubjectState>(`/public/subjects/${encodeURIComponent(name)}`);
}

/** The same brief `getFixReport` serves, from the prefix an app author can actually reach. */
export function getPublicFixReport(name: string): Promise<string> {
  return getText(`/public/subjects/${encodeURIComponent(name)}/fix.md`);
}

// ── trials ───────────────────────────────────────────────────────────────────────────────
// Auditing a ref without touching what a subject carries. See `shared/trials.ts` for why the
// results live somewhere the archive does not look.

export function getTrials(): Promise<{ trials: TrialRecord[] }> {
  return get<{ trials: TrialRecord[] }>('/trials');
}

export function getTrial(slug: string): Promise<TrialResponse & { history: AssayRecord[] }> {
  return get<TrialResponse & { history: AssayRecord[] }>(`/trials/${encodeURIComponent(slug)}`);
}

/**
 * Start a trial. Returns as soon as it is accepted, like `startAssay` and for the same reason.
 */
export function startTrial(body: TrialRequest): Promise<{ started: boolean; trial: TrialRecord }> {
  return post<{ started: boolean; trial: TrialRecord }>('/trials', body);
}

/** Drops the row, its reports and its store zip — a trial and its evidence have one lifetime. */
export async function deleteTrial(slug: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/trials/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new ApiError(0, 'The API is not reachable.');
  }
  if (!res.ok) throw new ApiError(res.status, `Could not delete the trial (${res.status}).`);
}

export function getTrialReport(slug: string, file: string): Promise<ReportResponse> {
  return get<ReportResponse>(
    `/trials/${encodeURIComponent(slug)}/reports/${encodeURIComponent(file)}`,
  );
}

// ── watching the run ─────────────────────────────────────────────────────────────────────
// The browser sidecar publishes no port and does not announce itself, so these proxied paths
// are the only way to see it — see `server/routes/browser.ts`.

export interface BrowserPage {
  pageId: string;
  owner: string | null;
  url: string;
  title: string;
  idleForMs?: number;
}

export interface BrowserPages {
  pages: BrowserPage[];
  /** The isolated context of the audit in flight, when there is one. */
  context: string | null;
  /** Whether the list was narrowed to that context, so the UI can say "all tabs" honestly. */
  filtered: boolean;
  live_prefix: string;
  vnc_url: string;
  /** Present when the sidecar could not be reached — a state, not an error. */
  unreachable?: string;
}

export function getBrowserPages(all = false): Promise<BrowserPages> {
  return get<BrowserPages>(`/browser/pages${all ? '?all=1' : ''}`);
}

/**
 * A still of the whole browser. Cache-busted on purpose: the point is that it changes.
 * Used where the per-tab screencast is unavailable (browser-mcp before 1.1.6).
 */
export function browserStillUrl(nonce: number): string {
  return `${BASE}/browser/screenshot?t=${nonce}`;
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

// ── the administrator chat ───────────────────────────────────────────────────────────────

export function getChat(): Promise<ChatState> {
  return get<ChatState>('/chat');
}

export async function clearChat(): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat`, { method: 'DELETE', headers: { accept: 'application/json' } });
  } catch {
    throw new ApiError(0, 'The API is not reachable.');
  }
  if (!res.ok) throw new ApiError(res.status, await errorFrom(res));
}

/** The `{ error }` body the API answers refusals with, or a sentence about the status code. */
async function errorFrom(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as unknown;
    if (body && typeof body === 'object' && 'error' in body) {
      return String((body as { error: unknown }).error);
    }
  } catch {
    /* not JSON */
  }
  return `Request failed with ${res.status}.`;
}

/**
 * Send one message and read the rows back as they are written.
 *
 * Server-sent events rather than polling, because a turn takes tens of seconds and shows its
 * work: the tool it called, what came back, then the answer. Waiting for all of that and
 * rendering it at once would be a worse answer than the same rows arriving as they land.
 *
 * Frames are `event: <name>\ndata: <json>` separated by a blank line, and a comment frame
 * (`: ping`) has no event line at all — that is the heartbeat, and it is skipped.
 */
export async function streamChatTurn(
  message: string,
  handlers: { onMessage: (row: ChatMessage) => void; onError?: (error: string) => void },
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/chat/messages`, {
      method: 'POST',
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
  } catch {
    throw new ApiError(0, 'The API is not reachable.');
  }

  // A refusal arrives as ordinary JSON before the stream starts, which is what makes "the
  // agent is down" a sentence rather than an empty stream the page has to interpret.
  if (!res.ok || !res.body) {
    throw new ApiError(res.status, res.ok ? 'The assistant sent no answer.' : await errorFrom(res));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      split = buffer.indexOf('\n\n');

      const name = /^event: (.+)$/m.exec(frame)?.[1];
      if (!name) continue; // a heartbeat
      const dataAt = frame.indexOf('data: ');
      if (dataAt === -1) continue;
      const payload = JSON.parse(frame.slice(dataAt + 6)) as unknown;

      if (name === 'message') handlers.onMessage(payload as ChatMessage);
      else if (name === 'error') handlers.onError?.(String((payload as { error?: string }).error ?? 'failed'));
    }
  }
}
