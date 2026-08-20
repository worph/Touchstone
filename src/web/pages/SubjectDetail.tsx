/**
 * Subject detail — one app.
 *
 * Two leg cards, then the report. The report is the evidence and it is the whole page
 * below the fold: findings are prose inside it, not rows beside it
 * (ARCHITECTURE.md §1.4 G). The blocked card naming its reason and saying `no try used`
 * is the sentence this page exists to print.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { AssayRecord, Leg } from '@shared/types';
import MarkdownView, { MissingReport } from '../components/MarkdownView';
import StatusCell from '../components/StatusCell';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { getReport, getSubject } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import ReassayButton from '../components/ReassayButton';
import CoverageCell from '../components/CoverageCell';
import RequirementList from '../components/RequirementList';
import { dateOnly, num, since, stamp } from '../lib/format';
import { displayState } from '../lib/status';

export default function SubjectDetail() {
  const { name = '' } = useParams();
  // `nonce` is what a finished audit changes: it re-runs the subject fetch, which pulls in
  // the assay the run just wrote without a page reload.
  const [nonce, setNonce] = useState(0);
  const { data, error, loading } = useAsync(() => getSubject(name), [name, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const [selectedLeg, setSelectedLeg] = useState<Leg | null>(null);
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');

  const paneRef = useRef<HTMLDivElement>(null);

  // reset the pane when navigating between subjects
  useEffect(() => {
    setSelectedLeg(null);
    setView('rendered');
  }, [name]);

  const subject = data?.subject;

  /** Default to the static report — the leg that most often has a body. */
  const legWithReport: Leg | null = subject?.static ? 'static' : subject?.functional ? 'functional' : null;
  const currentLeg = selectedLeg ?? legWithReport;
  const currentRec = currentLeg ? (subject?.[currentLeg] ?? null) : null;
  const currentFile = currentRec?.file ?? null;

  /** Recorded by the agent during the run. Absent on everything imported before the runner. */
  const requirements = currentRec?.meta.requirements ?? [];

  const report = useAsync(
    () => (currentFile ? getReport(name, currentFile) : Promise.resolve(null)),
    [name, currentFile],
  );

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
            <ReassayButton subject={subject.name} onFinished={reload} />
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
      </div>

      {/* What was actually checked. Above the report, because the report is the evidence for
          these and a reader looking for "what failed" should not have to scroll a rubric. */}
      {requirements.length > 0 ? (
        <section className="panel" style={{ marginTop: 14 }}>
          <div className="pane-head">
            <span className="section-title">requirements</span>
            {currentRec?.meta.coverage ? (
              <span className="dim" style={{ fontSize: 11.5 }}>
                <CoverageCell coverage={currentRec.meta.coverage} /> verified
                {currentRec.meta.risk_score_declared !== undefined ? (
                  // The agent's own score and the sum of its items came apart. Both are kept;
                  // saying so is better than picking one and looking certain.
                  <span className="req-mismatch">
                    {' '}· the audit declared risk {currentRec.meta.risk_score_declared}, its items sum to{' '}
                    {currentRec.meta.coverage.risk}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
          <RequirementList items={requirements} />
        </section>
      ) : null}

      {never ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <EmptyState
            glyph="⬜"
            title="No assay has ever run for this subject"
            sub="It is in the registry and nothing more. There is no verdict to disagree with, and no report to read."
            action={<ReassayButton subject={subject.name} onFinished={reload} label="Run first assay" />}
          />
        </div>
      ) : (
        <section className="panel pane" style={{ marginTop: 14 }}>
          <div className="pane-head">
            <span className="section-title">report</span>
            {currentRec ? (
              <span className="dim" style={{ fontSize: 11.5 }}>
                {currentRec.meta.leg} · {stamp(currentRec.meta.started_at)}
              </span>
            ) : null}
            <span style={{ flex: 1 }} />

            {subject.static && subject.functional ? (
              <div className="seg">
                <button
                  type="button"
                  aria-pressed={currentLeg === 'static'}
                  onClick={() => setSelectedLeg('static')}
                >
                  static
                </button>
                <button
                  type="button"
                  aria-pressed={currentLeg === 'functional'}
                  onClick={() => setSelectedLeg('functional')}
                >
                  functional
                </button>
              </div>
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
          {/* The sentence the wiki table could not say. */}
          {rec.meta.status === 'blocked' ? <span>no try used</span> : null}
        </div>
      ) : (
        <div className="leg-meta">
          <span>this leg has never been assayed</span>
        </div>
      )}
    </div>
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
