import { subjectName } from '@shared/subject';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import type { EventRecord } from '@shared/activity';
import { stamp } from '../lib/format';

const GLYPH: Record<EventRecord['level'], string> = {
  debug: '·',
  info: '·',
  warn: '⚠',
  error: '⛔',
};

/**
 * One line of the log.
 *
 * The two rules from UX.md §2.3 are enforced here rather than trusted: the message is
 * printed as it arrives and nothing is appended to it, and `detail` is available only
 * behind the disclosure and only on `warn` and `error`. An info row has no ▸ because an
 * info row has nothing a human needs to read past the sentence.
 */
export default function EventRow({ event }: { event: EventRecord }) {
  const [open, setOpen] = useState(false);
  const expandable = (event.level === 'warn' || event.level === 'error') && !!event.detail;

  return (
    <div className="log-row" data-level={event.level}>
      <time className="log-time" dateTime={event.at} title={stamp(event.at)}>
        {event.at.slice(11, 16)}
      </time>
      <span className="log-glyph" aria-hidden="true">
        {GLYPH[event.level]}
      </span>
      <span className="log-message">
        {event.subject ? (
          <Link className="log-subject" to={`/s/${encodeURIComponent(event.subject)}`}>
            {subjectName(event.subject)}
            {event.section ? ` ${event.section}` : ''}
          </Link>
        ) : null}
        {event.message}
      </span>
      <span className="log-code" title={`${event.category} · ${event.code}`}>
        {event.category}
      </span>
      {expandable ? (
        <button
          type="button"
          className="log-toggle"
          aria-expanded={open}
          aria-label={open ? 'Hide detail' : 'Show detail'}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? '▾' : '▸'}
        </button>
      ) : (
        <span className="log-toggle" />
      )}
      {open && event.detail ? (
        <pre className="log-detail">{JSON.stringify(event.detail, null, 2)}</pre>
      ) : null}
    </div>
  );
}
