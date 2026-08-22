/**
 * Trials — would this store pass?
 *
 * The question this page exists for is asked *before* a merge, about code that is not in the
 * store yet. Every other screen in the app is about what a subject carries; this one is about
 * what it would carry. That distinction is why a trial's result lives somewhere the archive
 * does not look, and the page has to keep saying so.
 *
 * **One input, matching the API.** A trial names a store zip and an app inside it — a GitHub
 * branch archive is one, and an upload session (MCP only, for the no-commit fix loop) produces
 * another. The form does not ask for a repo: the rubric anchor is resolved from the configured
 * origins, because whose `CONTRIBUTING.md` applies is a property of the store, not of the
 * branch under trial.
 *
 * Two things it must be honest about:
 *
 * - **A trial is a full audit**, static and functional both — Touchstone serves the exact
 *   archive it audited and the bench installs that. The one exception is an installation with
 *   no external address configured, and the row says so rather than showing a bare `blocked`.
 * - **Nothing here moves a hallmark.** The comparison column is the subject's *current*
 *   verdict, unchanged and unaffected by anything on this page.
 *
 * ## Why this page draws its cells the way the Overview does
 *
 * It used to draw them as `.tag` chips — the metadata pill that means `commit a1b2c3` or
 * `needs a bench` everywhere else in the app. Two things were wrong with that.
 *
 * The first is that the **"Currently" column quotes a hallmark**. Rendering it in a notation
 * the archive never uses is the failure `SubjectTable` exists to prevent, one file further
 * along: two ways of drawing `blocked` are two things that eventually disagree about what
 * `blocked` means. The second is that a chip has one channel — text — where `StatusCell` has
 * four, and the distinction it protects (checked-and-failed versus could-not-check) is exactly
 * the one a trial reader is making.
 *
 * The framing stays distinct instead, which is where it belongs and where it works: the header
 * says a trial moves nothing, the third column is labelled `Currently`, and there is no summary
 * strip — a population to triage is what a hallmark board is, and a trial is not one.
 */

import { useCallback, useMemo, useState } from 'react';

import type { TrialComparison, TrialRecord } from '@shared/trials';
import type { Severity, Verdict } from '@shared/types';
import { subjectName } from '@shared/subject';
import StatusCell, { StatusLegend } from '../components/StatusCell';
import { EmptyState, Loading, Notice } from '../components/Ui';
import MarkdownView from '../components/MarkdownView';
import {
  deleteTrial,
  getTrial,
  getTrialReport,
  getTrials,
  startTrial,
} from '../data/client';
import { useAsync } from '../hooks/useAsync';
import { since } from '../lib/format';
import { displayFacts, type StatusFacts } from '../lib/status';

/**
 * The one blocked reason that is a question for the operator rather than a passing condition.
 *
 * `domain/assay.ts` writes a distinct sentence for each of the four ways a section can block.
 * Three of them — no bench free, no browser answering, the store unreadable — say themselves in
 * the cell's own note and clear on their own. This one never clears: it is a setting nobody has
 * filled in, so it earns the sentence under the row.
 *
 * It is keyed on the reason rather than on "a non-static section is blocked", which is what it
 * used to be. That predicate was true of all four, so a dead browser sidecar was told to go set
 * a config key that was already correct.
 */
const STORE_URL_UNCONFIGURED = 'store_url_unconfigured';

/** One section, the trial's result beside what the subject carries today. */
function ComparisonRow({ row }: { row: TrialComparison }) {
  const unconfigured = row.trial?.status === 'blocked' && row.trial.blocked_reason === STORE_URL_UNCONFIGURED;
  return (
    <tr>
      <td className="trial-section">{row.section}</td>
      <td>
        <StatusCell state={displayFacts(row.trial)} />
        {unconfigured ? (
          <div className="trial-why">
            Not a fault, and not a limit of trials. A demo instance fetches the store over the
            public internet, and this Touchstone has no external address configured — set{' '}
            <code>trials.public_base_url</code> and this section runs.
          </div>
        ) : null}
      </td>
      <td>
        {row.current ? <StatusCell state={displayFacts(row.current)} /> : <span className="dim">—</span>}
      </td>
    </tr>
  );
}

function TrialDetail({ slug, onGone }: { slug: string; onGone: () => void }) {
  const detail = useAsync(() => getTrial(slug), [slug]);
  const [file, setFile] = useState<string | null>(null);
  const report = useAsync(
    () => (file ? getTrialReport(slug, file) : Promise.resolve(null)),
    [slug, file],
  );

  if (detail.loading) return <Loading what="the trial" />;
  if (detail.error) return <Notice tone="warn" title="The trial could not be read">{detail.error.message}</Notice>;
  const data = detail.data;
  if (!data) return null;

  const t = data.trial;
  return (
    <div className="trial-detail">
      <div className="trial-head">
        <div>
          <div className="trial-ref">
            {t.apps_path}/{t.subject}{' '}
            <span className="dim">from {t.upload_id ? `upload ${t.upload_id}` : t.source_url}</span>
          </div>
          <div className="dim">
            {t.finished_at ? `finished ${since(t.finished_at)} ago` : 'running'}
            {t.compare_to ? ` · compared against ${subjectName(t.compare_to)}` : ' · new app, nothing to compare'}
          </div>
        </div>
        <button
          className="btn"
          onClick={() => {
            void deleteTrial(slug).then(onGone);
          }}
        >
          Remove from list
        </button>
      </div>

      {t.error ? <Notice tone="warn" title="This trial did not complete">{t.error}</Notice> : null}

      {/* The legend belongs here rather than under the list: this is the table where the
          vocabulary does real work, because `blocked` and a failing verdict sit one column
          apart and mean opposite things about the app. */}
      <div className="panel">
        <div className="tbl-wrap">
          <table className="tbl trial-table">
            <thead>
              <tr>
                <th>Section</th>
                <th>This store</th>
                <th>Currently</th>
              </tr>
            </thead>
            <tbody>
              {data.comparison.map((row) => (
                <ComparisonRow key={row.section} row={row} />
              ))}
            </tbody>
          </table>
        </div>
        <StatusLegend />
      </div>

      <div className="trial-files">
        {data.history.map((rec) => (
          <button
            key={rec.file}
            className="btn btn--quiet"
            data-active={file === rec.file || undefined}
            onClick={() => setFile(rec.file)}
          >
            {rec.meta.section}
          </button>
        ))}
      </div>

      {report.loading ? <Loading what="the report" /> : null}
      {report.data ? <MarkdownView html={report.data.html} raw={report.data.raw} /> : null}
    </div>
  );
}

/**
 * A trial's own outcome, in the terms a status cell reads.
 *
 * `TrialRecord` records the run rather than one section — `outcome` is how the *job* ended, and
 * `verdict` is the composed answer when it ended with one. Mapping it here rather than adding a
 * sixth kind to the vocabulary keeps invariant 6's shape: nothing outside `lib/status.ts`
 * decides what a state looks like, it only says which state a thing is in.
 */
function outcomeFacts(t: TrialRecord): StatusFacts {
  if (!t.finished_at) {
    return { status: 'running', verdict: null, top_severity: 'none', risk_score: 0, started_at: t.started_at };
  }
  if (t.outcome === 'blocked' || t.outcome === 'agent_busy') {
    return {
      status: 'blocked',
      verdict: null,
      top_severity: 'none',
      risk_score: 0,
      // `agent_busy` names itself; a plain block does not, and the reason lives per-section on
      // the detail rather than on the record, so the list says `blocked` and stops there.
      ...(t.outcome === 'agent_busy' ? { blocked_reason: 'agent_busy' } : {}),
    };
  }
  if (t.outcome === 'error') {
    return { status: 'done', verdict: 'errored', top_severity: 'none', risk_score: 0 };
  }
  return {
    status: 'done',
    verdict: (t.verdict ?? null) as Verdict | null,
    top_severity: (t.top_severity ?? 'none') as Severity,
    risk_score: t.risk_score ?? 0,
  };
}

export default function Trials() {
  const [nonce, setNonce] = useState(0);
  const list = useAsync(() => getTrials(), [nonce]);
  const [selected, setSelected] = useState<string | null>(null);
  const [storeUrl, setStoreUrl] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trials = useMemo(() => list.data?.trials ?? [], [list.data]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { trial } = await startTrial({ store_url: storeUrl.trim(), subject: subject.trim() });
      setSelected(trial.slug);
      setNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [storeUrl, subject]);

  return (
    <div className="page page--wide">
      <div className="page-head">
        <h1>Trials</h1>
        <p className="page-sub">
          Audit a store before it is merged. A trial runs the whole protocol against the archive
          you name and is filed on its own — it never changes what an app currently carries, and
          it never enters the audit queue.
        </p>
      </div>

      <div className="card trial-form">
        <label className="trial-form-wide">
          <span>Store zip</span>
          <input
            className="control"
            value={storeUrl}
            onChange={(e) => setStoreUrl(e.target.value)}
            placeholder="https://github.com/Owner/AppStore/archive/refs/heads/pr-812.zip"
          />
        </label>
        <label>
          <span>App</span>
          <input
            className="control"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Widget"
          />
        </label>
        <button className="btn btn--primary" disabled={busy || !storeUrl || !subject} onClick={() => void submit()}>
          {busy ? 'Starting…' : 'Run trial'}
        </button>
      </div>

      {error ? <Notice tone="warn" title="The trial did not start">{error}</Notice> : null}

      {list.loading ? <Loading what="trials" /> : null}
      {!list.loading && trials.length === 0 ? (
        <EmptyState
          glyph="⌸"
          title="No trials yet"
          sub="Name a store zip and an app above to audit it before it is merged."
        />
      ) : null}

      {trials.length > 0 ? (
        <div className="panel">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>App</th>
                  <th>Store</th>
                  <th>Result</th>
                  <th style={{ textAlign: 'right' }}>Started</th>
                </tr>
              </thead>
              <tbody>
                {trials.map((t: TrialRecord) => (
                  <tr key={t.slug} data-active={selected === t.slug || undefined}>
                    <td>
                      {/* A button rather than a link: a trial is selected into the panel below
                          rather than navigated to, and a row that only responds to a mouse is
                          a row half the readers cannot open. */}
                      <button className="row-link" type="button" onClick={() => setSelected(t.slug)}>
                        {t.subject}
                      </button>
                    </td>
                    <td className="trial-src dim" title={t.upload_id ? `upload ${t.upload_id}` : t.source_url}>
                      {t.upload_id ? `upload ${t.upload_id}` : t.source_url}
                    </td>
                    <td><StatusCell state={displayFacts(outcomeFacts(t))} /></td>
                    <td className="col-num dim">{since(t.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {selected ? (
        <TrialDetail
          slug={selected}
          onGone={() => {
            setSelected(null);
            setNonce((n) => n + 1);
          }}
        />
      ) : null}
    </div>
  );
}
