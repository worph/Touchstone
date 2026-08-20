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

import type { AssayRecord, Section, SubjectState } from '@shared/types';
import MarkdownView, { MissingReport } from '../components/MarkdownView';
import StatusCell from '../components/StatusCell';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { getReport, getSubject } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import ReassayButton from '../components/ReassayButton';
import FixReportPanel, { FixReportButton } from '../components/FixReport';
import CoverageCell from '../components/CoverageCell';
import RequirementList from '../components/RequirementList';
import RunCard from '../components/RunCard';
import { dateOnly, num, since, stamp } from '../lib/format';
import { displayState, runningState } from '../lib/status';
import { useRunStatus } from '../data/runStatus';
import { liveLegs, progressLabel } from '../lib/run';

export default function SubjectDetail() {
  const { name = '' } = useParams();
  const status = useRunStatus();
  // `nonce` is what a finished audit changes: it re-runs the subject fetch, which pulls in
  // the assay the run just wrote without a page reload.
  const [nonce, setNonce] = useState(0);
  const { data, error, loading } = useAsync(() => getSubject(name), [name, nonce]);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const [selectedLeg, setSelectedLeg] = useState<Section | null>(null);
  const [view, setView] = useState<'rendered' | 'raw'>('rendered');
  const [fixOpen, setFixOpen] = useState(false);

  const paneRef = useRef<HTMLDivElement>(null);

  // reset the pane when navigating between subjects
  useEffect(() => {
    setSelectedLeg(null);
    setView('rendered');
    setFixOpen(false);
  }, [name]);

  const subject = data?.subject;

  /**
   * Which sections this subject has a report for, in archive order, and which one opens.
   *
   * The default is the first section that actually has a record — for the current protocol
   * that is `static`, which is also the one that most often has a body, but nothing here
   * names it.
   */
  const reported: Section[] = Object.entries(subject?.sections ?? {})
    .filter(([, rec]) => rec)
    .map(([id]) => id);
  const currentLeg = (selectedLeg && reported.includes(selectedLeg) ? selectedLeg : reported[0]) ?? null;
  const currentRec = currentLeg ? (subject?.sections?.[currentLeg] ?? null) : null;
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

  /**
   * Is there anything to fix? Failing requirements, or a functional phase that did not pass.
   *
   * Not "is it non-compliant": an assay imported before the ledger existed has a verdict and
   * no recorded requirements, and a fix report built from that would be a page of headings
   * with nothing under them.
   */
  const fixable =
    [subject.static, subject.functional].some((rec) =>
      (rec?.meta.requirements ?? []).some((r) => r.verdict === 'fail'),
    ) ||
    (subject.functional?.meta.phases ?? []).some((p) => p.result === 'fail' || p.result === 'errored');

  /** The run in flight, when it is this subject's. See `lib/overview.ts` for why it is an overlay. */
  const running = status?.running?.subject === subject.name ? status.running : null;
  const live = running
    ? {
        legs: liveLegs(running),
        started_at: running.started_at,
        ...(progressLabel(status?.progress) ? { note: progressLabel(status?.progress) } : {}),
      }
    : null;

  return (
    <div className="page page--wide">
      <div className="panel">
        <div className="subject-head">
          <div className="subject-head-top">
            <h1 className="subject-title">
              <Link to="/" className="back-link" aria-label="Back to overview">‹</Link>
              {subject.label}
            </h1>
            <div style={{ flex: 1 }} />
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>
                {never ? '—' : num(subject.risk)}
              </div>
              <div className="section-title">risk</div>
            </div>
            {/* Only when there is something to brief anyone on. A "fix report" button on a
                compliant app is a button that produces a document saying nothing. */}
            {fixable ? <FixReportButton open={fixOpen} onToggle={() => setFixOpen((v) => !v)} /> : null}
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

        {/*
          One card per section the subject actually has, in the order the archive reports
          them — plus any section this run is adding for the first time, so a brand-new
          rubric shows up as `running` rather than appearing only once it has finished.

          These used to be two hard-coded cards, `static` and `functional`. There are still
          two of them here because the protocol has two leaves; there would be three if
          `data/protocols/` held three, with no change to this file.
        */}
        <div className="legs">
          {sectionsOf(subject, live).map((id) => (
            <LegCard key={id} leg={id} rec={subject.sections?.[id] ?? null} live={live} />
          ))}
        </div>
      </div>

      {/*
        The audit in flight, when it is this one's — the same card Activity draws, off the
        same poll.

        The strip in the shell points here, and until now that click went from the densest
        live thing in the app to two cards saying "being assayed now" and nothing else. The
        promise the strip makes is live detail; this is where it has to be kept. It sits
        above the report because while a run is on, the report below is the *previous*
        verdict, and the live one outranks it.
      */}
      <div style={{ marginTop: 14 }}>
        <RunCard subject={subject.name} showSubject={false} showIdle={false} heading="This audit, in flight" />
      </div>

      {fixOpen && fixable ? (
        <FixReportPanel subject={subject.name} onClose={() => setFixOpen(false)} />
      ) : null}

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
            glyph={live ? '◴' : '⬜'}
            title={live ? 'The first assay of this subject is running' : 'No assay has ever run for this subject'}
            sub={
              live
                ? 'There is nothing to read yet. The report is written when the run finishes, and this page picks it up without a reload.'
                : 'It is in the registry and nothing more. There is no verdict to disagree with, and no report to read.'
            }
            action={<ReassayButton subject={subject.name} onFinished={reload} label="Run first assay" />}
          />
        </div>
      ) : (
        <section className="panel pane" style={{ marginTop: 14 }}>
          <div className="pane-head">
            <span className="section-title">report</span>
            {currentRec ? (
              <span className="dim" style={{ fontSize: 11.5 }}>
                {currentRec.meta.section} · {stamp(currentRec.meta.started_at)}
              </span>
            ) : null}
            <span style={{ flex: 1 }} />

            {/* One tab per section that has a report. Two today; the count is the archive's. */}
            {reported.length > 1 ? (
              <div className="seg">
                {reported.map((id) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={currentLeg === id}
                    onClick={() => setSelectedLeg(id)}
                  >
                    {id}
                  </button>
                ))}
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

interface LiveLeg {
  legs: Section[];
  started_at: string;
  note?: string;
}

/** The sections to draw: what the subject has, plus what this run is adding. */
function sectionsOf(subject: SubjectState, live: LiveLeg | null): Section[] {
  const known = Object.keys(subject.sections ?? {});
  const extra = (live?.legs ?? []).filter((id) => !known.includes(id));
  return [...known, ...extra];
}

function LegCard({ leg, rec, live }: { leg: Section; rec: AssayRecord | null; live: LiveLeg | null }) {
  /**
   * No count on the card. `16/25` is a fact about the *run*, and printing it once per section
   * says each section is 16/25 of the way through its own list — two cards, the same number,
   * neither of them true. The run's progress belongs to the run card, which is on screen
   * beside this one; the section card says only that this section is being worked on.
   */
  const running = live?.legs.includes(leg) ? runningState(live.started_at) : null;
  const s = running ?? displayState(rec);
  return (
    <div className="leg-card">
      <span className="leg-name">{leg}</span>
      {/* While running the note is suppressed: the line below already says "being assayed
          now", and the run's clock and count belong to the run card, once, not to each
          section. A finished record keeps its note — that one is about the section. */}
      <StatusCell state={s} size="lg" showNote={!running} />
      {running ? (
        <div className="leg-meta">
          <span>being assayed now</span>
        </div>
      ) : rec ? (
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
          <span>this section has never been assayed</span>
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
