import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** Re-run the fetch. Added for the chat, where a turn changes the server's copy. */
  reload: () => Promise<void>;
}

/**
 * Minimal fetch-on-mount. No cache and no revalidation — 69 rows and a read-only
 * page, and a cache here would only be something to get wrong.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<Omit<AsyncState<T>, 'reload'>>({
    data: null,
    error: null,
    loading: true,
  });
  // Held in a ref so `reload` is stable and does not need `fn` in anyone's dependency list.
  const latest = useRef(fn);
  latest.current = fn;

  const run = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await latest.current();
      setState({ data, error: null, loading: false });
    } catch (error) {
      setState({
        data: null,
        error: error instanceof Error ? error : new Error(String(error)),
        loading: false,
      });
    }
  }, []);

  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    latest.current().then(
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

  return { ...state, reload: run };
}
