/**
 * Trials — would this branch pass?
 *
 * The question this page exists for is asked *before* a merge, about code that is not in the
 * store yet. Every other screen in the app is about what a subject carries; this one is about
 * what it would carry. That distinction is why a trial's result lives somewhere the archive
 * does not look, and the page has to keep saying so — a verdict that looks like the others but
 * quietly means something else is worse than no verdict.
 *
 * Two things it must be honest about, because both are surprising:
 *
 * - **The functional section is always blocked**, and not because anything is broken. A demo
 *   bench installs from its own catalogue, which serves whatever store that instance points at
 *   rather than the ref under trial — so a functional result would be about `main` while
 *   carrying the branch's name. The row says this rather than showing a bare `blocked`.
 * - **Nothing here moves a hallmark.** The comparison column is the subject's *current*
 *   verdict, unchanged and unaffected by anything on this page.
 */

import { useCallback, useMemo, useState } from 'react';

import type { TrialComparison, TrialRecord } from '@shared/trials';
import { subjectName } from '@shared/subject';
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
import { ageLabel, num } from '../lib/format';

function severityOf(v: { top_severity?: string } | null): string {
  return v?.top_severity && v.top_severity !== 'none' ? v.top_severity : '';
}

/** One section, the trial's result beside what the subject carries today. */
function ComparisonRow({ row }: { row: TrialComparison }) {
  const blockedForStore =
    row.trial?.status === 'blocked' && row.trial.verdict === null && row.section !== 'static';
  return (
    <tr>
      <td className="trial-section">{row.section}</td>
      <td>
        {row.trial ? (
          <>
            <span className="tag" data-sev={severityOf(row.trial) || undefined}>
              {row.trial.status === 'done' ? row.trial.verdict : row.trial.status}
            </span>
            {row.trial.status === 'done' && row.trial.risk_score > 0 ? (
              <span className="dim"> · risk {num(row.trial.risk_score)}</span>
            ) : null}
          </>
        ) : (
          <span className="dim">not run</span>
        )}
        {blockedForStore ? (
          <div className="trial-why">
            Not a fault. A demo instance installs from its own catalogue, which serves the store
            it is configured with rather than this ref — so a functional result would be about
            the store’s own branch while carrying this ref’s name.
          </div>
        ) : null}
      </td>
      <td>
        {row.current ? (
          <>
            <span className="tag" data-sev={severityOf(row.current) || undefined}>
              {row.current.verdict ?? row.current.status}
            </span>
            {row.current.risk_score > 0 ? (
              <span className="dim"> · risk {num(row.current.risk_score)}</span>
            ) : null}
          </>
        ) : (
          <span className="dim">—</span>
        )}
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
            {t.repo}@{t.ref}:{t.apps_path}/{t.subject}
          </div>
          <div className="dim">
            {t.finished_at ? `finished ${ageLabel(0)}` : 'running'}
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

      <table className="table trial-table">
        <thead>
          <tr>
            <th>Section</th>
            <th>This ref</th>
            <th>Currently</th>
          </tr>
        </thead>
        <tbody>
          {data.comparison.map((row) => (
            <ComparisonRow key={row.section} row={row} />
          ))}
        </tbody>
      </table>

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

export default function Trials() {
  const [nonce, setNonce] = useState(0);
  const list = useAsync(() => getTrials(), [nonce]);
  const [selected, setSelected] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [ref, setRef] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trials = useMemo(() => list.data?.trials ?? [], [list.data]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { trial } = await startTrial({ repo: repo.trim(), ref: ref.trim(), subject: subject.trim() });
      setSelected(trial.slug);
      setNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [repo, ref, subject]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Trials</h1>
        <p className="page-sub">
          Audit a ref before it is merged. A trial runs the same protocol against the repository
          you name and is filed on its own — it never changes what an app currently carries, and
          it never enters the audit queue.
        </p>
      </div>

      <div className="card trial-form">
        <label>
          <span>Repository</span>
          <input
            className="control"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="Owner/AppStore"
          />
        </label>
        <label>
          <span>Ref</span>
          <input
            className="control"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder="pr-812"
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
        <button className="btn btn--primary" disabled={busy || !repo || !ref || !subject} onClick={() => void submit()}>
          {busy ? 'Starting…' : 'Run trial'}
        </button>
      </div>

      {error ? <Notice tone="warn" title="The trial did not start">{error}</Notice> : null}

      {/* Said once, here, rather than repeated on every row: the compose-level checks are the
          whole of a trial, and that is a property of how apps are installed rather than a
          shortcoming of this run. */}
      <Notice tone="info" title="Compose-level checks only">
        Installing the app would use a demo instance’s own catalogue, which serves the store it
        is configured with rather than the ref under trial, so the functional section is
        recorded as not run.
      </Notice>

      {list.loading ? <Loading what="trials" /> : null}
      {!list.loading && trials.length === 0 ? (
        <EmptyState
          title="No trials yet"
          sub="Name a repository, a ref and an app above to audit a branch before it is merged."
        />
      ) : null}

      {trials.length > 0 ? (
        <div className="trial-list">
          {trials.map((t: TrialRecord) => (
            <button
              key={t.slug}
              className="env-row trial-row"
              data-active={selected === t.slug || undefined}
              onClick={() => setSelected(t.slug)}
            >
              <span className="env-name">
                {t.subject} <span className="dim">{t.repo}@{t.ref}</span>
              </span>
              <span className="env-status">
                {t.outcome === 'verdict' ? t.verdict : (t.outcome ?? 'running')}
              </span>
              <span className="env-note dim">{t.started_at.slice(0, 16).replace('T', ' ')}</span>
            </button>
          ))}
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
