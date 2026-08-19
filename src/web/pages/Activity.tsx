/**
 * Activity — the log, the alerts and the environment. The page you open when something has
 * gone wrong, and the reason you never need the n8n executions list again.
 *
 * Three blocks in the order UX.md §2.3 fixes them: what is wrong now, what it is running
 * on, and what happened. It must render with Beacon unreachable and push unconfigured, so
 * every block degrades to a sentence rather than to an error — the one thing this page may
 * never do is fail to tell you why it is failing.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AlertsResponse, BenchesResponse, EventsResponse, PushStatus } from '@shared/activity';
import AlertCard from '../components/AlertCard';
import EventRow from '../components/EventRow';
import { EmptyState, Loading, Notice } from '../components/Ui';
import {
  getAlerts,
  getBenches,
  getEvents,
  getPushStatus,
  probeBenches,
  subscribePush,
} from '../data/client';
import { markSeen } from '../lib/badge';
import { since, stamp } from '../lib/format';

const REFRESH_MS = 10_000;

const LEVELS = [
  { value: 'all', label: 'all levels' },
  { value: 'info', label: 'info and up' },
  { value: 'warn', label: 'warnings and up' },
  { value: 'error', label: 'errors only' },
];

const CATEGORIES = [
  'all',
  'scheduler',
  'assay',
  'bench',
  'agent',
  'importer',
  'notify',
  'system',
];

/** What the probe found, in words. The status word is never carried by colour alone. */
const BENCH_LABEL: Record<string, string> = {
  healthy: 'ready',
  auth: 'auth failing',
  unreachable: 'not answering',
  unconfigured: 'no credentials',
  unknown: 'not probed yet',
};

export default function Activity() {
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [benches, setBenches] = useState<BenchesResponse | null>(null);
  const [log, setLog] = useState<EventsResponse | null>(null);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [probing, setProbing] = useState(false);

  const [level, setLevel] = useState('all');
  const [category, setCategory] = useState('all');
  const [subject, setSubject] = useState('all');

  const refresh = useCallback(async () => {
    try {
      const [a, b, e, p] = await Promise.all([
        getAlerts(),
        getBenches(),
        getEvents({ level, category, subject, limit: 300 }),
        getPushStatus(),
      ]);
      setAlerts(a);
      setBenches(b);
      setLog(e);
      setPush(p);
      setError(null);
      // Reading the page is what marks the error rows read, so the badge falls to the
      // count of open alerts — which is the half that should not clear by being looked at.
      markSeen(e.last_seq);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, [level, category, subject]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const probe = useCallback(async () => {
    setProbing(true);
    try {
      setBenches(await probeBenches());
      setAlerts(await getAlerts());
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setProbing(false);
    }
  }, []);

  const open = alerts?.open ?? [];
  const events = log?.events ?? [];
  const subjects = useMemo(() => log?.subjects ?? [], [log]);

  // The first load is the only one that shows a spinner: a ten-second refresh that blanks
  // the page every time is a page you cannot read.
  if (!alerts && !error) return <Loading what="activity" />;

  return (
    <div className="page page--wide">
      {error ? (
        <Notice tone="error" title="The activity feed is not updating">
          {error.message} The log itself is a file on disk and is not lost.
        </Notice>
      ) : null}

      <section className="act-section">
        <h2 className="act-h">
          Open alerts <span className="act-count">{open.length}</span>
        </h2>
        {open.length === 0 ? (
          <div className="act-quiet">
            Nothing is currently wrong with the environment.
            {alerts && alerts.resolved.length > 0 ? (
              <> Last resolved {since(alerts.resolved[0]?.resolved_at)}.</>
            ) : null}
          </div>
        ) : (
          <div className="alert-stack">
            {open.map((a) => (
              <AlertCard key={a.key} alert={a} onProbe={a.key.startsWith('bench.') ? probe : undefined} probing={probing} />
            ))}
          </div>
        )}
      </section>

      <section className="act-section">
        <h2 className="act-h">
          Environment
          <button type="button" className="btn btn--sm act-h-action" onClick={probe} disabled={probing}>
            {probing ? 'probing…' : 'probe all'}
          </button>
        </h2>

        {(benches?.benches.length ?? 0) === 0 ? (
          <div className="act-quiet">
            No bench is configured, so the functional queue stays paused. Add one under
            <code> benches:</code> in <code>data/config.yaml</code> — an assay run against a
            bench we cannot log into produces a verdict about the bench and attributes it to
            the app.
          </div>
        ) : (
          <div className="env">
            {benches?.benches.map((b) => (
              <div className="env-row" key={b.name} data-status={b.status}>
                <span className="env-name">{b.name}</span>
                <span className="env-status">
                  <span className="env-dot" aria-hidden="true" />
                  {BENCH_LABEL[b.status] ?? b.status}
                </span>
                <span className="env-note">
                  {b.status === 'healthy'
                    ? `answered in ${b.latency_ms ?? 0}ms`
                    : `last ok ${b.healthy_at ? stamp(b.healthy_at) : 'never'}`}
                </span>
                <span className="env-probe">
                  {b.detail ? `probe POST /api/firstfactor → ${b.detail}` : 'probe POST /api/firstfactor'}
                  {/* The board said Ready for the whole of the 2026-08-05 outage. Showing
                      the disagreement is the point; agreeing silently is the bug. */}
                  {b.board_says !== undefined && b.status !== 'healthy' ? (
                    <span className="env-board">
                      {b.board_says === null
                        ? ' · the board could not be read'
                        : ` · board says ${b.board_says}`}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="act-foot">
          Browsers and the agent are not probed yet — the browser pool lands with functional
          leasing and the agent check with the runner. Push is{' '}
          {push?.configured ? `configured · ${push.devices} device${push.devices === 1 ? '' : 's'}` : 'not configured'}
          {push?.configured && push.public_key ? (
            <>
              {' '}
              <button type="button" className="btn btn--sm" onClick={() => void enablePush(push.public_key!, refresh)}>
                notify this device
              </button>
            </>
          ) : null}
          .
        </div>
      </section>

      <section className="act-section">
        <h2 className="act-h">
          Log
          <span className="act-h-filters">
            <select className="control" name="level" value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Level">
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
            </select>
            <select className="control" name="category" value={category} onChange={(e) => setCategory(e.target.value)} aria-label="Category">
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c === 'all' ? 'all categories' : c}
                </option>
              ))}
            </select>
            <select className="control" name="subject" value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject">
              <option value="all">all subjects</option>
              {subjects.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </span>
        </h2>

        {events.length === 0 ? (
          <EmptyState
            glyph="≡"
            title="Nothing in the log yet"
            sub="Every tick, claim, result, retry, block and probe writes a row here."
          />
        ) : (
          <div className="log">
            {events.map((e) => (
              <EventRow key={e.seq} event={e} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Register this browser for push.
 *
 * Deliberately inline and best-effort: a browser that refuses permission, has no service
 * worker, or is Safari is a browser that reads the log instead. Nothing else on the page
 * depends on it working.
 */
async function enablePush(publicKey: string, after: () => Promise<void>): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;
    const registration = await navigator.serviceWorker.register('/sw.js');
    const sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
    await subscribePush(sub.toJSON());
    await after();
  } catch {
    // Nothing to show: the environment block already says whether a device is registered.
  }
}
