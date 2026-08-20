/**
 * Activity — the log, the alerts and the environment. The page you open when something has
 * gone wrong, and the reason you never need the n8n executions list again.
 *
 * Four blocks: what is running right now, then the three UX.md §2.3 fixes the order of —
 * what is wrong now, what it is running on, and what happened. The live one comes first
 * because the log cannot answer it: a run writes one row when it starts and the next when it
 * finishes, so for the ten minutes in between the page read as an idle system. It must render with Beacon unreachable and push unconfigured, so
 * every block degrades to a sentence rather than to an error — the one thing this page may
 * never do is fail to tell you why it is failing.
 */
import { subjectName } from '@shared/subject';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AlertsResponse, BenchesResponse, BenchHealth, EventsResponse, PushStatus } from '@shared/activity';
import AlertCard from '../components/AlertCard';
import EventRow from '../components/EventRow';
import RunCard from '../components/RunCard';
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
  'config',
  'system',
];

/** Same rule as the benches: the status word is never carried by colour alone. */
const PORT_LABEL: Record<string, string> = {
  healthy: 'answering',
  unreachable: 'not answering',
  unconfigured: 'not configured',
  unknown: 'not probed yet',
};

/** What the probe found, in words. The status word is never carried by colour alone. */
const BENCH_LABEL: Record<string, string> = {
  healthy: 'ready',
  auth: 'cannot log in',
  unreachable: 'not usable',
  unconfigured: 'not configured',
  unknown: 'not probed yet',
};

/**
 * The runway note. A bench can pass the login probe and still be the wrong one to start a
 * forty-minute assay on, because the daily cleanup is about to wipe it — so the row says how
 * long it has, and says plainly when that is not enough.
 */
function claimNote(bench: BenchHealth): string {
  if (bench.processing === true) return ' · mid-cleanup, not claimable';
  if (bench.remaining_min === undefined) return '';
  if (bench.remaining_min === null) return ' · no countdown from the board';
  const hours = (bench.remaining_min / 60).toFixed(1);
  return bench.remaining_min > 60
    ? ` · ${hours}h of runway`
    : ` · only ${hours}h left, not claimable`;
}

export default function Activity() {
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
  const [benches, setBenches] = useState<BenchesResponse | null>(null);
  const [log, setLog] = useState<EventsResponse | null>(null);
  const [push, setPush] = useState<PushStatus | null>(null);
  /** Why the last attempt to register this device did not work. */
  const [pushError, setPushError] = useState<string | null>(null);
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

      {/* Before the alerts: "what is happening now" is the question this page is opened
          with, and the log between ASSAY_STARTED and ASSAY_COMPLETED cannot answer it. */}
      <RunCard />

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

        {/* The agent and the browser first: without the agent nothing runs at all, and a
            page that reports only the benches was the asymmetry that hid two of the three
            dependencies an audit needs. */}
        {(benches?.ports.length ?? 0) > 0 ? (
          <div className="env" style={{ marginBottom: 10 }}>
            {benches?.ports.map((p) => (
              <div className="env-row" key={p.name} data-status={p.status}>
                <span className="env-name">{p.name}</span>
                <span className="env-status">
                  <span className="env-dot" aria-hidden="true" />
                  {PORT_LABEL[p.status] ?? p.status}
                </span>
                <span className="env-note">
                  {p.status === 'healthy'
                    ? `${p.tools ?? 0} tools · ${p.latency_ms ?? 0}ms`
                    : `last ok ${p.healthy_at ? stamp(p.healthy_at) : 'never'}`}
                </span>
                <span className="env-probe">
                  {p.kind === 'agent' ? 'agent · ' : 'browser · '}
                  {p.url}
                  {p.detail ? ` → ${p.detail}` : ''}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {(benches?.benches.length ?? 0) === 0 ? (
          <div className="act-quiet">
            The demo pool has not been read yet, so the functional queue stays paused. The
            roster comes from <code>bench.pool_url</code> in <code>data/config.yaml</code> —
            instances are wiped daily, so they are discovered rather than listed. An assay run
            against a bench we cannot log into produces a verdict about the bench and
            attributes it to the app.
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
                  {/* Runway, because healthy and claimable are different questions: an
                      instance the daily cleanup wipes mid-run costs a whole assay. */}
                  {claimNote(b)}
                </span>
                <span className="env-probe">
                  {b.detail ? `login flow → ${b.detail}` : 'login flow → ok'}
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
          Push is{' '}
          {push?.configured ? `configured · ${push.devices} device${push.devices === 1 ? '' : 's'}` : 'not configured'}
          {push?.configured && push.public_key ? (
            <>
              {' '}
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void enablePush(push.public_key!, refresh).then(setPushError)}
              >
                notify this device
              </button>
            </>
          ) : null}
          .
          {pushError ? <div className="act-foot-error">{pushError}</div> : null}
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
                  {subjectName(s)}
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
 * Best-effort, but **never silent**. This used to swallow every failure on the grounds that
 * the environment block already says whether a device is registered — which is true and
 * useless: a button that does nothing, twice, teaches the operator that push is broken
 * rather than that their browser refused. The commonest cause is not even an error, it is
 * an insecure context (`http://` on anything but localhost), where `serviceWorker` is simply
 * not defined and nothing throws at all.
 *
 * Returns null on success, or a sentence to put on the page.
 */
async function enablePush(publicKey: string, after: () => Promise<void>): Promise<string | null> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return window.isSecureContext
      ? 'This browser has no push support, so it cannot be notified.'
      : 'Notifications need a secure page — open Touchstone over https, or at localhost.';
  }
  try {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return permission === 'denied'
        ? 'This browser is blocking notifications for Touchstone. Allow them in the site settings and try again.'
        : 'The permission prompt was dismissed, so nothing was registered.';
    }
    const registration = await navigator.serviceWorker.register('/sw.js');
    // `.ready` rather than the registration itself: a worker that is installing has no
    // `pushManager` to subscribe with yet, and the failure reads as a refusal.
    const active = await navigator.serviceWorker.ready.catch(() => registration);
    const sub = await active.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
    await subscribePush(sub.toJSON());
    await after();
    return null;
  } catch (err) {
    return `This device could not be registered: ${err instanceof Error ? err.message : String(err)}`;
  }
}
