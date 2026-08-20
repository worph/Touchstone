/**
 * Automation — the loop that audits every app in turn, and the two questions you have about
 * it: is it on, and what is it going to do next.
 *
 * The loop is not new here. `scheduler/` has driven it since P3; what this page adds is a
 * switch that does not require editing `config.yaml` and a restart, and a view of the queue
 * the pick comes out of. Three blocks, in the order the questions arrive: the switch and why
 * it is or is not currently doing anything, the cadence it runs at, and the queue.
 *
 * It degrades like Activity does — every block falls back to a sentence rather than an
 * error, because a page about whether the machine is running must render when it is not.
 */
import { subjectName } from '@shared/subject';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { QueueRow, QueueState, ScheduleResponse } from '@shared/schedule';
import { ErrorState, Loading, Notice } from '../components/Ui';
import { getSchedule, setArmed, tickNow } from '../data/client';
import { since, stamp, until } from '../lib/format';

const REFRESH_MS = 15_000;

/**
 * Why a row is where it is, in words. The state word is never carried by colour alone — the
 * same rule the bench and port rows follow.
 */
const STATE_LABEL: Record<QueueState, string> = {
  running: 'being audited now',
  retry: 'retrying after an error',
  never: 'never audited',
  due: 'due',
  fresh: 'recently audited',
  parked: 'parked',
};

export default function Automation() {
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  /** Set while a button is in flight, so the switch cannot be pressed twice. */
  const [busy, setBusy] = useState<'arm' | 'tick' | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await getSchedule());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  /** Both buttons answer with the full state, so neither optimistically guesses at it. */
  const act = useCallback(async (which: 'arm' | 'tick', run: () => Promise<ScheduleResponse>) => {
    setBusy(which);
    try {
      setData(await run());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setBusy(null);
    }
  }, []);

  if (!data && error) return <ErrorState error={error} what="automated mode" />;
  if (!data) return <Loading what="automated mode" />;

  const armed = data.armed === true;
  const wired = data.armed !== null;
  const runnerOff = data.runner_enabled === false;
  const running = data.queue.find((r) => r.state === 'running');
  const backlog = data.queue.filter((r) => r.position !== undefined);
  const next = backlog.find((r) => r.state !== 'running');

  return (
    <div className="page page--wide">
      {error ? (
        <Notice tone="error" title="This page is not refreshing">
          {error.message} Whatever the loop was doing, it is still doing — this is the view,
          not the driver.
        </Notice>
      ) : null}

      {!wired ? (
        <Notice tone="warn" title="No scheduler is wired up">
          This build has no driver, so there is nothing to start. Audits can still be run by
          hand from an app’s own page.
        </Notice>
      ) : null}

      {/* ── the switch ───────────────────────────────────────────────────── */}
      <section className="act-section">
        <h2 className="act-h">Automated mode</h2>

        <div className="auto-switch" data-armed={armed ? 'yes' : 'no'}>
          <div className="auto-switch-state">
            <span className="auto-dot" aria-hidden="true" />
            <div>
              <div className="auto-state-word">{armed ? 'Running' : 'Stopped'}</div>
              <div className="auto-state-sub">
                {armed
                  ? `Auditing every app in turn, one at a time, waiting ${data.constants.cooldown_min} minutes between them.`
                  : 'Nothing is dispatched automatically. Audits still run when you start one by hand.'}
              </div>
            </div>
          </div>
          <button
            type="button"
            className={`btn auto-btn ${armed ? 'auto-btn--stop' : 'auto-btn--start'}`}
            disabled={!wired || busy !== null}
            onClick={() => void act('arm', () => setArmed(!armed))}
          >
            {busy === 'arm' ? 'working…' : armed ? 'Stop' : 'Start'}
          </button>
        </div>

        {/* Stopping is only "claim nothing further" — say so before it is pressed, not
            after, because the alternative reading is that Stop kills the audit in flight. */}
        {armed && running ? (
          <div className="backlog-note">
            <span aria-hidden="true">◴</span>
            <span>
              {running.subject} is being audited now. Stopping lets it finish and record —
              nothing new starts after it.
            </span>
          </div>
        ) : null}

        {runnerOff ? (
          <Notice tone="warn" title="The runner is switched off">
            The scheduler will pick an app and then be told the runner is disabled, so no
            audit happens. Set <code>runner.enabled: true</code> in <code>config.yaml</code>{' '}
            and restart. It is a separate switch on purpose: it also gates hand-run audits.
          </Notice>
        ) : null}

        {data.armed_source === 'override' ? (
          <div className="auto-foot">
            Set from this page. <code>config.yaml</code> says{' '}
            <code>armed: {String(data.armed_default)}</code>, which is what a fresh install
            would boot into; deleting <code>state/schedule.json</code> returns to it.
          </div>
        ) : null}
      </section>

      {/* ── what it last decided, and when it decides again ───────────────── */}
      <section className="act-section">
        <h2 className="act-h">
          Last decision
          <button
            type="button"
            className="btn btn--sm act-h-action"
            disabled={!wired || busy !== null}
            onClick={() => void act('tick', () => tickNow())}
          >
            {busy === 'tick' ? 'deciding…' : 'decide now'}
          </button>
        </h2>

        {data.last_tick ? (
          <div className="auto-tick">
            <div className="auto-tick-state">{data.last_tick.state}</div>
            <div className="auto-tick-when">
              {stamp(data.last_tick.at)} · {since(data.last_tick.at)}
              {data.next_tick_at ? <> · next check {until(data.next_tick_at)}</> : null}
            </div>
          </div>
        ) : (
          <div className="act-quiet">
            The scheduler has not decided anything yet. It decides on boot and every{' '}
            {data.constants.tick_min} minutes after that.
          </div>
        )}

        <div className="auto-facts">
          <Fact label="Backlog" value={`${backlog.length} of ${data.queue.length}`} />
          <Fact
            label="Next up"
            value={next ? next.subject : running ? 'after the current one' : 'nothing due'}
          />
          <Fact
            label="Cooldown"
            value={
              data.cooldown_left_min > 0
                ? `${data.cooldown_left_min}m left of ${data.constants.cooldown_min}m`
                : `clear (${data.constants.cooldown_min}m between audits)`
            }
          />
          <Fact label="Checks every" value={`${data.constants.tick_min}m`} />
          <Fact label="Re-audits after" value={`${data.constants.fresh_days}d`} />
          <Fact label="Gives up after" value={`${data.constants.max_tries} failed tries`} />
        </div>

        {/* The freshness rule is the one number that decides whether "continuous" means a
            carousel or a weekly sweep, and it is not obvious from the number alone. */}
        <div className="auto-foot">
          A full pass is {data.queue.length} apps at roughly{' '}
          {Math.round((data.constants.cooldown_min / 60) * 10) / 10}h apart. Apps re-enter the
          backlog {data.constants.fresh_days} days after their last result, so the loop idles
          once everything is fresh — lower <code>scheduler.fresh_days</code> to keep it
          cycling.
        </div>
      </section>

      {/* ── the queue ─────────────────────────────────────────────────────── */}
      <section className="act-section">
        <h2 className="act-h">
          Queue <span className="act-count">{data.queue.length}</span>
        </h2>

        {data.queue.length === 0 ? (
          <div className="act-quiet">
            The registry is empty, so there is nothing to audit.
            {data.registry.live ? null : ' The app list has not been read from GitHub yet.'}
          </div>
        ) : (
          <div className="env">
            {data.queue.map((row) => (
              <QueueLine key={row.subject} row={row} maxTries={data.constants.max_tries} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="auto-fact">
      <div className="auto-fact-label">{label}</div>
      <div className="auto-fact-value">{value}</div>
    </div>
  );
}

/**
 * One row. Eligible subjects carry their position, everyone else carries the reason they do
 * not have one — "why is my app not being tested" is the question this list answers.
 */
function QueueLine({ row, maxTries }: { row: QueueRow; maxTries: number }) {
  return (
    <div className="env-row auto-row" data-state={row.state}>
      <span className="auto-pos" aria-hidden="true">
        {row.position ?? '·'}
      </span>
      <Link className="env-name" to={`/s/${encodeURIComponent(row.subject)}`}>
        {subjectName(row.subject)}
      </Link>
      <span className="env-status">{STATE_LABEL[row.state]}</span>
      <span className="env-note">{note(row, maxTries)}</span>
    </div>
  );
}

function note(row: QueueRow, maxTries: number): string {
  if (row.state === 'running') return `claimed ${since(row.claim_since)}`;
  if (row.state === 'parked')
    return `${row.try_n} of ${maxTries} tries failed · parked ${since(row.parked_at)}`;
  if (row.state === 'never') return 'no result on file';
  const last = row.last_done_at ? `last ${stamp(row.last_done_at)}` : '';
  if (row.state === 'retry') return `try ${row.try_n + 1} of ${maxTries} · ${last}`;
  return last;
}
