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

import type { Section } from '@shared/types';
import MarkdownView, { MissingReport } from '../components/MarkdownView';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { getReport, getSubject } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import AuditControl from '../components/AuditControl';
import FixReportPanel, { FixReportButton } from '../components/FixReport';
import LegCard, { StandardTag, verdictSections } from '../components/LegCard';
import { RequirementsPanel } from '../components/RequirementList';
import RunCard from '../components/RunCard';
import StandardChip, { DelistedChip, VersionChip } from '../components/StandardChip';
import { ReadingPanel } from '../components/Reading';
import { readingOf, readingSections } from '../lib/reading';
import { num, stamp } from '../lib/format';
import { download } from '../lib/download';
import { hasFixWork } from '../lib/overview';
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
          <Link to="/store">Back to the store</Link>.
        </Notice>
      </div>
    );
  }

  const refs = subject.static?.meta ?? subject.functional?.meta;
  const never = !subject.static && !subject.functional;

  /**
   * Is there anything to fix? Shared with the public board, which asks the same question and
   * must get the same answer — see `lib/overview.ts`. It reads every section rather than the
   * two this page happens to name, so a third rubric needs no edit here.
   */
  const fixable = hasFixWork(subject);

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
              <Link to="/store" className="back-link" aria-label="Back to the store">‹</Link>
              {subject.label}
            </h1>
            {/* The same caveat the Store row carried, so clicking the chip does not land on a
                page that has forgotten about it. */}
            <DelistedChip delisted={subject.delisted} />
            <StandardChip standard={subject.standard} />
            <VersionChip version={subject.subject_version} />
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
            {/* One verb. There were two here — the queue's and the agent's — and the split
                asked the operator to decide something that was never theirs to decide: whether
                an audit starts now or waits is a fact about the line. */}
            <AuditControl
              subject={subject.name}
              queued={data.queued}
              {...(data.queue_position ? { position: data.queue_position } : {})}
              onChanged={() => reload()}
            />
          </div>

          {refs ? (
            <div className="subject-refs">
              <div className="ref-line">{refs.subject_ref ?? '—'}</div>
              <div className="ref-line">
                {(refs.images ?? []).map((im) => (
                  <span className="tag" key={im}>{im}</span>
                ))}
                {refs.commit ? <span className="tag">commit {refs.commit}</span> : null}
                {/* The revision that judged this, and — because it is a hash rather than a
                    number — a way to go and read exactly those bytes. That dereference is the
                    whole point of the protocol history. */}
                <StandardTag meta={refs} section={refs.section} />
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
          {verdictSections(subject, live).map((id) => (
            <LegCard key={id} leg={id} rec={subject.sections?.[id] ?? null} live={live} />
          ))}
        </div>
      </div>

      {/*
        Every reading this subject has — one panel each, above the report because they are the
        cheapest thing on the page to act on: a version to bump needs no argument, where a
        finding needs the report read.
      */}
      {readingSections([subject]).map((id) => {
        const reading = readingOf(subject, id);
        return reading ? <div style={{ marginTop: 14 }} key={id}><ReadingPanel reading={reading} /></div> : null;
      })}

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
      <RequirementsPanel rec={currentRec} />

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
            action={
              <AuditControl
                subject={subject.name}
                queued={data.queued}
                {...(data.queue_position ? { position: data.queue_position } : {})}
                onChanged={() => reload()}
              />
            }
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
