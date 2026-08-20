/**
 * One poller for the run in flight, shared by everything that draws it.
 *
 * Four places now say something about a running audit — the strip in the shell, the
 * Overview's running cells, the Activity card and the re-assay button — and four components
 * each holding their own interval would mean four requests every few seconds and four
 * slightly different ideas of what is happening. So the poll lives here, outside React: the
 * first subscriber starts it, the last one stops it, and everyone reads the same object.
 *
 * The cadence follows the state rather than being a compromise between two: four seconds
 * while something runs, twenty when nothing does. An idle app should not talk to its API
 * every four seconds for the sake of a bar it is not drawing.
 *
 * A failed poll **holds the previous value** rather than dropping to null, for the same
 * reason the nav badge does: a UI that goes quiet when the API dies says the opposite of
 * what is true.
 */

import { useEffect, useState } from 'react';

import type { RunStatus } from '@shared/activity';
import { getAssayStatus } from './client';

const LIVE_MS = 4_000;
const IDLE_MS = 20_000;

type Listener = (status: RunStatus | null) => void;

let current: RunStatus | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0) return;
  timer = setTimeout(() => void poll(), current?.running ? LIVE_MS : IDLE_MS);
}

async function poll(): Promise<void> {
  try {
    current = await getAssayStatus();
    for (const listener of listeners) listener(current);
  } catch {
    /* hold the previous value */
  }
  schedule();
}

/**
 * Poll now, without waiting for the next tick.
 *
 * Called after starting a run: the button that dispatched it knows something changed before
 * any interval could find out, and a four-second gap before the strip appears reads as the
 * click not having worked.
 */
export function refreshRunStatus(): Promise<void> {
  return poll();
}

/** The last status seen, for a caller that needs it outside a render. */
export function runStatusSnapshot(): RunStatus | null {
  return current;
}

export function useRunStatus(): RunStatus | null {
  const [status, setStatus] = useState<RunStatus | null>(current);

  useEffect(() => {
    listeners.add(setStatus);
    // First subscriber starts the loop; later ones join the one already running and get the
    // value it last saw immediately, rather than waiting out a fresh request.
    if (listeners.size === 1) void poll();
    else setStatus(current);

    return () => {
      listeners.delete(setStatus);
      if (listeners.size === 0 && timer) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }, []);

  return status;
}
