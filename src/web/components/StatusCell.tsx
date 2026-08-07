/**
 * StatusCell — the single most important visual decision in the app.
 *
 * In the real corpus 49 of 69 functional cells are `blocked`. A user must never
 * have to open a report to tell "we checked and it failed" from "we could not
 * check". So the two are separated on three independent channels at once:
 *
 *   FAILED     solid red/orange/yellow block · letter C, M or m · the word
 *   BLOCKED    45° hatch on grey            · no letter        · "blocked", italic
 *   NOT RUN    hollow dotted outline        · no letter        · "not yet run", faint
 *   RUNNING    pulsing outline              · ◴               · "running · 4m"
 *
 * Fill treatment and glyph survive greyscale, deuteranopia and protanopia. The
 * word survives everything. Colour is the fourth channel, never the only one.
 */
import type { AssayRecord } from '@shared/types';
import type { DisplayState } from '../types';
import { displayState } from '../lib/status';

interface Props {
  /** The latest assay for this leg, or null when the leg has never been assayed. */
  record?: AssayRecord | null;
  /** Pre-derived state, for callers that are not rendering an assay (findings). */
  state?: DisplayState;
  size?: 'sm' | 'lg';
  /** Show the secondary note (`bench unavailable`, `risk 232`, `4m`). */
  showNote?: boolean;
}

export default function StatusCell({ record, state, size = 'sm', showNote = true }: Props) {
  const s = state ?? displayState(record);
  return (
    <span
      className={`status${size === 'lg' ? ' status--lg' : ''}`}
      data-kind={s.kind}
      data-sev={s.severity}
      title={s.hint}
    >
      <span className="status-mark" aria-hidden="true">
        {s.mark}
      </span>
      <span className="status-label">{s.label}</span>
      {showNote && s.note ? <span className="status-note">· {s.note}</span> : null}
    </span>
  );
}

/** The legend that teaches the vocabulary once, so no row has to explain itself. */
export function StatusLegend({ kinds }: { kinds?: DisplayState['kind'][] }) {
  const all: DisplayState[] = [
    { kind: 'ok', severity: 'none', label: 'compliant', mark: '✓' },
    { kind: 'fail', severity: 'critical', label: 'failed', mark: 'C' },
    { kind: 'blocked', severity: 'none', label: 'blocked — could not check', mark: '' },
    { kind: 'none', severity: 'none', label: 'not yet run', mark: '' },
    { kind: 'unverified', severity: 'critical', label: 'unverified — suspected', mark: '?' },
    { kind: 'running', severity: 'none', label: 'running', mark: '◴' },
  ];
  const shown = kinds ? all.filter((s) => kinds.includes(s.kind)) : all;
  return (
    <div className="legend">
      {shown.map((s) => (
        <StatusCell key={s.kind} state={s} showNote={false} />
      ))}
    </div>
  );
}
