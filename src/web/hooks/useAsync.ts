import { useEffect, useState } from 'react';
import { getMode, isModeSettled, subscribeMode } from '../data/client';
import type { DataMode } from '../types';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
}

/**
 * Minimal fetch-on-mount. No cache and no revalidation — MVP-0 is 69 rows and
 * a read-only page, and a cache here would only be something to get wrong.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, error: null, loading: true });

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error: unknown) =>
        live &&
        setState({
          data: null,
          error: error instanceof Error ? error : new Error(String(error)),
          loading: false,
        }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}

/** Which source is answering, for the badge in the top bar. */
export function useDataMode(): { mode: DataMode; settled: boolean } {
  const [v, setV] = useState(() => ({ mode: getMode(), settled: isModeSettled() }));
  useEffect(() => subscribeMode((mode, settled) => setV({ mode, settled })), []);
  return v;
}
