/**
 * The data layer. Every page calls these three functions and nothing else.
 *
 * There is no client-side fixture fallback. There used to be — the web stream was built
 * before the API existed and shipped a synthetic 69-subject dataset to stand in — but that
 * dataset ended up in the production bundle and, once the archive was real, it modelled a
 * schema the app no longer has. The server answers from `domain/fixtures.ts` when its index
 * is empty, so an empty archive is already handled one layer down, where there is exactly
 * one copy of it.
 */
import type { SubjectState, ReportResponse } from '@shared/types';
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
