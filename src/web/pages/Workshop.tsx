/**
 * The Workshop — the one place Touchstone *makes* rather than judges.
 *
 * A proposal is a change to one app's store listing that Touchstone authors against a leased
 * bench, validates with trials on every platform the standard covers, and — within a daily
 * quota — opens as a pull request under the configured GitHub account (docs/auto-app-pr.md).
 *
 * Every verb on this page is the operator's and appears nowhere else: the chat and the admin
 * MCP can read the workshop but cannot propose, open a PR, discard, arm it or clear what it
 * remembers, because each of those ends in a pull request under a person's identity.
 *
 * Things the page must be honest about:
 *
 * - **A ready proposal has passed, it has not merged.** Nothing here moves a hallmark; that
 *   happens when a person merges the PR and the ordinary loop audits what the store offers.
 * - **Memory is not a queue.** A task the workshop tried and gave up on waits for its input
 *   to change — the app, the standard, the wish file — and Clear is how a person says "try
 *   again anyway".
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import type { CandidateRow, PrMergeable, ProposalDetail, ProposalPr, ProposalSummary, WorkshopView } from '@shared/workshop';
import { ErrorState, Loading, Notice } from '../components/Ui';
import {
  armWorkshop,
  discardProposal,
  forgetTask,
  getProposal,
  getWorkshop,
  proposeWork,
  setControl,
  submitProposal,
} from '../data/client';
import { useAsync } from '../hooks/useAsync';
import { since, until } from '../lib/format';

const ACTIVE = new Set(['queued', 'authoring', 'validating', 'revising', 'ready', 'submitted']);

const STATE_WORD: Record<string, string> = {
  queued: 'waiting for quiet',
  authoring: 'authoring now',
  validating: 'validating',
  revising: 'back for another round',
  ready: 'ready to open',
  submitted: 'pull request open',
  merged: 'merged',
  closed: 'closed unmerged',
  failed: 'given up',
  cannot: 'cannot be done',
  discarded: 'discarded',
};

const KIND_WORD = { fix: 'fix', currency: 'update', wish: 'add' } as const;

export default function Workshop() {
  const { id } = useParams<{ id: string }>();
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const view = useAsync(() => getWorkshop(), [nonce]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setInterval(reload, 15_000);
    return () => clearInterval(t);
  }, [reload]);

  const act = useCallback(
    async (work: () => Promise<unknown>) => {
      setError(null);
      try {
        await work();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        reload();
      }
    },
    [reload],
  );

  if (view.error && !view.data) return <div className="page"><ErrorState error={view.error} what="the workshop" /></div>;
  if (!view.data) return <div className="page"><Loading what="the workshop" /></div>;
  const v = view.data;
  const live = v.proposals.filter((p) => ACTIVE.has(p.state));
  const done = v.proposals.filter((p) => !ACTIVE.has(p.state));

  return (
    <div className="page page--wide">
      <h1>Workshop</h1>
      <p className="dim" style={{ marginTop: -6 }}>
        Proposals Touchstone authors against a bench, validates on every platform and opens as pull
        requests on <strong>{v.origin}</strong> — at most {v.prs_per_day} a day, never merged by itself.
        Nothing here moves a verdict until a person merges.
      </p>

      {!v.configured ? (
        <Notice tone="warn" title="The workshop is not configured">
          {v.unconfigured_reason}
          {v.github.state === 'unconfigured' ? (
            <>
              {' '}
              — <Link to="/settings/workshop">set the GitHub token in Settings</Link>.
            </>
          ) : null}
        </Notice>
      ) : null}
      {error ? <Notice tone="warn" title="That did not work">{error}</Notice> : null}

      {id ? <ProposalPanel id={id} onAct={act} quota={v.quota} /> : null}

      <section className="act-section">
        <h2 className="act-h">State</h2>
        <div className="env">
          <div className="env-row" data-status={v.github.state === 'ok' ? 'healthy' : v.github.state === 'unconfigured' ? 'unconfigured' : 'unreachable'}>
            <span className="env-name">GitHub</span>
            <span className="env-status">
              {v.github.state === 'ok' ? `as ${v.github.login}` : v.github.state === 'unconfigured' ? 'no token' : v.github.state}
            </span>
            <span className="env-note">
              {v.github.repo ? `${v.github.repo} · ` : ''}
              {v.github.problems.join('; ') || (v.github.label === false ? 'the "touchstone" label is missing — create it once by hand' : v.github.state === 'unconfigured' ? 'no token yet' : 'can push touchstone/… branches and open pull requests')}
              {' · '}
              <Link to="/settings/workshop">{v.github.state === 'ok' ? 'token in Settings' : 'set it in Settings'}</Link>
            </span>
          </div>
          <div className="env-row" data-status={v.armed ? 'healthy' : 'unconfigured'}>
            <span className="env-name">Picks work</span>
            <span className="env-status">{v.armed ? 'armed' : 'off'}</span>
            <span className="env-note ctl-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>
                {v.armed
                  ? 'Picks its own work when the queue is quiet.'
                  : 'Only what a person proposes is authored.'}
              </span>
              <button className="btn btn--sm" type="button" onClick={() => void act(() => armWorkshop(!v.armed))}>
                {v.armed ? 'Disarm' : 'Arm'}
              </button>
            </span>
          </div>
          <div className="env-row" data-status={v.auto_submit ? 'healthy' : 'unconfigured'}>
            <span className="env-name">Submits</span>
            <span className="env-status">{v.auto_submit ? 'automatically' : 'on approval'}</span>
            <span className="env-note ctl-row" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span>
                {v.auto_submit
                  ? 'A proposal that passes validation is submitted by itself, within the quota.'
                  : 'A person presses the button on every ready proposal.'}
              </span>
              <button
                className="btn btn--sm"
                type="button"
                onClick={() => void act(() => setControl('workshop.auto_submit', !v.auto_submit))}
              >
                {v.auto_submit ? 'Require approval' : 'Submit automatically'}
              </button>
            </span>
          </div>
          <div className="env-row" data-status={v.quota.allowed ? 'healthy' : 'unconfigured'}>
            <span className="env-name">Quota</span>
            <span className="env-status">
              {v.quota.opened_last_24h} of {v.prs_per_day} today
            </span>
            <span className="env-note">
              {v.prs_per_day === 0
                ? 'Dry run: proposals are built and validated but never opened.'
                : v.quota.allowed
                  ? 'A slot is free.'
                  : `Next slot ${until(v.quota.next_slot_at)}.`}
              {' · '}
              <Link to="/settings/workshop">change in Settings</Link>
            </span>
          </div>
          {v.live ? (
            <div className="env-row auto-row" data-state="running">
              <span className="env-name">Now</span>
              <span className="env-status">
                <Link to={`/workshop/${v.live.id}`}>
                  {KIND_WORD[v.live.kind]} {v.live.app}
                </Link>
              </span>
              <span className="env-note">round {v.live.round} · started {since(v.live.started_at)}</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="act-section">
        <h2 className="act-h">
          In flight <span className="act-count">{live.length}</span>
        </h2>
        {live.length === 0 ? (
          <div className="act-quiet">Nothing is being worked on. Press <strong>Propose</strong> on a candidate below, or on an app's page.</div>
        ) : (
          <ProposalTable rows={live} onAct={act} quotaAllowed={v.quota.allowed} />
        )}
      </section>

      <section className="act-section">
        <h2 className="act-h">
          Candidates <span className="act-count">{v.candidates.filter((c) => c.eligible).length}</span>
        </h2>
        {v.candidates.length === 0 ? (
          <div className="act-quiet">Nothing to fix, update or add — or the workshop is not configured.</div>
        ) : (
          <div className="env">
            {v.candidates.slice(0, 40).map((c) => (
              <CandidateLine key={c.task_key} c={c} onAct={act} />
            ))}
          </div>
        )}
        {v.open_pr_apps === null && v.configured ? (
          <div className="backlog-note">
            <span aria-hidden="true">▨</span>
            <span>Open pull requests could not be read, so nothing is picked automatically until they can.</span>
          </div>
        ) : null}
      </section>

      <section className="act-section">
        <h2 className="act-h">
          Wishlist <span className="act-count">{v.wishlist.length}</span>
        </h2>
        {v.wishlist.length === 0 ? (
          <div className="act-quiet">
            No wishes. Add one file per app to <code>data/wishlist/</code> — see <code>_example.md</code> there.
          </div>
        ) : (
          <div className="env">
            {v.wishlist.map((w) => (
              <div key={w.file} className="env-row auto-row" data-state={w.problem || w.offered ? 'parked' : 'waiting'}>
                <span className="auto-pos">{w.order ?? ''}</span>
                <span className="env-name">{w.name || w.file}</span>
                <span className="env-status">{w.problem ? 'unusable' : w.offered ? 'already in a store' : w.memory ? w.memory.outcome.replace(/_/g, ' ') : 'not tried'}</span>
                <span className="env-note">
                  <code>{w.file}</code> · {w.image}
                  {w.problem ? ` — ${w.problem}` : ''}
                  {w.memory ? ` — tried ${since(w.memory.last_attempt_at)}${w.memory.reason ? `: ${w.memory.reason}` : ''}` : ''}
                </span>
                <span className="auto-flag">
                  {w.memory ? (
                    <button className="btn btn--sm" type="button" title="Forget the last attempt" onClick={() => void act(() => forgetTask(`wish:${w.file}`))}>
                      Clear
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="act-section">
        <h2 className="act-h">
          History <span className="act-count">{done.length}</span>
        </h2>
        {done.length === 0 ? (
          <div className="act-quiet">No finished proposals yet.</div>
        ) : (
          <ProposalTable rows={done.slice(0, 50)} onAct={act} quotaAllowed={false} />
        )}
      </section>
    </div>
  );
}

function ProposalTable({
  rows,
  onAct,
  quotaAllowed,
}: {
  rows: ProposalSummary[];
  onAct: (w: () => Promise<unknown>) => Promise<void>;
  quotaAllowed: boolean;
}) {
  return (
    <div className="panel">
      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>App</th>
              <th>Kind</th>
              <th>State</th>
              <th style={{ textAlign: 'right' }}>Round</th>
              <th style={{ textAlign: 'right' }}>Change</th>
              <th style={{ textAlign: 'right' }}>Asked</th>
              <th aria-label="actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} data-running={p.state === 'authoring' || undefined}>
                <td>
                  <Link className="row-link" to={`/workshop/${p.id}`}>
                    {p.app}
                  </Link>
                  {p.reason && !ACTIVE.has(p.state) ? <div className="trial-why trial-why--tight">{p.reason}</div> : null}
                </td>
                <td className="dim">
                  {KIND_WORD[p.kind]}
                  {p.major ? ' · major' : ''}
                  {p.class === 'idle' ? ' · picked' : ''}
                </td>
                <td>
                  {p.pr ? (
                    <>
                      <a href={p.pr.url} target="_blank" rel="noreferrer">
                        #{p.pr.number} {STATE_WORD[p.state]}
                      </a>
                      {p.state === 'submitted' ? <MergeableChip pr={p.pr} /> : null}
                    </>
                  ) : (
                    STATE_WORD[p.state]
                  )}
                </td>
                <td className="col-num">
                  {p.round}/{p.max_rounds}
                </td>
                <td className="col-num dim">{p.diff ? `+${p.diff.added} ~${p.diff.modified} −${p.diff.deleted}` : '—'}</td>
                <td className="col-num dim">{since(p.asked_at)}</td>
                <td className="col-action" style={{ whiteSpace: 'nowrap' }}>
                  {p.state === 'ready' ? (
                    <button
                      className="btn btn--sm"
                      type="button"
                      disabled={!quotaAllowed}
                      title={quotaAllowed ? 'Open the pull request on GitHub' : 'The daily quota is spent'}
                      onClick={() => void onAct(() => submitProposal(p.id))}
                    >
                      Open PR
                    </button>
                  ) : null}{' '}
                  {['queued', 'revising', 'validating', 'ready'].includes(p.state) ? (
                    <button className="btn btn--sm" type="button" title="Throw it away; charges the task nothing" onClick={() => void onAct(() => discardProposal(p.id))}>
                      Discard
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CandidateLine({ c, onAct }: { c: CandidateRow; onAct: (w: () => Promise<unknown>) => Promise<void> }) {
  const remembered = c.reasons.some((r) => r.startsWith('tried '));
  return (
    <div className="env-row auto-row" data-state={c.eligible ? 'waiting' : 'fresh'}>
      <span className="auto-pos">{KIND_WORD[c.kind].charAt(0)}</span>
      <span className="env-name">
        {c.subject ? <Link to={`/s/${encodeURIComponent(c.subject)}`}>{c.app}</Link> : c.app}
      </span>
      <span className="env-status">{c.label}</span>
      <span className="env-note">{c.eligible ? 'eligible — picked when the workshop is armed and the queue is quiet' : c.reasons.join('; ')}</span>
      <span className="auto-flag" style={{ display: 'flex', gap: 4 }}>
        {remembered ? (
          <button className="btn btn--sm" type="button" title="Forget the last attempt" onClick={() => void onAct(() => forgetTask(c.task_key))}>
            Clear
          </button>
        ) : null}
        {!c.reasons.some((r) => /in flight/.test(r)) ? (
          <button
            className="btn btn--sm"
            type="button"
            title="Queue this proposal now"
            onClick={() =>
              void onAct(() =>
                proposeWork(c.kind === 'wish' ? { wish: c.wish_file!, kind: 'wish' } : { subject: c.subject!, kind: c.kind }),
              )
            }
          >
            Propose
          </button>
        ) : null}
      </span>
    </div>
  );
}

function ProposalPanel({
  id,
  onAct,
  quota,
}: {
  id: string;
  onAct: (w: () => Promise<unknown>) => Promise<void>;
  quota: WorkshopView['quota'];
}) {
  const detail = useAsync<ProposalDetail>(() => getProposal(id), [id]);
  if (detail.error) return <Notice tone="warn" title="No such proposal">{detail.error.message}</Notice>;
  if (!detail.data) return <Loading what="the proposal" />;
  const { proposal: p, files, feedback } = detail.data;
  return (
    <section className="act-section">
      <h2 className="act-h">
        {KIND_WORD[p.kind]} {p.app} <span className="act-count">{STATE_WORD[p.state]}</span>
        <span className="act-h-action">
          <Link to="/workshop" className="btn btn--sm">
            Close
          </Link>
        </span>
      </h2>
      <div className="panel" style={{ padding: 14 }}>
        <p className="dim" style={{ marginTop: 0 }}>
          Round {p.round} of {p.max_rounds} · asked {since(p.asked_at)} by {p.by ?? 'the workshop'}
          {p.base_sha ? <> · built on <code>{p.base_sha.slice(0, 7)}</code></> : null}
          {p.pr ? (
            <>
              {' '}
              ·{' '}
              <a href={p.pr.url} target="_blank" rel="noreferrer">
                pull request #{p.pr.number}
              </a>
              {p.state === 'submitted' ? <MergeableChip pr={p.pr} /> : null}
            </>
          ) : null}
        </p>
        {p.reason ? <Notice tone="info" title="Why it is where it is">{p.reason}</Notice> : null}
        {p.state === 'ready' ? (
          <p>
            <button className="btn" type="button" disabled={!quota.allowed} onClick={() => void onAct(() => submitProposal(p.id))}>
              Open the pull request
            </button>{' '}
            <span className="dim">{quota.allowed ? '' : `The quota is spent; next slot ${until(quota.next_slot_at)}.`}</span>
          </p>
        ) : null}
        {p.summary ? (
          <>
            <h3 className="section-title">What the author says it changed</h3>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{p.summary}</pre>
          </>
        ) : null}
        {p.validation?.length ? (
          <>
            <h3 className="section-title">Validation</h3>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Section</th>
                    <th>Platform</th>
                    <th>Verdict</th>
                    <th>Trial</th>
                  </tr>
                </thead>
                <tbody>
                  {p.validation.map((r) => (
                    <tr key={r.section}>
                      <td>{r.section}</td>
                      <td className="dim">{r.target ?? 'any'}</td>
                      <td>{r.verdict ?? `${r.status}${r.blocked_reason ? ` (${r.blocked_reason.replace(/_/g, ' ')})` : ''}`}</td>
                      <td>{r.trial ? <Link to={`/trials/${encodeURIComponent(r.trial)}`}>{r.trial}</Link> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
        {p.trials.length > 0 && !p.validation?.length ? (
          <p className="dim">
            Trials:{' '}
            {p.trials.map((t) => (
              <span key={t.slug}>
                <Link to={`/trials/${encodeURIComponent(t.slug)}`}>
                  r{t.round} {t.target}
                </Link>{' '}
              </span>
            ))}
          </p>
        ) : null}
        {feedback ? (
          <details>
            <summary>Feedback from the last failing round</summary>
            <pre style={{ whiteSpace: 'pre-wrap' }}>{feedback}</pre>
          </details>
        ) : null}
        <h3 className="section-title">The change</h3>
        {files.length === 0 ? (
          <p className="dim">No change yet.</p>
        ) : (
          files.map((f) => (
            <details key={f.path} open={files.length <= 3}>
              <summary>
                <code>{f.path}</code> <span className="dim">{f.change} · {f.bytes} bytes</span>
              </summary>
              {f.before !== undefined || f.after !== undefined ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 8 }}>
                  {f.before !== undefined ? <pre className="dim" style={{ overflowX: 'auto' }}>{f.before}</pre> : null}
                  {f.after !== undefined ? <pre style={{ overflowX: 'auto' }}>{f.after}</pre> : null}
                </div>
              ) : (
                <p className="dim">Binary.</p>
              )}
            </details>
          ))
        )}
      </div>
    </section>
  );
}


/**
 * Whether GitHub would merge the open PR as it stands — GitHub's own `mergeable_state`, read
 * by the workshop's PR poll. Words, never colour alone; the title says what to do about it.
 */
const MERGEABLE: Record<PrMergeable, { word: string; tone: 'ok' | 'warn' | 'bad' | 'quiet'; why: string }> = {
  clean: { word: 'mergeable', tone: 'ok', why: 'No conflicts, and every required check and review is satisfied.' },
  unstable: { word: 'mergeable · checks failing', tone: 'warn', why: 'It would merge, but a non-required check is failing.' },
  behind: { word: 'behind base', tone: 'warn', why: 'The base branch has moved on; GitHub wants it brought up to date before merging.' },
  blocked: { word: 'blocked', tone: 'quiet', why: 'A required review or check has not passed yet.' },
  conflicts: { word: 'conflicts', tone: 'bad', why: 'It no longer merges cleanly into the base branch.' },
  unknown: { word: 'checking…', tone: 'quiet', why: 'GitHub has not finished working out whether it merges.' },
};

function MergeableChip({ pr }: { pr: ProposalPr }) {
  if (!pr.mergeable) return null;
  const m = MERGEABLE[pr.mergeable];
  return (
    <span
      className="tag merge-tag"
      data-tone={m.tone}
      title={`${m.why}${pr.mergeable_at ? ` Checked ${since(pr.mergeable_at)}.` : ''}`}
    >
      {m.word}
    </span>
  );
}
