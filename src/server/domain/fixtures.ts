/**
 * A hand-written archive, small enough to reason about and shaped like the real one.
 *
 * It exists for two reasons: the tests in this stream need known-good data that does not
 * wait on stream A's importer, and `registerRoutes` needs something to serve when no store
 * is injected, so `yarn dev` shows a working page from the first commit. It is NOT the
 * fixture corpus of MVP.md §6 — that is five real reports under `test/fixtures/`, owned by
 * stream A, and it replaces this the moment the real store is wired in.
 *
 * The numbers are chosen to reproduce the MVP-0 acceptance facts: `cpu_shares on reserved
 * tier 10` spans five subjects, `E9 auth gate` is unverified on three, and every
 * functional leg but one is blocked.
 */

import type { AssayMeta, AssayRecord, Finding, Leg } from '../../shared/types.js';
import type { AssayStore, StoredReport } from './store.js';
import { riskScore, topSeverity } from './severity.js';

const CPU_SHARES: Finding = {
  rule: '',
  title: 'cpu_shares on reserved tier 10',
  severity: 'minor',
  status: 'fail',
  note: 'reserved tier expects 10; compose sets 90',
};

const DESCRIPTIONS: Finding = {
  rule: '',
  title: 'no volume/env descriptions',
  severity: 'minor',
  status: 'fail',
};

const D2_FAIL: Finding = {
  rule: 'D2',
  title: 'root + user dir, no rationale.md',
  severity: 'major',
  status: 'fail',
  note: 'mounts /DATA/Downloads and /DATA/Media as root',
};

const D1_PASS: Finding = { rule: 'D1', title: 'permission strategy', severity: 'none', status: 'pass' };

const E9_UNVERIFIED: Finding = {
  rule: 'E9',
  title: 'auth gate unverified',
  severity: 'critical',
  status: 'unverified',
  note: 'AuthenticationRequired defaults to DisabledForLocalAddresses; every request arrives from Caddy over pcs',
};

const A_CRITICAL: Finding = {
  rule: 'A',
  title: 'admin API reachable without a session',
  severity: 'critical',
  status: 'fail',
};

export interface Draft {
  subject: string;
  leg: Leg;
  at: string;
  status?: AssayMeta['status'];
  verdict?: AssayMeta['verdict'];
  findings?: Finding[];
  blocked_reason?: string | null;
  body?: string;
}

const bodies = new Map<string, string>();

function draft(d: Draft): AssayRecord {
  const findings = d.findings ?? [];
  const status = d.status ?? 'done';
  const done = status === 'done';
  const verdict =
    d.verdict !== undefined ? d.verdict : done ? (topSeverity(findings) === 'none' ? 'compliant' : 'non-compliant') : null;

  const meta: AssayMeta = {
    subject: d.subject,
    leg: d.leg,
    standard: d.leg === 'static' ? 'Static Review Protocol' : 'Functional Review Protocol',
    standard_version: 3,
    status,
    verdict,
    top_severity: topSeverity(findings),
    risk_score: done ? riskScore(findings) : 0,
    blocked_reason: d.blocked_reason ?? null,
    subject_ref: `Yundera/AppStore@main:Apps/${d.subject}`,
    started_at: d.at,
    finished_at: done ? d.at : '',
    findings,
  };

  const file = `${d.at.replace(/:/g, '-')}-${d.leg}.md`;
  const path = `${d.subject}/${file}`;
  bodies.set(
    path,
    d.body ??
      [
        `# Yundera/AppStore — ${d.subject}`,
        '',
        `**Verdict: ${String(verdict ?? status).toUpperCase()} · risk ${meta.risk_score}**`,
        '',
        '## Tech & Documentation',
        '',
        findings.length
          ? findings.map((f) => `- ${f.rule || '—'} — ${f.title ?? ''} (${f.status})`).join('\n')
          : '_nothing recorded_',
        '',
        '## Evidence',
        '',
        '```yaml',
        `cpu_shares: 90`,
        '```',
      ].join('\n'),
  );

  return { meta, path, subject: d.subject, file };
}

/**
 * Build one record. Verdict, tier and risk are derived from the findings unless overridden,
 * so a fixture cannot quietly disagree with the algebra it is meant to exercise.
 */
export const makeRecord = draft;

/** Newest last; the domain sorts. */
export const FIXTURE_RECORDS: AssayRecord[] = [
  // OpenClaw — a Critical regression on static, and a functional leg that was compliant
  // in July and is blocked today. The blocked leg must NOT show July's verdict.
  draft({ subject: 'OpenClaw', leg: 'static', at: '2026-07-20T09:00:00Z', findings: [D1_PASS] }),
  draft({
    subject: 'OpenClaw',
    leg: 'static',
    at: '2026-08-05T09:14:22Z',
    findings: [A_CRITICAL, D2_FAIL, E9_UNVERIFIED, CPU_SHARES, DESCRIPTIONS, D1_PASS],
  }),
  draft({ subject: 'OpenClaw', leg: 'functional', at: '2026-07-01T10:00:00Z', findings: [] }),
  draft({
    subject: 'OpenClaw',
    leg: 'functional',
    at: '2026-08-05T09:31:00Z',
    status: 'blocked',
    blocked_reason: 'bench unavailable',
  }),

  // Prowlarr — the report ARCHITECTURE.md §4 is about: static ran, functional never did,
  // and the highest-value observation is filed as suspected-Critical.
  draft({
    subject: 'Prowlarr',
    leg: 'static',
    at: '2026-08-01T08:00:00Z',
    findings: [E9_UNVERIFIED, CPU_SHARES],
  }),
  draft({
    subject: 'Prowlarr',
    leg: 'functional',
    at: '2026-08-01T08:20:00Z',
    status: 'blocked',
    blocked_reason: 'bench unavailable',
  }),

  // Radarr — the one subject that is green on both legs.
  draft({ subject: 'Radarr', leg: 'static', at: '2026-07-30T08:00:00Z', findings: [CPU_SHARES, D1_PASS] }),
  draft({ subject: 'Radarr', leg: 'functional', at: '2026-07-30T08:40:00Z', findings: [D1_PASS] }),

  draft({
    subject: 'Sonarr',
    leg: 'static',
    at: '2026-07-29T08:00:00Z',
    findings: [E9_UNVERIFIED, CPU_SHARES, DESCRIPTIONS],
  }),
  draft({
    subject: 'Sonarr',
    leg: 'functional',
    at: '2026-07-29T08:30:00Z',
    status: 'blocked',
    blocked_reason: 'bench unavailable',
  }),

  draft({ subject: 'qBittorrent', leg: 'static', at: '2026-07-28T08:00:00Z', findings: [CPU_SHARES] }),
  draft({
    subject: 'qBittorrent',
    leg: 'functional',
    at: '2026-07-28T08:30:00Z',
    status: 'blocked',
    blocked_reason: 'bench unavailable',
  }),

  draft({ subject: 'Caddy', leg: 'static', at: '2026-08-01T07:00:00Z', findings: [D2_FAIL] }),
  draft({
    subject: 'Caddy',
    leg: 'functional',
    at: '2026-08-01T07:30:00Z',
    status: 'blocked',
    blocked_reason: 'bench unavailable',
  }),

  // Beacon — never assayed statically; the "not yet run / —" row.
  draft({
    subject: 'Beacon',
    leg: 'functional',
    at: '2026-08-04T06:00:00Z',
    status: 'blocked',
    blocked_reason: 'bench unavailable',
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
