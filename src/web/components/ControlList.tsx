/**
 * The settings of this instance, rendered from whatever `GET /controls` returned.
 *
 * It knows nothing about any particular one: the label, the unit, the range and the sentence
 * explaining what changing it does all arrive on the row, because `domain/controls.ts` is the
 * only place that is allowed to know. Adding a control server-side puts it on this page with
 * no edit here, which is the same bargain the chat's catalogue makes with `CHAT_TOOLS`.
 *
 * Two things it insists on. A number is committed on **Save** rather than on every keystroke —
 * typing `14` over `7` passes through `1`, and a control that applied it would restart the
 * timer at a cadence nobody asked for. And a row whose value differs from `config.yaml` says
 * so and offers the way back, because the alternative is an instance quietly running on
 * something the file does not mention.
 */
import { useEffect, useState } from 'react';

import type { ControlRow } from '@shared/controls';

export interface ControlListProps {
  rows: ControlRow[];
  /** Resolves when the write has been applied; the caller re-renders from the response. */
  onSet: (key: string, value: number | boolean) => Promise<void>;
  onReset: (key: string) => Promise<void>;
  /** Set while any write is in flight, so two cannot race. */
  busy: boolean;
}

export default function ControlList({ rows, onSet, onReset, busy }: ControlListProps) {
  const groups: { name: string; rows: ControlRow[] }[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.name === row.group) last.rows.push(row);
    else groups.push({ name: row.group, rows: [row] });
  }

  return (
    <div className="ctl-groups">
      {groups.map((group) => (
        <div className="ctl-group" key={group.name}>
          <div className="ctl-group-name">{group.name}</div>
          {group.rows.map((row) => (
            <Row key={row.key} row={row} onSet={onSet} onReset={onReset} busy={busy} />
          ))}
        </div>
      ))}
    </div>
  );
}

function Row({ row, onSet, onReset, busy }: { row: ControlRow } & Omit<ControlListProps, 'rows'>) {
  const [draft, setDraft] = useState(String(row.value));
  const [error, setError] = useState<string | null>(null);

  // Follow the server when it answers, so a failed write does not leave the box showing a
  // value the instance is not running on.
  useEffect(() => {
    setDraft(String(row.value));
  }, [row.value]);

  const dirty = row.kind === 'number' && draft.trim() !== String(row.value);

  const run = async (fn: () => Promise<void>) => {
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="ctl-row" data-source={row.source}>
      <div className="ctl-main">
        <div className="ctl-label">
          {row.label}
          <code className="ctl-key">{row.key}</code>
        </div>
        <div className="ctl-desc">{row.description}</div>
        {row.source === 'override' ? (
          <div className="ctl-note">
            Changed here. <code>config.yaml</code> says{' '}
            <code>{row.kind === 'boolean' ? String(row.default) : row.default}</code>.{' '}
            <button
              type="button"
              className="ctl-undo"
              disabled={busy || !row.settable}
              onClick={() => void run(() => onReset(row.key))}
            >
              use that instead
            </button>
          </div>
        ) : null}
        {!row.settable ? (
          <div className="ctl-note">
            Not settable here — the part of the app that owns it is not running in this build.
          </div>
        ) : null}
        {error ? <div className="ctl-error">{error}</div> : null}
      </div>

      <div className="ctl-set">
        {row.kind === 'boolean' ? (
          <button
            type="button"
            className={`btn ctl-toggle ${row.value ? 'ctl-toggle--on' : ''}`}
            disabled={busy || !row.settable}
            onClick={() => void run(() => onSet(row.key, !row.value))}
          >
            {row.value ? 'On' : 'Off'}
          </button>
        ) : (
          <>
            <input
              className="control ctl-input"
              type="number"
              inputMode="numeric"
              value={draft}
              {...(row.min === undefined ? {} : { min: row.min })}
              {...(row.max === undefined ? {} : { max: row.max })}
              disabled={busy || !row.settable}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && dirty) void run(() => onSet(row.key, Number(draft)));
                if (e.key === 'Escape') setDraft(String(row.value));
              }}
              aria-label={row.label}
            />
            {row.unit ? <span className="ctl-unit">{row.unit}</span> : null}
            <button
              type="button"
              className="btn btn--sm"
              disabled={busy || !dirty || !row.settable}
              onClick={() => void run(() => onSet(row.key, Number(draft)))}
            >
              Save
            </button>
          </>
        )}
      </div>
    </div>
  );
}
