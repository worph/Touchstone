import type { Alert } from '@shared/activity';
import { duration, since, stamp } from '../lib/format';

/**
 * One environment condition. One card, however long it lasts.
 *
 * The card leads with the sentence and carries three things under it that the n8n
 * executions list never had in one place: what is failing, what that is currently
 * stopping, and when we last checked. The last of those is why the probe button is on the
 * card — "is it still down" is the first question anyone asks of it.
 */
export default function AlertCard({
  alert,
  onProbe,
  probing,
}: {
  alert: Alert;
  onProbe?: () => void;
  probing?: boolean;
}) {
  const resolved = alert.state === 'resolved';
  return (
    <article className="alert" data-state={alert.state}>
      <div className="alert-head">
        <span className="alert-glyph" aria-hidden="true">
          {resolved ? '✅' : '⚠'}
        </span>
        <h3 className="alert-title">{alert.title}</h3>
        <span className="alert-age">
          {resolved ? `resolved ${since(alert.resolved_at)}` : `open · ${duration(alert.opened_at)}`}
        </span>
      </div>

      {alert.detail ? <div className="alert-detail">{alert.detail}</div> : null}
      {!resolved && alert.impact ? <div className="alert-impact">{alert.impact}</div> : null}

      <div className="alert-foot">
        <span title={stamp(alert.last_seen_at)}>
          {resolved ? `open from ${stamp(alert.opened_at)}` : `last seen ${since(alert.last_seen_at)}`}
        </span>
        {onProbe && !resolved ? (
          <button type="button" className="btn btn--sm" onClick={onProbe} disabled={probing}>
            {probing ? 'probing…' : 'probe'}
          </button>
        ) : null}
      </div>
    </article>
  );
}
