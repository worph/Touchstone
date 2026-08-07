/**
 * The static fixture, shaped exactly per MVP.md §5.
 *
 * Generated so the numbers on screen are the ones in UX.md §2.1 and §2.3:
 *   69 subjects · static 12 ✓ / 19 ⛔ / 38 not yet · total risk 1407
 *   functional 1 ✓ / 49 blocked / 1 running / 18 not yet
 *   cpu_shares 5 · descriptions 14 · D2 6 · E9 unverified 11 (risk 1100) · D1 pass 9
 *
 * Loaded lazily so the fixture never lands in the main bundle once the API is
 * up and nothing calls it.
 */
import type { AssayRecord, RuleGroup, SubjectState } from '@shared/types';
import type { ReportResponse } from '@shared/types';
import type { UnverifiedFinding } from '../types';

export const loadSubjects = (): Promise<SubjectState[]> =>
  import('../fixtures/subjects.json').then((m) => m.default as unknown as SubjectState[]);

export const loadHistories = (): Promise<Record<string, AssayRecord[]>> =>
  import('../fixtures/histories.json').then(
    (m) => m.default as unknown as Record<string, AssayRecord[]>,
  );

export const loadReports = (): Promise<Record<string, ReportResponse>> =>
  import('../fixtures/reports.json').then(
    (m) => m.default as unknown as Record<string, ReportResponse>,
  );

export const loadRuleGroups = (): Promise<RuleGroup[]> =>
  import('../fixtures/findings-by-rule.json').then((m) => m.default as unknown as RuleGroup[]);

export const loadUnverified = (): Promise<UnverifiedFinding[]> =>
  import('../fixtures/findings-unverified.json').then(
    (m) => m.default as unknown as UnverifiedFinding[],
  );
