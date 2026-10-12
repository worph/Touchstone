/**
 * Activity — what you are told: the alerts, how this device is notified, and the log. The
 * page you open when something has gone wrong, and the reason you never need the n8n
 * executions list again.
 *
 * Present-tense state — the run in flight, the agent, the browsers, the bench roster — moved
 * to Status on 2026-10-12 (see `pages/Status.tsx` for why). What stayed is the record: an alert
 * is a condition with an opening and a close, a notification is the outlet that carries it, and
 * the log is everything else. It must render with Beacon unreachable and push unconfigured, so
 * every block degrades to a sentence rather than to an error — the one thing this page may
 * never do is fail to tell you why it is failing.
 */
import { subjectName } from '@shared/subject';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import type { AlertKey, AlertsResponse, EventsResponse, PushStatus } from '@shared/activity';
import AlertCard from '../components/AlertCard';
import EventRow from '../components/EventRow';
import { EmptyState, Loading, Notice } from '../components/Ui';
import {
  getAlerts,
  getEvents,
  getPushStatus,
  probeBenches,
  subscribePush,
} from '../data/client';
import { markSeen } from '../lib/badge';
import { since } from '../lib/format';

const REFRESH_MS = 10_000;

/** How many closed alerts to keep on the page. The log has the rest. */
const RESOLVED_SHOWN = 5;

/**
 * The alerts a probe can settle. `probeBenches` re-probes the agent and the browsers as well
 * as the pool, so the button belongs on those cards too; a dead session or a GitHub token is
 * not something a probe can see, and a button that cannot change the card is a lie.
 */
function probeable(key: AlertKey): boolean {
  return key.startsWith('bench.') || key === 'agent.unavailable' || key === 'browser.unavailable';
}

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
  'workshop',
  'importer',
  'notify',
  'config',
  'system',
];

export default function Activity() {
  const [alerts, setAlerts] = useState<AlertsResponse | null>(null);
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
      const [a, e, p] = await Promise.all([
        getAlerts(),
        getEvents({ level, category, subject, limit: 300 }),
        getPushStatus(),
      ]);
      setAlerts(a);
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
      await probeBenches();
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
{' '}
            <Link to="/status">Status</Link> shows what it is running on.
          </div>
        ) : (
          <div className="alert-stack">
            {open.map((a) => (
              <AlertCard key={a.key} alert={a} onProbe={probeable(a.key) ? probe : undefined} probing={probing} />
            ))}
          </div>
        )}
      </section>

      {/* A condition that came and went is still something you were told, and the open stack
          alone cannot say "the agent was gone for five days and is back since this morning". */}
      {(alerts?.resolved.length ?? 0) > 0 ? (
        <section className="act-section">
          <h2 className="act-h">Recently resolved</h2>
          <div className="alert-stack">
            {[...alerts!.resolved]
              .sort((a, b) => (b.resolved_at ?? '').localeCompare(a.resolved_at ?? ''))
              .slice(0, RESOLVED_SHOWN)
              .map((a) => (
              <AlertCard key={`${a.key}@${a.resolved_at ?? ''}`} alert={a} />
            ))}
          </div>
        </section>
      ) : null}

      <section className="act-section">
        <h2 className="act-h">Notifications</h2>
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
