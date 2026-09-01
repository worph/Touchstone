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

import type { ControlsResponse } from '@shared/controls';
import type { QueueRow, QueueState, RequestRow, ScheduleResponse } from '@shared/schedule';
import ControlList from '../components/ControlList';
import AuditControl from '../components/AuditControl';
import { ErrorState, Loading, Notice } from '../components/Ui';
import {
  flagSubject,
  getControls,
  getSchedule,
  resetControl,
  setArmed,
  setControl,
  tickNow,
} from '../data/client';
import { plural, since, stamp, until } from '../lib/format';

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
  const [controls, setControls] = useState<ControlsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  /** Set while a button is in flight, so the switch cannot be pressed twice. */
  const [busy, setBusy] = useState<'arm' | 'tick' | 'control' | null>(null);

  const refresh = useCallback(async () => {
    try {
      setData(await getSchedule());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
    // Its own request and its own failure: the settings are worth showing when the queue
    // cannot be read, and a settings endpoint that is not wired up must not blank the page
    // about whether the loop is running.
    try {
      setControls(await getControls());
    } catch {
      setControls(null);
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

  /**
   * A setting is written, and then the schedule is re-read.
   *
   * Both halves matter: the response carries the new settings, and the queue is derived from
   * them — change the re-audit window and rows move in or out of the backlog immediately, so
   * a page that only updated the number would be showing a backlog computed against the old
   * one until the next poll.
   */
  const writeControl = useCallback(
    async (run: () => Promise<ControlsResponse>) => {
      setBusy('control');
      try {
        setControls(await run());
        setData(await getSchedule());
        setError(null);
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  /**
   * Repaint from the schedule a flag write returned.
   *
   * The response is the whole schedule, so the row moves into or out of the backlog and every
   * position below it renumbers in the same paint. Nothing is guessed at optimistically:
   * whether a flag actually produces a queue position depends on rules this page does not hold
   * a copy of — and since a flag now releases a park, a parked row can become position 1.
   *
   * The request itself lives in `FlagControl`, shared with the Store table and the subject
   * page. This is only what to do with the answer.
   */
  const flag = useCallback((schedule: ScheduleResponse) => {
    setData(schedule);
    setError(null);
  }, []);

  if (!data && error) return <ErrorState error={error} what="automated mode" />;
  if (!data) return <Loading what="automated mode" />;

  const armed = data.armed === true;
  const wired = data.armed !== null;
  const runnerOff = data.runner_enabled === false;
  const running = data.queue.find((r) => r.state === 'running');
  const backlog = data.queue.filter((r) => r.position !== undefined);
  const next = backlog.find((r) => r.state !== 'running');
  const requested = data.requests;
  /**
   * The head of the request queue, when there is one and nothing is moving.
   *
   * Read off the last decision rather than recomputed here: `waiting_on` is set by the same
   * function that made the pick, so the page cannot disagree with the loop about which item
   * is being held up or why.
   */
  const waitingOn = data.last_tick?.decision.waiting_on ?? null;

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
                  ? `Working through the backlog, one app at a time, waiting ${data.constants.cooldown_min} minutes between them.`
                  : requested.length > 0
                    ? `The backlog is not being worked. ${plural(requested.length, 'requested audit')} will still run — this switch stops the loop helping itself, not audits somebody asked for.`
                    : 'The backlog is not being worked. Audits you ask for still run.'}
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
            audit happens. Turn it on under Settings below — it is a separate switch on
            purpose, because it also gates audits you start by hand.
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
            value={
              next ? subjectName(next.subject) : running ? 'after the current one' : 'nothing due'
            }
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

      {/* ── what it has been told ─────────────────────────────────────────── */}
      {/*
        The numbers the block above reports as facts, made editable. They sit between the
        decision and the queue because that is the order the questions arrive in: what did it
        decide, what is it deciding by, and what does that make the queue.

        `scheduler.armed` is deliberately not in this list even though it is a control like
        the others — it is the switch at the top of the page, and a second copy of it here
        would be two places to press with one of them further from the sentence explaining
        what stopping does.
      */}
      <section className="act-section">
        <h2 className="act-h">Settings</h2>

        {controls ? (
          <>
            <ControlList
              rows={controls.controls.filter((row) => row.key !== 'scheduler.armed')}
              busy={busy !== null}
              onSet={async (key, value) => {
                await writeControl(() => setControl(key, value));
              }}
              onReset={async (key) => {
                await writeControl(() => resetControl(key));
              }}
            />
            <div className="auto-foot">
              These take effect without a restart. <code>config.yaml</code> stays the value a
              fresh install boots into; a change is kept in{' '}
              <code>{controls.file ?? 'state/controls.json'}</code>, and deleting that file
              puts every one of them back.
            </div>
          </>
        ) : (
          <div className="act-quiet">
            Settings are not available from this build, so the numbers above are whatever{' '}
            <code>config.yaml</code> asked for.
          </div>
        )}
      </section>

      {/* ── what somebody asked for ───────────────────────────────────────── */}
      {/* Its own section, above the backlog and not merged into it, because they answer
          different questions. This is work the loop was *told* to do: it drains in the order
          it was asked for, it ignores the cooldown, and it runs whether or not the switch
          above is on. The backlog is the rotation the loop works out for itself, which that
          switch gates. Rendering them as one list is how an operator comes to believe a
          request started something, or that stopping the loop stopped their audit. */}
      <section className="act-section">
        <h2 className="act-h">
          Requested <span className="act-count">{requested.length}</span>
        </h2>

        {requested.length === 0 ? (
          <div className="act-quiet">
            Nothing has been asked for. Press <strong>Audit</strong> on any app to put it here.
          </div>
        ) : (
          <div className="env">
            {requested.map((row) => (
              <RequestLine key={`${row.kind}:${row.id}`} row={row} onChanged={flag} />
            ))}
          </div>
        )}

        {/* The one thing no row can say: why the head is not moving. Without it "waiting" and
            "nothing is happening" render identically, and the operator has no way to tell a
            queue that is working from one that is stuck. */}
        {waitingOn ? (
          <div className="backlog-note">
            <span aria-hidden="true">▨</span>
            <span>
              Nothing is starting — {data.last_tick?.decision.reason ?? 'the loop is waiting'}.
              The queue holds rather than skipping, so {waitingOn} and everything behind it wait
              for this to clear.
            </span>
          </div>
        ) : null}
      </section>

      {/* ── the backlog the loop works out for itself ─────────────────────── */}
      <section className="act-section">
        <h2 className="act-h">
          Backlog <span className="act-count">{data.queue.length}</span>
        </h2>

        {data.queue.length === 0 ? (
          <div className="act-quiet">
            The registry is empty, so there is nothing to audit.
            {data.registry.live ? null : ' The app list has not been read from GitHub yet.'}
          </div>
        ) : (
          <div className="env">
            {data.queue.map((row) => (
              <QueueLine
                key={row.subject}
                row={row}
                maxTries={data.constants.max_tries}
                onFlag={flag}
              />
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
function QueueLine({
  row,
  maxTries,
  onFlag,
}: {
  row: QueueRow;
  maxTries: number;
  onFlag: (schedule: ScheduleResponse) => void;
}) {
  return (
    <div className="env-row auto-row" data-state={row.state} data-flagged={String(Boolean(row.flagged))}>
      <span className="auto-pos" aria-hidden="true">
        {row.position ?? '·'}
      </span>
      <Link className="env-name" to={`/s/${encodeURIComponent(row.subject)}`}>
        {subjectName(row.subject)}
      </Link>
      <span className="env-status">{STATE_LABEL[row.state]}</span>
      <span className="env-note">{note(row, maxTries)}</span>
      <FlagCell row={row} onChanged={onFlag} />
    </div>
  );
}

/**
 * The flag, on the row it applies to.
 *
 * Only on rows where it would mean something — which since 2026-08-31 includes a **parked**
 * one. It did not: `plan()` skips a parked row before it looks at any eligibility clause, so
 * flagging one changed nothing and the control was hidden rather than lie about it. That left
 * the one row an operator most wants to act on as the one row offering nothing, which is how
 * `yundera~UptimeKuma` sat parked for three days with no control anywhere on the page.
 * `Scheduler.setFlagged` now releases the park, so the button means what it says. A `running`
 * subject is still exempt: it is being looked at right now, and the flag would be spent by the
 * attempt already in flight.
 *
 * `AuditControl` rather than a button of its own — it is the same verb as the Store table's
 * and the subject page's, and five spellings of one action is what this replaced.
 */
function FlagCell({ row, onChanged }: { row: QueueRow; onChanged: (s: ScheduleResponse) => void }) {
  if (row.state === 'running') {
    return <span className="auto-flag" aria-hidden="true" />;
  }
  return (
    <span className="auto-flag">
      <AuditControl
        variant="row"
        subject={row.subject}
        label={subjectName(row.subject)}
        queued={Boolean(row.flagged)}
        onChanged={(next) => next && onChanged(next)}
      />
    </span>
  );
}

/**
 * One thing somebody asked for.
 *
 * Deliberately a different row from `QueueLine`: a request has a place in a line and a kind,
 * and a backlog row has a staleness and a try count. Rendering both through one component
 * meant one of the two sets of columns was always empty and the other always needed a caveat.
 */
function RequestLine({
  row,
  onChanged,
}: {
  row: RequestRow;
  onChanged: (s: ScheduleResponse) => void;
}) {
  return (
    <div className="env-row auto-row" data-state={row.state}>
      <span className="auto-pos num">{row.position}</span>
      <span className="env-name">
        {row.kind === 'trial' ? (
          <Link to={`/trials/${encodeURIComponent(row.id)}`}>{row.label}</Link>
        ) : (
          <Link to={`/s/${encodeURIComponent(row.id)}`}>{row.label}</Link>
        )}
      </span>
      <span className="env-status">
        {row.state === 'running' ? 'being audited now' : row.kind === 'trial' ? 'trial' : 'audit'}
      </span>
      <span className="env-note">asked for {since(row.requested_at)}</span>
      {/* Only an audit can be withdrawn from here. A trial is a whole record with its own
          files — dropping it is a delete, and it lives on the trial's own page where the
          consequence is visible. */}
      <span className="auto-flag">
        {row.kind === 'audit' && row.state !== 'running' ? (
          <WithdrawButton subject={row.id} label={row.label} onChanged={onChanged} />
        ) : null}
      </span>
    </div>
  );
}

/** Take one request back out of the line. The same write the row control makes. */
function WithdrawButton({
  subject,
  label,
  onChanged,
}: {
  subject: string;
  label: string;
  onChanged: (s: ScheduleResponse) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="btn btn--sm"
      type="button"
      disabled={busy}
      title={`Withdraw the audit request for ${label}`}
      aria-label={`Withdraw the audit request for ${label}`}
      onClick={() => {
        setBusy(true);
        void flagSubject(subject, false)
          .then(onChanged)
          .finally(() => setBusy(false));
      }}
    >
      ×
    </button>
  );
}

function note(row: QueueRow, maxTries: number): string {
  if (row.state === 'running') return `claimed ${since(row.claim_since)}`;
  if (row.state === 'parked')
    return `${row.try_n} of ${maxTries} tries failed · parked ${since(row.parked_at)}`;
  if (row.state === 'never') return 'no result on file';
  const last = row.last_done_at ? `last ${stamp(row.last_done_at)}` : '';
  if (row.state === 'retry') return `try ${row.try_n + 1} of ${maxTries} · ${last}`;
  // Otherwise a row audited yesterday reads as `due` with a recent date beside it and no
  // account of itself. This is the whole of the explanation: the calendar did not make it
  // due — an edit to the rubric did, or the app moved, or somebody asked. Three independent
  // reasons, and a row can carry all of them.
  const why = [
    row.standard_moved ? 'standard revised since' : '',
    row.subject_changed ? 'app changed in the store' : '',
    row.flagged ? 'flagged for re-audit' : '',
  ].filter(Boolean);
  if (why.length > 0) return [last, ...why].filter(Boolean).join(' · ');
  return last;
}
