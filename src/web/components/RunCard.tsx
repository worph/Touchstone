/**
 * The audit in flight, in full, for the page you open to ask what is happening.
 *
 * Activity's three blocks answer "what is wrong", "what is it running on" and "what
 * happened" — and until now nothing answered "what is happening *now*". The log could not:
 * a run writes `ASSAY_STARTED`, then settles requirements for six to ten minutes without an
 * event, then writes `ASSAY_COMPLETED`. Read literally, the page said nothing was going on.
 *
 * What it shows beyond the strip in the shell is the part that only matters when something
 * looks wrong: which bench and which browser this run leased, the phase track, and the last
 * few requirements it settled.
 */

import { Link } from 'react-router-dom';

import { useRunStatus } from '../data/runStatus';
import { useElapsed } from '../hooks/useElapsed';
import { describeLast, mmss, phaseTrack, progressLabel, progressRatio } from '../lib/run';
import { since, stamp } from '../lib/format';

export default function RunCard() {
  const status = useRunStatus();
  const live = status?.running ?? null;
  const seconds = useElapsed(live?.started_at);

  // Nothing running: say what the last one did rather than nothing at all. An empty block
  // and a broken block look the same, and this page's job is to be readable when things are
  // broken.
  if (!live) {
    const last = status?.last ?? null;
    return (
      <section className="act-section">
        <h2 className="act-h">Running now</h2>
        <div className="act-quiet">
          No audit is running.
          {status && !status.enabled ? (
            <> The runner is switched off — set <code>runner.enabled</code> in <code>data/config.yaml</code>.</>
          ) : null}
          {last ? (
            <>
              {' '}
              <Link to={`/s/${encodeURIComponent(last.subject)}`}>{last.subject}</Link> finished{' '}
              {since(last.finished_at)} — {describeLast(last).replace(/^last run: /, '')}.
            </>
          ) : null}
        </div>
      </section>
    );
  }

  const progress = status?.progress ?? null;
  const counted = progressLabel(progress);
  const ratio = progressRatio(progress);
  const track = phaseTrack(live, progress);
  const sections = live.sections ?? [];
  const blocked = live.blocked ?? [];

  return (
    <section className="act-section">
      <h2 className="act-h">
        Running now
        <span className="act-count" aria-hidden="true">◴</span>
      </h2>

      <div className="run-card">
        <div className="run-card__head">
          <Link className="run-card__subject" to={`/s/${encodeURIComponent(live.subject)}`}>
            {live.subject}
          </Link>
          <span className="run-card__depth">
            {sections.length > 0 ? sections.join(' + ') : 'choosing sections…'}
          </span>
          <span className="spacer" />
          <span className="run-card__clock num">{mmss(seconds)}</span>
        </div>

        {/* A skipped section is not a failure: the rest of the audit is running, and the
            section that could not be attempted is *recorded* blocked — a statement about the
            environment, not about the app. */}
        {blocked.length > 0 ? (
          <div className="run-card__degraded">
            Not running {blocked.map((b) => b.section).join(', ')} —{' '}
            {blocked[0]!.reason.replace(/_/g, ' ')}. {blocked.length > 1 ? 'Those sections' : 'That section'}{' '}
            will be recorded blocked, and no retry budget is spent on {blocked.length > 1 ? 'them' : 'it'}.
          </div>
        ) : null}

        <div className="run-card__bar">
          {ratio !== null ? (
            <span className="run-bar" aria-hidden="true">
              <span className="run-bar__fill" style={{ inlineSize: `${Math.round(ratio * 100)}%` }} />
            </span>
          ) : null}
          <span className="run-card__counted">
            {counted ? (
              <>
                <span className="num">{counted}</span> requirements settled
                {progress && progress.failed > 0 ? (
                  <> · <span className="run-card__failing">{progress.failed} failing</span></>
                ) : null}
              </>
            ) : (
              'waiting for the agent to report its first requirement…'
            )}
          </span>
        </div>

        {track.length > 0 ? (
          <ol className="phase-track" aria-label="Functional phases">
            {track.map((p) => (
              <li
                key={p.id}
                className="phase"
                data-result={p.result ?? 'pending'}
                title={p.result ? `Phase ${p.id} — ${p.label}: ${p.result}` : `Phase ${p.id} — ${p.label}: not reached yet`}
              >
                <span className="phase__id num">{p.id}</span>
                <span className="phase__label">{p.label}</span>
              </li>
            ))}
          </ol>
        ) : null}

        {/* Where it is running. Only interesting when something looks wrong — and then it is
            the first thing you want, because the bench is the usual suspect. */}
        <dl className="run-card__where">
          <dt>started</dt>
          <dd className="num">{stamp(live.started_at)}</dd>
          {live.bench ? (
            <>
              <dt>bench</dt>
              <dd className="mono">{live.bench}</dd>
            </>
          ) : null}
          {live.browser ? (
            <>
              <dt>browser</dt>
              <dd className="mono">{live.browser}</dd>
            </>
          ) : null}
        </dl>

        {progress && progress.recent.length > 0 ? (
          <ul className="run-card__recent">
            {progress.recent.map((r) => (
              <li key={`${r.id}-${r.at}`} data-verdict={r.verdict}>
                <span className="run-card__req mono">{r.id}</span>
                <span className="run-card__verdict">{r.verdict}</span>
                {r.severity && r.severity !== 'none' ? (
                  <span className="run-card__sev">{r.severity}</span>
                ) : null}
                <span className="run-card__at dim">{since(r.at)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
