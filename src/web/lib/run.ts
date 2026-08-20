/**
 * Reading the run in flight. Pure functions, so the sentences the UI prints are testable
 * without a browser and without a running audit.
 *
 * The distinction this file keeps: **how far along** and **what it is doing** are different
 * questions. `7 of 24` answers the first; `E9 auth gate — pass` answers the second, and only
 * the second tells a slow run from a stuck one.
 */

import {
  PHASE_LABEL,
  type LastRun,
  type RunLive,
  type RunProgress,
  type SectionProgress,
} from '@shared/activity';
import type { RecordedPhase, RecordedRequirement, Section } from '@shared/types';

export function mmss(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function elapsedSeconds(startedAt: string | undefined, now = Date.now()): number {
  const started = Date.parse(startedAt ?? '');
  if (!Number.isFinite(started)) return 0;
  return Math.max(0, Math.floor((now - started) / 1000));
}

/**
 * Which sections this run is actually producing an assay for.
 *
 * The sections it is *running*, not the ones the protocol defines: a run whose bench vanished
 * skips the sections that needed one, and marking their cells "running" when nothing is
 * running them would be a lie the UI tells for four more minutes and then contradicts.
 *
 * Empty until the run has probed its prerequisites, which is a beat after it starts.
 */
export function liveLegs(live: RunLive | null | undefined): Section[] {
  return live?.sections ?? [];
}

/** `7/24`, or empty when the protocol's list has not been counted yet. */
export function progressLabel(progress: RunProgress | null | undefined): string {
  if (!progress || progress.of_canonical <= 0) return '';
  return `${progress.verified}/${progress.of_canonical}`;
}

/** 0–1, for a bar. Null when there is nothing to be a fraction of. */
export function progressRatio(progress: RunProgress | null | undefined): number | null {
  if (!progress || progress.of_canonical <= 0) return null;
  return Math.min(1, progress.verified / progress.of_canonical);
}

export interface PhaseStep {
  id: string;
  label: string;
  result?: 'pass' | 'fail' | 'errored' | 'n-a';
  at?: string;
}

/**
 * A plan and what has been recorded against it, as one list.
 *
 * `section` narrows the recorded side: two sections may both name a phase `A`, and a phase
 * recorded by one of them must not colour the other's pill. A phase with no section at all
 * predates the attribution and is let through — dropping it would lose the only evidence
 * there is.
 */
function mergeTrack(
  plan: { id: string; label: string }[],
  recorded: RecordedPhase[],
  section?: Section,
): PhaseStep[] {
  if (plan.length === 0) return [];
  const hits = new Map(
    recorded
      .filter((p) => !section || p.section === undefined || p.section === section)
      .map((p) => [p.phase, p]),
  );
  return plan.map((step) => {
    const hit = hits.get(step.id);
    return {
      id: step.id,
      label: step.label,
      ...(hit ? { result: hit.result, at: hit.at } : {}),
    };
  });
}

/**
 * The run as one row per section: its own fraction, and its own phase track.
 *
 * This is the shape the card draws. A single `18 of 25` merges two independent sections into
 * a number that is true of neither, and a phase track floating beside it belongs to a section
 * the card never names — so a run twelve-fourteenths through `static` with `functional` not
 * yet started reads as a stalled run with a dead track. One row each fixes both.
 */
export interface SectionRow extends SectionProgress {
  /** 0–1, or null when there is nothing to be a fraction of yet. */
  ratio: number | null;
  /** This section's plan, merged with what it has actually recorded. */
  track: PhaseStep[];
}

export function sectionRows(progress: RunProgress | null | undefined): SectionRow[] {
  const rows = progress?.sections ?? [];
  const recorded = progress?.phases ?? [];
  return rows.map((row) => ({
    ...row,
    ratio: row.of_canonical > 0 ? Math.min(1, row.verified / row.of_canonical) : null,
    track: mergeTrack(row.phase_plan, recorded, row.id),
  }));
}

/**
 * The failure worth putting at the top of the card.
 *
 * The count says `1 failing` in grey and the row itself is one of five in a list — which is
 * the wrong weight for the only thing on the card anyone has to act on. There is no history
 * to search: `recent` is a five-row pulse, so this is the newest failure *still in it*, and
 * the count beside it is what says whether that is all of them.
 */
export function headlineFailure(progress: RunProgress | null | undefined): RecordedRequirement | null {
  return (progress?.recent ?? []).find((r) => r.verdict === 'fail') ?? null;
}

/**
 * The most recent thing the agent settled, in one clause.
 *
 * Phases and requirements are two streams and either may be the newest, so this compares
 * their timestamps rather than preferring one — during Phase C the newest news is a phase,
 * during the static leaf it is always a requirement.
 */
export function nowDoing(progress: RunProgress | null | undefined): string | null {
  if (!progress) return null;
  const phase = progress.phases[progress.phases.length - 1];
  const req = progress.recent[0];
  const phaseAt = Date.parse(phase?.at ?? '');
  const reqAt = Date.parse(req?.at ?? '');

  const newestIsPhase =
    phase && (!req || !Number.isFinite(reqAt) || (Number.isFinite(phaseAt) && phaseAt >= reqAt));

  if (newestIsPhase && phase) {
    return `${phase.phase} ${PHASE_LABEL[phase.phase] ?? ''}`.trim() + ` — ${phase.result}`;
  }
  if (req) return `${req.id} — ${req.verdict}`;
  return null;
}

/** The last run, in one clause. `blocked` and `busy` are not failures and must not read as one. */
export function describeLast(last: LastRun): string {
  const o = last.outcome;
  if (o.kind === 'verdict') return `last run: ${o.verdict} · risk ${o.risk}`;
  if (o.kind === 'agent_busy') return 'last run: the agent was busy — nothing was charged';
  if (o.kind === 'blocked') return `last run: could not start (${o.reason.replace(/_/g, ' ')})`;
  return `last run: failed (${o.reason})`;
}

/**
 * The browser tab's title while an audit runs.
 *
 * This is the indicator for the case the whole feature exists for: you asked for a review
 * and went to do something else. A background tab shows no strip, no page and no badge — it
 * shows exactly this string.
 */
export function documentTitle(
  live: RunLive | null | undefined,
  progress: RunProgress | null | undefined,
  now = Date.now(),
): string {
  if (!live) return 'Touchstone';
  const done = progressLabel(progress);
  const parts = [live.subject, done, mmss(elapsedSeconds(live.started_at, now))].filter(Boolean);
  return `◴ ${parts.join(' · ')} — Touchstone`;
}
