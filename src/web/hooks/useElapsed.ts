import { useEffect, useState } from 'react';

import { elapsedSeconds } from '../lib/run';

/**
 * Seconds since a start stamp, ticking once a second — and **only** while there is one.
 *
 * A running clock is a re-render a second, so this belongs in leaf components: the strip and
 * the card, never a page or the shell. A shell that re-rendered every second would re-render
 * whatever page it is wrapping along with it, for the sake of two digits.
 */
export function useElapsed(startedAt: string | null | undefined): number {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(startedAt ?? undefined));

  useEffect(() => {
    if (!startedAt) {
      setSeconds(0);
      return;
    }
    setSeconds(elapsedSeconds(startedAt));
    const timer = setInterval(() => setSeconds(elapsedSeconds(startedAt)), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return seconds;
}
