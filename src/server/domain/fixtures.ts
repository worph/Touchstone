/**
 * A hand-written archive, small enough to reason about and shaped like the real one.
 *
 * It exists so `registerRoutes` has something to serve when no store is injected — `yarn dev`
 * shows a working page before the importer has ever run — and so the route tests do not wait
 * on a corpus. The real fixtures are five archived reports under `test/fixtures/`.
 *
 * Each draft states its own verdict, tier and risk, because that is how a real assay arrives:
 * the agent declares them and the report's headline is rendered from them (ARCHITECTURE.md
 * principle 3). Nothing here derives a verdict from anything.
 */

import { DEFAULT_ORIGIN } from '../../shared/subject.js';
import { recordFor } from '../store/reports.js';
import type { AssayMeta, AssayRecord, Section, Severity, Verdict } from '../../shared/types.js';
import type { AssayStore, StoredReport } from './store.js';

export interface Draft {
  subject: string;
  /**
   * Any section id, not the deprecated two-value `Leg`. Invariant 2: nothing enumerates the
   * sections, so a fixture that could only be `static` or `functional` could not stand in for
   * a reading, or for a section the protocol directory has since dropped.
   */
  leg: Section;
  at: string;
  status?: AssayMeta['status'];
  verdict?: Verdict | null;
  top_severity?: Severity;
  risk_score?: number;
  blocked_reason?: string | null;
  body?: string;
}

const bodies = new Map<string, string>();

function draft(d: Draft): AssayRecord {
  const status = d.status ?? 'done';
  const done = status === 'done';
  const severity = d.top_severity ?? 'none';
  const verdict = d.verdict !== undefined ? d.verdict : done ? (severity === 'none' ? 'compliant' : 'non-compliant') : null;
  const risk = done ? (d.risk_score ?? 0) : 0;

  const meta: AssayMeta = {
    subject: d.subject,
    section: d.leg,
    standard: d.leg === 'static' ? 'Static Review Protocol' : 'Functional Review Protocol',
    standard_version: 3,
    status,
    verdict,
    top_severity: severity,
    risk_score: risk,
    blocked_reason: d.blocked_reason ?? null,
    origin: DEFAULT_ORIGIN,
    subject_ref: `Yundera/AppStore@main:Apps/${d.subject}`,
    started_at: d.at,
    finished_at: done ? d.at : '',
  };

  const file = `${d.at.replace(/:/g, '-')}-${d.leg}.md`;
  // Three levels, like the real archive — these records back the route tests and the
  // no-data-dir dev fallback, and a two-level path here would make every report link 404.
  const path = `${DEFAULT_ORIGIN}/${d.subject}/${file}`;
  bodies.set(
    path,
    d.body ??
      [
        `# Yundera/AppStore — ${d.subject}`,
        '',
        `**VERDICT: ${String(verdict ?? status).toUpperCase()} · ${severity} · risk_score ${risk}**`,
        '',
        '## Tech & Documentation',
        '',
        '| Item | Verdict | Notes |',
        '| --- | --- | --- |',
        '| Permission strategy | pass | `$PUID:$PGID` within /DATA |',
        '',
        '## Evidence',
        '',
        '```yaml',
        'cpu_shares: 90',
        '```',
      ].join('\n'),
  );

  return recordFor(meta, path);
}

/** Build one record. Anything unstated defaults the way a clean assay would. */
export const makeRecord = draft;

/** Newest last; the domain sorts. */
export const FIXTURE_RECORDS: AssayRecord[] = [
  // OpenClaw — a Critical static verdict, and a functional leg that was compliant in July
  // and is blocked today. The blocked leg must NOT show July's verdict.
  draft({ subject: 'OpenClaw', leg: 'static', at: '2026-07-20T09:00:00Z' }),
  draft({
    subject: 'OpenClaw',
    leg: 'static',
    at: '2026-08-05T09:14:22Z',
    top_severity: 'critical',
    risk_score: 232,
  }),
  draft({ subject: 'OpenClaw', leg: 'functional', at: '2026-07-01T10:00:00Z' }),
  draft({
    subject: 'OpenClaw',
    leg: 'functional',
    at: '2026-08-05T09:31:00Z',
    status: 'blocked',
    blocked_reason: 'bench_unavailable',
  }),

  // Prowlarr — static ran, functional never did. The pair the product exists to tell apart.
  draft({
    subject: 'Prowlarr',
    leg: 'static',
    at: '2026-08-01T08:00:00Z',
    top_severity: 'major',
    risk_score: 13,
  }),
  draft({
    subject: 'Prowlarr',
    leg: 'functional',
    at: '2026-08-01T08:20:00Z',
    status: 'blocked',
    blocked_reason: 'bench_unavailable',
  }),

  // Radarr — the one subject that is green on both legs.
  draft({ subject: 'Radarr', leg: 'static', at: '2026-07-30T08:00:00Z' }),
  draft({ subject: 'Radarr', leg: 'functional', at: '2026-07-30T08:40:00Z' }),

  draft({
    subject: 'Sonarr',
    leg: 'static',
    at: '2026-07-29T08:00:00Z',
    top_severity: 'minor',
    risk_score: 3,
  }),
  draft({
    subject: 'Sonarr',
    leg: 'functional',
    at: '2026-07-29T08:30:00Z',
    status: 'blocked',
    blocked_reason: 'bench_unavailable',
  }),

  draft({
    subject: 'qBittorrent',
    leg: 'static',
    at: '2026-07-28T08:00:00Z',
    top_severity: 'minor',
    risk_score: 1,
  }),
  draft({
    subject: 'qBittorrent',
    leg: 'functional',
    at: '2026-07-28T08:30:00Z',
    status: 'blocked',
    blocked_reason: 'bench_unavailable',
  }),

  draft({
    subject: 'Caddy',
    leg: 'static',
    at: '2026-08-01T07:00:00Z',
    top_severity: 'major',
    risk_score: 21,
  }),
  draft({
    subject: 'Caddy',
    leg: 'functional',
    at: '2026-08-01T07:30:00Z',
    status: 'blocked',
    blocked_reason: 'bench_unavailable',
  }),

  // A subject mid-run: the `◴ running` row, claimed but not finished.
  draft({
    subject: 'Netdata',
    leg: 'static',
    at: '2026-08-07T13:00:00Z',
    status: 'running',
  }),

  // Beacon — never assayed statically; the "not yet run / —" row.
  draft({
    subject: 'Beacon',
    leg: 'functional',
    at: '2026-08-04T06:00:00Z',
    status: 'blocked',
    blocked_reason: 'bench_unavailable',
  }),
];

/** An `AssayStore` over records held in memory. Also useful in tests with a custom set. */
export function memoryStore(
  records: readonly AssayRecord[] = FIXTURE_RECORDS,
  reportBodies: ReadonlyMap<string, string> = bodies,
): AssayStore {
  const snapshot = [...records];
  return {
    all: () => snapshot,
    forSubject: (name: string) => snapshot.filter((r) => r.subject === name),
    latest: (subject, leg) =>
      snapshot
        .filter((r) => r.subject === subject && r.meta.leg === leg && r.meta.status === 'done')
        .sort((a, b) => Date.parse(b.meta.finished_at) - Date.parse(a.meta.finished_at))[0] ?? null,
    read: (path: string): StoredReport | null => {
      const record = snapshot.find((r) => r.path === path);
      const body = reportBodies.get(path);
      if (!record || body === undefined) return null;
      return { meta: record.meta, body };
    },
  };
}

/** The store the routes use when nothing is injected. */
export function fixtureStore(): AssayStore {
  return memoryStore();
}
