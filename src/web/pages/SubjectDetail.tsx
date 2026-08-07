/**
 * Subject detail — one app.
 *
 * Findings list and report side by side: the finding is the index, the report
 * is the evidence. Clicking a finding scrolls the report to its section, and if
 * that finding came from the other leg, switches the report pane to that leg
 * first — otherwise the click would silently do nothing for every functional
 * finding while a static report is open.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { AssayRecord, Leg } from '@shared/types';
import { SEVERITY_RANK } from '@shared/types';
import HistoryStrip from '../components/HistoryStrip';
import MarkdownView, { MissingReport } from '../components/MarkdownView';
import StatusCell from '../components/StatusCell';
import { EmptyState, Loading, Notice, SeverityChip } from '../components/Ui';
import { getReport, getSubject } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import { findHeadingFor, flash, scrollPaneTo } from '../lib/anchors';
import { dateOnly, fileLabel, num, plural, since, stamp } from '../lib/format';
import { displayState, findingState } from '../lib/status';
import type { SubjectFinding } from '../types';

const STATUS_ORDER: Record<string, number> = {
  fail: 0, unverified: 1, advisory: 2, pass: 3, 'n-a': 4,
};

export default function SubjectDetail() {
  const { name = '' } = useParams();
  const { data, error, loading } = useAsync(() => getSubject(name), [name]);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const [pendingScroll, setPendingScroll] = useState<SubjectFinding | null>(null);
  const [noAnchor, setNoAnchor] = useState<string | null>(null);

  const paneRef = useRef<HTMLDivElement>(null);

  // reset the pane when navigating between subjects
  useEffect(() => {
    setSelectedFile(null);
    setActiveFinding(null);
    setPendingScroll(null);
    setNoAnchor(null);
  }, [name]);

  const subject = data?.subject;
  const history = useMemo(() => data?.history ?? [], [data]);

  const byLeg = useMemo(() => {
    const m: Record<Leg, AssayRecord[]> = { static: [], functional: [] };
    for (const r of history) m[r.meta.leg]?.push(r);
    return m;
  }, [history]);

  /** Default to the latest static report — the leg that most often has a body. */
  const defaultFile = subject?.static?.file ?? subject?.functional?.file ?? history[0]?.file ?? null;
  const currentFile = selectedFile ?? defaultFile;
  const currentRec = useMemo(
    () => history.find((r) => r.file === currentFile) ?? null,
    [history, currentFile],
  );

  const report = useAsync(
    () => (currentFile ? getReport(name, currentFile) : Promise.resolve(null)),
    [name, currentFile],
  );

  const findings: SubjectFinding[] = useMemo(() => {
    if (!subject) return [];
    const out: SubjectFinding[] = [];
    for (const rec of [subject.static, subject.functional]) {
      if (!rec) continue;
      rec.meta.findings.forEach((f, i) => {
        out.push({ ...f, leg: rec.meta.leg, key: `${rec.meta.leg}:${i}:${f.rule}:${f.title ?? ''}` });
      });
    }
    return out.sort(
      (a, b) =>
        (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        a.rule.localeCompare(b.rule),
    );
  }, [subject]);

  const onFindingClick = useCallback(
    (f: SubjectFinding) => {
      setActiveFinding(f.key);
      setNoAnchor(null);
      setView('rendered');
      // a functional finding lives in the functional report; switch panes first
      const target = f.leg === 'static' ? subject?.static?.file : subject?.functional?.file;
      if (target && target !== currentFile) {
        setSelectedFile(target);
        setPendingScroll(f);
      } else {
        setPendingScroll(f);
      }
    },
    [subject, currentFile],
  );

  // Runs once the report for the right leg is in the DOM.
  useEffect(() => {
    if (!pendingScroll || report.loading || !report.data) return;
    const pane = paneRef.current;
    if (!pane) return;
    const id = window.requestAnimationFrame(() => {
      const match = findHeadingFor(pane, pendingScroll);
      if (match) {
        scrollPaneTo(pane, match.el);
        flash(match.el);
        setNoAnchor(null);
      } else {
        setNoAnchor(pendingScroll.title ?? pendingScroll.rule);
      }
      setPendingScroll(null);
    });
    return () => window.cancelAnimationFrame(id);
  }, [pendingScroll, report.loading, report.data]);

  if (loading) return <div className="page"><Loading what={name} /></div>;
  if (error || !subject) {
    return (
      <div className="page">
        <Notice tone="error" title={`Could not load ${name}`}>
          {error?.message ?? 'The subject is not in the index.'}{' '}
          <Link to="/">Back to the overview</Link>.
        </Notice>
      </div>
    );
  }

  const refs = subject.static?.meta ?? subject.functional?.meta;
  const never = !subject.static && !subject.functional;

  return (
    <div className="page page--wide">
      <div className="panel">
        <div className="subject-head">
          <div className="subject-head-top">
            <h1 className="subject-title">
              <Link to="/" className="back-link" aria-label="Back to overview">‹</Link>
              {subject.name}
            </h1>
            <div style={{ flex: 1 }} />
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>
                {never ? '—' : num(subject.risk)}
              </div>
              <div className="section-title">risk</div>
            </div>
            <button
              className="btn"
              type="button"
              disabled
              title="Re-assay is designed in UX.md §2.2 but deliberately out of MVP-0 — this build is read-only."
            >
              re-assay ▾
            </button>
          </div>

          {refs ? (
            <div className="subject-refs">
              <div className="ref-line">{refs.subject_ref ?? '—'}</div>
              <div className="ref-line">
                {(refs.images ?? []).map((im) => (
                  <span className="tag" key={im}>{im}</span>
                ))}
                {refs.commit ? <span className="tag">commit {refs.commit}</span> : null}
                <span className="tag">
                  {refs.standard} v{refs.standard_version}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="legs">
          <LegCard leg="static" rec={subject.static} />
          <LegCard leg="functional" rec={subject.functional} />
        </div>

        <div className="history-block">
          <span className="section-title">history</span>
          <HistoryStrip
            leg="static"
            records={byLeg.static}
            selected={currentFile}
            onSelect={(r) => { setSelectedFile(r.file); setActiveFinding(null); }}
          />
          {byLeg.functional.length > 0 ? (
            <HistoryStrip
              leg="functional"
              records={byLeg.functional}
              selected={currentFile}
              onSelect={(r) => { setSelectedFile(r.file); setActiveFinding(null); }}
            />
          ) : null}
        </div>
      </div>

      {never ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <EmptyState
            glyph="⬜"
            title="No assay has ever run for this subject"
            sub="It is in the registry and nothing more. There is no verdict to disagree with, and no report to read."
            action={
              <button className="btn" type="button" disabled title="Re-assay lands in MVP-1">
                Run first assay
              </button>
            }
          />
        </div>
      ) : (
        <div className="split">
          <section className="panel pane">
            <div className="pane-head">
              <span className="section-title">findings ({findings.length})</span>
              <span className="spacer" style={{ flex: 1 }} />
            </div>
            <div className="pane-body">
              {findings.length === 0 ? (
                <EmptyState
                  glyph="·"
                  title="No findings recorded"
                  sub="The assay ran but the report carried no per-rule rows."
                />
              ) : (
                findings.map((f) => (
                  <FindingRow
                    key={f.key}
                    f={f}
                    active={activeFinding === f.key}
                    onClick={() => onFindingClick(f)}
                  />
                ))
              )}
            </div>
            <div className="legend">
              <StatusCell
                state={{ kind: 'unverified', severity: 'critical', label: 'unverified — suspected Critical, pending a bench', mark: '?' }}
                showNote={false}
              />
            </div>
          </section>

          <section className="panel pane">
            <div className="pane-head">
              <span className="section-title">report</span>
              {currentRec ? (
                <span className="dim" style={{ fontSize: 11.5 }}>
                  {currentRec.meta.leg} · {stamp(currentRec.meta.started_at)}
                </span>
              ) : null}
              <span style={{ flex: 1 }} />

              {noAnchor ? (
                <span className="dim" style={{ fontSize: 11.5 }} title={`No heading in this report matches "${noAnchor}".`}>
                  no section for that finding
                </span>
              ) : null}

              <div className="seg">
                <button type="button" aria-pressed={view === 'rendered'} onClick={() => setView('rendered')}>
                  rendered
                </button>
                <button type="button" aria-pressed={view === 'raw'} onClick={() => setView('raw')}>
                  raw
                </button>
              </div>

              <button
                className="btn"
                type="button"
                disabled={!report.data?.raw}
                onClick={() => report.data && download(currentFile ?? 'report.md', report.data.raw)}
              >
                download
              </button>

              {history.length > 1 ? (
                <select
                  className="control"
                  value={currentFile ?? ''}
                  aria-label="Report version"
                  onChange={(e) => { setSelectedFile(e.target.value); setActiveFinding(null); }}
                >
                  {history.map((r, i) => (
                    <option key={r.file} value={r.file}>
                      {fileLabel(r.file)}
                      {i === 0 ? ' (latest)' : ''}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>

            {report.loading ? (
              <div className="pane-body"><Loading what="report" /></div>
            ) : report.error ? (
              <div className="pane-body">
                <MissingReport path={currentRec?.path ?? `${name}/${currentFile ?? '?'}`} />
              </div>
            ) : (
              <MarkdownView
                html={report.data?.html}
                raw={report.data?.raw}
                view={view}
                bodyRef={paneRef}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function LegCard({ leg, rec }: { leg: Leg; rec: AssayRecord | null }) {
  const s = displayState(rec);
  return (
    <div className="leg-card">
      <span className="leg-name">{leg}</span>
      <StatusCell record={rec} size="lg" />
      {rec ? (
        <div className="leg-meta">
          <span>
            {rec.meta.standard} v{rec.meta.standard_version}
          </span>
          <span>
            {s.kind === 'blocked' ? 'since' : 'ran'} {dateOnly(rec.meta.started_at)} ·{' '}
            {since(rec.meta.started_at)}
          </span>
          {rec.meta.status === 'blocked' ? <span>no try consumed</span> : null}
          {rec.meta.status === 'done' && rec.meta.risk_score > 0 ? (
            <span>{plural(rec.meta.findings.filter((f) => f.status === 'fail').length, 'failing finding')}</span>
          ) : null}
        </div>
      ) : (
        <div className="leg-meta">
          <span>this leg has never been assayed</span>
        </div>
      )}
    </div>
  );
}

function FindingRow({
  f, active, onClick,
}: {
  f: SubjectFinding;
  active: boolean;
  onClick: () => void;
}) {
  const s = findingState(f);
  return (
    <>
      <button
        type="button"
        className="finding-row"
        data-status={f.status}
        aria-current={active}
        onClick={onClick}
        title={`${f.leg} · ${s.label}${f.note ? ` — ${f.note}` : ''}`}
      >
        <span className="finding-rule">{f.rule}</span>
        <span className="finding-title">{f.title ?? '(untitled)'}</span>
        <SeverityChip severity={f.severity} status={f.status} />
      </button>
      {active && f.note ? <div className="finding-note">{f.note}</div> : null}
    </>
  );
}

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
