/**
 * One app, for the person who maintains it.
 *
 * The operator's subject page answers "what is the state of this thing and what do I do about
 * it": it carries the re-assay button, the run in flight, the raw report and its source. This
 * one answers a narrower question — *what does the standard say about my app, and what would I
 * have to change* — and answers it with three things, in the order somebody fixing an app
 * wants them:
 *
 *   1. the hallmark per section, with `blocked` visibly not a failure
 *   2. the requirements the audit settled, failures first
 *   3. the fix brief — the audit's own findings, evidence and proposed remedies
 *
 * The brief is fetched from `/public/subjects/:name/fix.md`, the same document the operator
 * gets and the same one a CI job can curl. It is shown as markdown source rather than rendered,
 * for the reason `components/FixReport.tsx` gives: the point of the text is to be taken away,
 * and rendered markdown is markdown you cannot copy correctly.
 *
 * There is no history and no report source. The hallmark is what the subject carries *now* —
 * that is what a hallmark is — and the evidence is quoted into the brief.
 */
import { standardLabel } from '@shared/standard';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { AssayRecord, Section } from '@shared/types';
import CoverageCell from '../components/CoverageCell';
import { ReadingPanel } from '../components/Reading';
import { isReading, readingOf, readingSections } from '../lib/reading';
import RequirementList from '../components/RequirementList';
import StandardChip, { VersionChip } from '../components/StandardChip';
import StatusCell from '../components/StatusCell';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { getPublicFixReport, getPublicSubject } from '../data/client';
import { useAsync } from '../hooks/useAsync';
import { dateOnly, num, since } from '../lib/format';
import { hasFixWork } from '../lib/overview';
import { displayState } from '../lib/status';

export default function PublicSubject() {
  const { name = '' } = useParams();
  const { data: subject, error, loading } = useAsync(() => getPublicSubject(name), [name]);

  useEffect(() => {
    document.title = subject ? `${subject.label} — App conformance` : 'App conformance';
  }, [subject]);

  if (loading) return <div className="page"><Loading what={name} /></div>;
  if (error || !subject) {
    return (
      <div className="page">
        <Notice tone="error" title={`Nothing published for ${name}`}>
          {error?.message ?? 'This app carries no hallmark.'} <Link to="/public">Back to the board</Link>.
        </Notice>
      </div>
    );
  }

  // Verdict cards for the sections that judge; a panel below for each one that measures.
  const sections = Object.keys(subject.sections ?? {}).filter((id) => !isReading(subject.sections?.[id]));
  const readings = readingSections([subject]);
  const refs = Object.values(subject.sections ?? {}).find(Boolean)?.meta;
  const never = sections.every((id) => !subject.sections?.[id]);
  const fixable = hasFixWork(subject);

  return (
    <div className="page page--wide">
      <div className="panel">
        <div className="subject-head">
          <div className="subject-head-top">
            <h1 className="subject-title">
              <Link to="/public" className="back-link" aria-label="Back to the board">‹</Link>
              {subject.label}
            </h1>
            {/* The store the app comes from. Always shown here, unlike on the board: a reader
                arriving from a deep link has no table beside them to infer it from. */}
            <span className="tag store-tag">{subject.origin}</span>
            <StandardChip standard={subject.standard} />
            <VersionChip version={subject.subject_version} />
            <div style={{ flex: 1 }} />
            <div style={{ textAlign: 'right' }}>
              <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>
                {never ? '—' : num(subject.risk)}
              </div>
              <div className="section-title">risk</div>
            </div>
          </div>

          {refs ? (
            <div className="subject-refs">
              <div className="ref-line">{refs.subject_ref ?? '—'}</div>
              <div className="ref-line">
                {(refs.images ?? []).map((im) => (
                  <span className="tag" key={im}>{im}</span>
                ))}
                {refs.commit ? <span className="tag">commit {refs.commit}</span> : null}
                {/* Which revision of the standard judged this. Invariant 9: every assay
                    records it, and an author is entitled to know they were graded on an older
                    one. Not a link: there is no protocol page under /public, and a link into
                    the operator frame is a dead end for somebody with no account. The hash
                    still prints, so an author can quote the exact revision. */}
                <span className="tag">{standardLabel(refs)}</span>
              </div>
            </div>
          ) : null}
        </div>

        <div className="legs">
          {sections.map((id) => (
            <SectionCard key={id} section={id} rec={subject.sections?.[id] ?? null} />
          ))}
        </div>
      </div>

      {/* An author's most actionable page item: a version number to bump needs no argument. */}
      {readings.map((id) => {
        const reading = readingOf(subject, id);
        return reading ? <div style={{ marginTop: 14 }} key={id}><ReadingPanel reading={reading} /></div> : null;
      })}

      {never ? (
        <div className="panel" style={{ marginTop: 14 }}>
          <EmptyState
            glyph="⬜"
            title="This app has not been assayed"
            sub="It is on the list and nothing more. There is no verdict to disagree with, and nothing yet to fix."
          />
        </div>
      ) : null}

      {/* One block per section that recorded items, rather than a tab strip: an author reading
          their own app wants all of it on the page, and there is nothing to press here anyway. */}
      {sections.map((id) => {
        const rec = subject.sections?.[id];
        const items = rec?.meta.requirements ?? [];
        if (!rec || items.length === 0) return null;
        return (
          <section className="panel" style={{ marginTop: 14 }} key={id}>
            <div className="pane-head">
              <span className="section-title">{id} — what was checked</span>
              {rec.meta.coverage ? (
                <span className="dim" style={{ fontSize: 11.5 }}>
                  <CoverageCell coverage={rec.meta.coverage} /> verified
                </span>
              ) : null}
            </div>
            <RequirementList items={items} />
          </section>
        );
      })}

      {fixable ? <FixBrief subject={subject.name} /> : null}
    </div>
  );
}

function SectionCard({ section, rec }: { section: Section; rec: AssayRecord | null }) {
  const s = displayState(rec);
  return (
    <div className="leg-card">
      <span className="leg-name">{section}</span>
      <StatusCell state={s} size="lg" />
      {rec ? (
        <div className="leg-meta">
          <span>{standardLabel(rec.meta)}</span>
          <span>
            {s.kind === 'blocked' ? 'since' : 'assayed'} {dateOnly(rec.meta.started_at)} ·{' '}
            {since(rec.meta.started_at)}
          </span>
          {/* The sentence this whole design exists to print. */}
          {rec.meta.status === 'blocked' ? <span>nothing was concluded about the app</span> : null}
        </div>
      ) : (
        <div className="leg-meta">
          <span>this section has never been assayed</span>
        </div>
      )}
    </div>
  );
}

/**
 * The audit, turned round to face whoever has to fix the app.
 *
 * Fetched rather than composed here — two copies of a document are two documents, and the one
 * an author pastes into an assistant has to be the one the endpoint serves.
 */
function FixBrief({ subject }: { subject: string }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    getPublicFixReport(subject)
      .then((body) => live && setText(body))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [subject]);

  return (
    <section className="panel pane" style={{ marginTop: 14 }}>
      <div className="pane-head">
        <span className="section-title">what to fix</span>
        <span className="dim" style={{ fontSize: 11.5 }}>
          the audit's own findings, worst first
        </span>
      </div>
      <div className="pane-body">
        {error ? (
          <p className="notice notice--error">{error}</p>
        ) : !text ? (
          <p className="dim">Composing…</p>
        ) : (
          <>
            <p className="fixrep-note">
              Quoted from what the audit recorded — nothing is re-derived, and where it proposed
              no remedy this says so rather than inventing one. The same document is at{' '}
              <code className="mono">/api/v1/public/subjects/{encodeURIComponent(subject)}/fix.md</code>{' '}
              for a script or a CI job.
            </p>
            <pre className="fixrep-body">{text}</pre>
          </>
        )}
      </div>
    </section>
  );
}
