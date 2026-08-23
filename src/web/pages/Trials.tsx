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
 *   no external address configured, and the detail page says so rather than showing a bare
 *   `blocked`.
 * - **Nothing here moves a hallmark.** The comparison on the detail page is the subject's
 *   *current* verdict, unchanged and unaffected by anything under this route.
 *
 * ## Why the list draws the same columns the Store page draws
 *
 * It used to draw one `Result` cell per row, derived from the trial *record* — which carries
 * how the **job** ended, not what it found. A trial whose static section failed and whose
 * functional section was blocked has two different answers, and one word cannot hold both: it
 * showed `non-compliant` and said nothing about the half nobody managed to check. Those are
 * precisely the two states the whole status vocabulary exists to keep apart.
 *
 * So the row carries its sections — from the trial's own reports, composed by the same
 * function the Store page's rows come from — and is drawn with the same cells: a column per
 * section, a column per reading, coverage, risk. What is deliberately *not* copied over is
 * the Store page's furniture: no summary strip and no filters, because a population to triage
 * is what a hallmark board is and a list of PR debris is not one; and no `Last` column,
 * because a trial is one-shot and never re-run, so `Started` already is that column.
 */

import { useCallback, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import type { TrialSummary } from '@shared/trials';
import CoverageCell from '../components/CoverageCell';
import { ReadingBadge } from '../components/Reading';
import StatusCell, { StatusLegend } from '../components/StatusCell';
import { EmptyState, Loading, Notice } from '../components/Ui';
import { getTrials, startTrial } from '../data/client';
import { useRunStatus } from '../data/runStatus';
import { useAsync } from '../hooks/useAsync';
import { num, since } from '../lib/format';
import { coverageOf, legState, type LiveRun } from '../lib/overview';
import { readingOf, readingSections } from '../lib/reading';
import { liveLegs, progressLabel } from '../lib/run';

/** `currency` → `Currency`. The section id is the only name a reading column has. */
function label(id: string): string {
  return id.charAt(0).toUpperCase() + id.slice(1).replace(/[-_]/g, ' ');
}

/** Where the archive came from, in one string. An upload never had a URL to record. */
function sourceOf(t: TrialSummary): string {
  return t.upload_id ? `upload ${t.upload_id}` : t.source_url;
}

/**
 * The trial's own outcome, in a line under its name — but only when the sections cannot say it.
 *
 * The section columns are the answer whenever the run wrote reports. They cannot be the answer
 * when it wrote none: a trial that errored before the first assay, or that the agent was too
 * busy to take, has nothing but empty cells, and a row reading `not yet run` twice is a row
 * that has quietly lost its own failure. An unfinished row that is not the run in flight is
 * the same problem in the other direction — the API restarted under it and nothing will ever
 * come back to finish it.
 */
function trialNote(t: TrialSummary, live: LiveRun | null): string | null {
  if (!t.finished_at) return live?.subject === t.state.name ? null : 'started, and never finished';
  switch (t.outcome) {
    case 'agent_busy':
      return 'not run — the agent was busy';
    case 'error':
      return t.error ? `did not complete — ${t.error}` : 'did not complete';
    case 'blocked':
      return t.error ? `blocked — ${t.error}` : 'blocked';
    default:
      return null;
  }
}

export default function Trials() {
  const [nonce, setNonce] = useState(0);
  const list = useAsync(() => getTrials(), [nonce]);
  const status = useRunStatus();
  const [storeUrl, setStoreUrl] = useState('');
  const [subject, setSubject] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trials = useMemo(() => list.data?.trials ?? [], [list.data]);

  /**
   * The run in flight, overlaid on the table exactly as the Store page overlays it.
   *
   * A trial run's subject key is `<slug>~<subject>` — the slug is the synthetic origin — so
   * this needs no special case: the row whose state carries that key gets `◴ running` cells
   * while the audit is on, and the same cells hold its verdict when it lands.
   */
  const live: LiveRun | null = useMemo(() => {
    const running = status?.running;
    if (!running) return null;
    const counted = progressLabel(status?.progress);
    return {
      subject: running.subject,
      legs: liveLegs(running),
      started_at: running.started_at,
      ...(counted ? { note: counted } : {}),
    };
  }, [status?.running, status?.progress]);

  // Derived from the rows, blind to what is being measured: a reading column appears the
  // moment one trial has an assay from a section that measures. Same rule as the Store table.
  const notices = useMemo(() => readingSections(trials.map((t) => t.state)), [trials]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await startTrial({ store_url: storeUrl.trim(), subject: subject.trim() });
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
                  <th>Static</th>
                  <th>Functional</th>
                  {notices.map((id) => (
                    <th key={id}>{label(id)}</th>
                  ))}
                  <th style={{ textAlign: 'right' }}>Verified</th>
                  <th style={{ textAlign: 'right' }}>Risk</th>
                  <th style={{ textAlign: 'right' }}>Started</th>
                  <th aria-label="open" />
                </tr>
              </thead>
              <tbody>
                {trials.map((t) => (
                  <Row key={t.slug} t={t} live={live} notices={notices} />
                ))}
              </tbody>
            </table>
          </div>
          <StatusLegend />
        </div>
      ) : null}
    </div>
  );
}

function Row({ t, live, notices }: { t: TrialSummary; live: LiveRun | null; notices: string[] }) {
  const to = `/trials/${encodeURIComponent(t.slug)}`;
  const running = live?.subject === t.state.name;
  const note = trialNote(t, live);
  const never = !t.state.static && !t.state.functional;
  const source = sourceOf(t);
  return (
    <tr data-running={running || undefined}>
      <td>
        {/* A link now, not a button: a trial has its own address, so a result can be pasted
            into the PR it is about and survive a reload. */}
        <Link className="row-link" to={to}>
          {t.subject}
        </Link>
        {note ? <div className="trial-why trial-why--tight">{note}</div> : null}
      </td>
      <td className="trial-src dim" title={source}>{source}</td>
      <td><StatusCell state={legState(t.state, 'static', live)} showNote={running} /></td>
      <td><StatusCell state={legState(t.state, 'functional', live)} /></td>
      {notices.map((id) => (
        <td key={id}><ReadingBadge reading={readingOf(t.state, id)} /></td>
      ))}
      <td className="col-num"><CoverageCell coverage={coverageOf(t.state)} /></td>
      <td className="col-num">
        <span className="risk-val" data-zero={t.state.risk === 0 || never}>
          {never ? '—' : num(t.state.risk)}
        </span>
      </td>
      <td className="col-num dim">{since(t.started_at)}</td>
      <td className="col-chev">
        <Link to={to} aria-label={`Open the trial of ${t.subject}`}>›</Link>
      </td>
    </tr>
  );
}
