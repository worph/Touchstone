/**
 * Reading the run in flight. Pure functions, so the sentences the UI prints are testable
 * without a browser and without a running audit.
 *
 * The distinction this file keeps: **how far along** and **what it is doing** are different
 * questions. `7 of 24` answers the first; `E9 auth gate — pass` answers the second, and only
 * the second tells a slow run from a stuck one.
 */

import { PHASE_LABEL, type LastRun, type RunLive, type RunProgress } from '@shared/activity';
import type { Section } from '@shared/types';

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
 * The run's phase plan as a track, in protocol order, whether or not each step has been
 * reached yet. The empty ones are the point — a track that only shows what happened cannot
 * show what is left.
 *
 * The plan comes from the server, which reads it off the protocol files, so a run whose
 * sections have no phases draws no track: a row of grey pills beside a run that will never
 * fill them would invent a failure.
 */
export function phaseTrack(
  live: RunLive | null | undefined,
  progress: RunProgress | null | undefined,
): PhaseStep[] {
  const plan = progress?.phase_plan ?? [];
  if (plan.length === 0) return [];
  const recorded = new Map((progress?.phases ?? []).map((p) => [p.phase, p]));
  return plan.map((step) => {
    const hit = recorded.get(step.id);
    return {
      id: step.id,
      label: step.label,
      ...(hit ? { result: hit.result, at: hit.at } : {}),
    };
  });
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
