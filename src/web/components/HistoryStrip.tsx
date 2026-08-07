/**
 * HistoryStrip — one glyph per assay, oldest → newest, with a regression marker.
 *
 * This is the thing the roll-up page cannot have: "has anything got worse" is
 * answerable at a glance, and that is the whole reason assays are append-only.
 *
 * One strip per leg, not one strip per subject. A regression is defined against
 * the *hallmark*, which is per `(subject, leg)`, so interleaving the legs would
 * manufacture regressions that never happened — a static Critical following a
 * functional pass is not a regression, it is two different questions.
 *
 * `blocked` and `running` assays are drawn but never counted as regressions:
 * an assay that observed nothing cannot be evidence that anything got worse.
 */
import type { AssayRecord } from '@shared/types';
import { SEVERITY_RANK } from '@shared/types';
import { dateOnly } from '../lib/format';
import { displayState, SEVERITY_LABEL } from '../lib/status';

interface Props {
  /** Assays for one leg, any order. Sorted oldest → newest internally. */
  records: AssayRecord[];
  leg: string;
  /** `file` of the assay currently shown in the report pane. */
  selected?: string | null;
  onSelect?: (rec: AssayRecord) => void;
  /** Cap the run so a long-lived subject does not wrap into a wall. */
  max?: number;
}

interface Cell {
  rec: AssayRecord;
  regressed: boolean;
}

export function buildCells(records: AssayRecord[]): Cell[] {
  const ordered = [...records].sort((a, b) =>
    a.meta.started_at.localeCompare(b.meta.started_at),
  );
  let prev: AssayRecord | null = null;
  return ordered.map((rec) => {
    let regressed = false;
    if (rec.meta.status === 'done') {
      if (prev) {
        const gotWorse = SEVERITY_RANK[rec.meta.top_severity] > SEVERITY_RANK[prev.meta.top_severity];
        const lostCompliance =
          prev.meta.verdict === 'compliant' && rec.meta.verdict === 'non-compliant';
        regressed = gotWorse || lostCompliance;
      }
      prev = rec;
    }
    return { rec, regressed };
  });
}

export default function HistoryStrip({ records, leg, selected, onSelect, max = 24 }: Props) {
  const cells = buildCells(records);
  if (cells.length === 0) {
    return (
      <div className="hstrip">
        <span className="hstrip-leg">{leg}</span>
        <span className="dim" style={{ fontSize: 12 }}>
          no assays recorded
        </span>
      </div>
    );
  }

  const shown = cells.slice(-max);
  const hidden = cells.length - shown.length;
  const lastRegression = [...cells].reverse().find((c) => c.regressed);
  const first = shown[0]!.rec;
  const last = shown[shown.length - 1]!.rec;

  return (
    <div className="hstrip">
      <span className="hstrip-leg">{leg}</span>

      <span className="hstrip-run" role="list" aria-label={`${leg} assay history, oldest first`}>
        {hidden > 0 ? (
          <span className="dim" style={{ fontSize: 11, marginRight: 4 }} title={`${hidden} older assays not shown`}>
            +{hidden}
          </span>
        ) : null}
        {shown.map((c) => {
          const s = displayState(c.rec);
          const label =
            `${dateOnly(c.rec.meta.started_at)} · ${s.label}` +
            (s.note ? ` · ${s.note}` : '') +
            (c.regressed ? ' · regressed here' : '');
          return (
            <span key={c.rec.file} style={{ display: 'contents' }}>
              {c.regressed ? (
                <span className="hstrip-break" title={`Regressed on ${dateOnly(c.rec.meta.started_at)}`}>
                  <span aria-hidden="true">↯</span>
                  <span className="sr">regression</span>
                </span>
              ) : null}
              <button
                type="button"
                role="listitem"
                className="hstrip-cell"
                data-kind={s.kind}
                data-sev={s.severity}
                aria-current={selected === c.rec.file}
                aria-label={label}
                title={label}
                onClick={() => onSelect?.(c.rec)}
              >
                <span className="hstrip-glyph" />
              </button>
            </span>
          );
        })}
      </span>

      <span className="dim" style={{ fontSize: 11 }}>
        {dateOnly(first.meta.started_at)} → {dateOnly(last.meta.started_at)}
      </span>

      {lastRegression ? (
        <span className="hstrip-note">
          <span aria-hidden="true">⚠</span>
          regressed {dateOnly(lastRegression.rec.meta.started_at)}
          {lastRegression.rec.meta.status === 'done' ? (
            <span className="dim"> · to {SEVERITY_LABEL[lastRegression.rec.meta.top_severity]}</span>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
