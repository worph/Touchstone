/**
 * A reading, drawn — the badge for a table cell and the table for a subject page.
 *
 * Shared by the operator's Overview and the public board on purpose, exactly as `SubjectTable`
 * is: an app author has to be reading *the same numbers the operator reads*, and two
 * components that compose their own cells are two components that eventually disagree.
 *
 * Neither of these knows what is being measured. The badge is a string the executor wrote and
 * the table is whatever columns it asked for.
 */
import type { AssayRecord } from '@shared/types';

import { daysSince, readingColumns, readingRows, type Reading } from '../lib/reading';

/**
 * The cell. `unknown` is drawn as its own state and never as a pale success — the whole point
 * of a currency check is defeated by a green cell that means "we could not look".
 */
export function ReadingBadge({ reading }: { reading: Reading | null }) {
  if (!reading) return <span className="dim">—</span>;
  return (
    <span
      className="reading"
      data-state={reading.state}
      title={reading.blocked ? reading.record.meta.blocked_detail as string | undefined : reading.summary}
    >
      {reading.badge}
    </span>
  );
}

/** How long ago the reading was taken, so a stamped number is read with its own age. */
export function ReadingAge({ record }: { record: AssayRecord }) {
  const days = daysSince(record.meta.finished_at);
  if (days === null) return null;
  return (
    <span className="dim" title={String(record.meta.finished_at)}>
      {days === 0 ? 'read today' : `read ${days}d ago`}
    </span>
  );
}

/**
 * The rows, as the executor asked for them.
 *
 * A `since` column is drawn as an age rather than a date, which is what keeps *"400 days
 * behind"* true between assays: the record stores the absolute moment the app first fell
 * behind, and the arithmetic happens here, on every render. It is the one reason the check
 * does not need a schedule of its own.
 */
export function ReadingTable({ record }: { record: AssayRecord }) {
  const columns = readingColumns(record);
  const rows = readingRows(record);
  if (rows.length === 0) return null;
  return (
    <div className="tbl-wrap">
      <table className="tbl tbl--reading">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={c.align === 'right' ? { textAlign: 'right' } : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} data-state={typeof row.state === 'string' ? row.state : undefined}>
              {columns.map((c) => {
                const value = row[c.key];
                if (c.kind === 'since') {
                  const days = daysSince(value);
                  return (
                    <td key={c.key} className="col-num" title={typeof value === 'string' ? value : undefined}>
                      {days === null ? <span className="dim">—</span> : `${days}d`}
                    </td>
                  );
                }
                return (
                  <td key={c.key} className={c.align === 'right' ? 'col-num' : undefined}>
                    {value === null || value === undefined || value === '' ? (
                      <span className="dim">—</span>
                    ) : (
                      String(value)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The whole panel: what it says, how old it is, and the rows behind it.
 *
 * A blocked reading renders its reason and no table, because there is nothing in it — and
 * saying so is the product, the same way it is for a blocked assay.
 */
export function ReadingPanel({ reading }: { reading: Reading }) {
  const { record } = reading;
  return (
    <section className="panel reading-panel">
      <header className="reading-head">
        <h2 className="section-title">{String(record.meta.standard ?? reading.section)}</h2>
        <ReadingBadge reading={reading} />
        <ReadingAge record={record} />
      </header>
      {reading.blocked ? (
        <p className="reading-summary">
          {String(record.meta.blocked_detail ?? 'The check could not be performed.')} Nothing here
          counts for or against the app.
        </p>
      ) : (
        <>
          {reading.summary ? <p className="reading-summary">{reading.summary}</p> : null}
          <ReadingTable record={record} />
        </>
      )}
    </section>
  );
}
