/**
 * Settings — this instance, in one place: what the app owns and may write, above what it
 * booted on and only reads.
 *
 * Tabs since 2026-10-05: Assistant (the context), Automation (the loop's controls), Workshop
 * (the GitHub token and the PR quota) and config.yaml. They were two pages before that
 * (Settings and Configuration), and the controls lived in a block on Automation that made a
 * page about what the loop is doing into a page about how it is tuned.
 *
 * **The administrator context** — the standing instructions the model is handed before every
 * message. Prepended to the administrator's prompt rather than being part of it, and the
 * section has to be honest about the three things that are easy to assume from a text box:
 *
 * - **It takes effect on the next message**, not on the next conversation and not after a
 *   restart. The file is read per turn.
 * - **It is not a rule the app enforces.** Nothing here can record a verdict or widen what
 *   the chat's tools do — the tool registry is the whole of that, deliberately (invariant 6).
 * - **It costs room.** A turn carries the catalogue, the live status and the history in the
 *   same prompt, so the byte count is on screen rather than discovered at the limit.
 *
 * **The workshop's GitHub token** — write-only: the page says where the token in use came
 * from and whether it works, never what it is, and says *which kind* of token to make, because
 * GitHub offers two and the wrong one (classic) works while reaching every repository the
 * account can. It lives here rather than on Workshop so that page stays about operating.
 *
 * **`config.yaml`** — read-only, and not as a limitation: it is loaded once at boot and
 * handed to the services as values (the roots, the agent's address), so a save button would
 * change a file without changing what the app is doing until a restart — which is worse than
 * no button at all. What is shown is the **effective** config, the defaults with the file
 * merged over them. Values whose key looks like a credential arrive already masked — the
 * redaction is on the server, so the browser is never sent the secret in the first place.
 * The values something live *re-reads* are **controls**, changed on the Automation and Workshop
 * tabs; one changed there reads as its old value here until the next boot, and the control row
 * says which is in force because it is the only place that can.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';

import type { ControlRow, ControlsResponse } from '@shared/controls';
import type { ContextDoc } from '../data/client';
import {
  clearGitHubToken,
  getConfig,
  getContext,
  getControls,
  getGitHubToken,
  resetControl,
  saveContext,
  setControl,
  setGitHubToken,
} from '../data/client';
import { since } from '../lib/format';
import ControlList from '../components/ControlList';
import { ErrorState, Loading, Notice } from '../components/Ui';
import { useAsync } from '../hooks/useAsync';

const PLACEHOLDER = `Anything the administrator should know before it answers. For example:

This instance audits the Yundera store on holyhorse, which is a test box — nothing on it
is customer data. The scheduler is deliberately disarmed; n8n still drives the real loop.
When I ask about "the store" I mean Yundera/AppStore@main.`;

/**
 * One tab per thing an operator comes here to set. Each has its own address, so a page that
 * sends somebody here (Workshop's "set the token", Automation's "change the cadence") can land
 * them on the right one. The switches that *operate* — Start/Stop, Arm/Disarm — are not here:
 * they stay on the page whose state they change, beside the sentence saying what pressing does.
 */
const TABS = [
  { id: 'assistant', label: 'Assistant' },
  { id: 'automation', label: 'Automation' },
  { id: 'workshop', label: 'Workshop' },
  { id: 'config', label: 'config.yaml' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** Hashes that pointed at a section before the page had tabs. */
const LEGACY_HASH: Record<string, TabId> = { '#github': 'workshop', '#config': 'config' };

export default function Settings() {
  const { tab } = useParams();
  const { hash } = useLocation();
  const navigate = useNavigate();

  if (!tab && LEGACY_HASH[hash]) return <Navigate to={`/settings/${LEGACY_HASH[hash]}`} replace />;
  const current: TabId = TABS.find((t) => t.id === tab)?.id ?? 'assistant';
  if (tab && tab !== current) return <Navigate to="/settings" replace />;

  return (
    <div className="page page--wide">
      <div className="proto-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            className="proto-tab"
            aria-pressed={t.id === current}
            aria-selected={t.id === current}
            onClick={() => navigate(t.id === 'assistant' ? '/settings' : `/settings/${t.id}`)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {current === 'assistant' ? <ContextSection /> : null}
      {current === 'automation' ? (
        <ControlsSection
          // The loop's own switch is Start/Stop on Automation; everything else that tunes it is here.
          pick={(row) => !row.key.startsWith('workshop.') && row.key !== 'scheduler.armed'}
          intro={
            <>
              How the loop runs: its cadence, the runner, the bench guard. Starting and stopping it
              is on <Link to="/automation">Automation</Link>, beside what it is doing.
            </>
          }
        />
      ) : null}
      {current === 'workshop' ? (
        <>
          <GitHubSection />
          <ControlsSection
            // Arm/Disarm stays on Workshop, for the same reason Start/Stop stays on Automation.
            pick={(row) => row.key.startsWith('workshop.') && row.key !== 'workshop.armed'}
            intro={
              <>
                Arming the workshop is on <Link to="/workshop">Workshop</Link>.
              </>
            }
          />
        </>
      ) : null}
      {current === 'config' ? <ConfigSection /> : null}
    </div>
  );
}

/**
 * A slice of the controls — values something live re-reads, changed without a restart.
 * Every slice reads and writes the same `GET /controls`, so a tab is a filter and nothing more.
 */
function ControlsSection({ pick, intro }: { pick: (row: ControlRow) => boolean; intro: React.ReactNode }) {
  const [controls, setControls] = useState<ControlsResponse | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getControls().then(setControls, (err: unknown) => setError(err instanceof Error ? err : new Error(String(err))));
  }, []);

  const write = useCallback(async (run: () => Promise<ControlsResponse>) => {
    setBusy(true);
    try {
      setControls(await run());
    } finally {
      setBusy(false);
    }
  }, []);

  if (error && !controls) return <ErrorState error={error} what="the settings" />;
  if (!controls) return <Loading what="the settings" />;
  const rows = controls.controls.filter(pick);
  if (rows.length === 0) return null;

  return (
    <section className="act-section" style={{ marginTop: 22 }}>
      <p className="dim" style={{ margin: '0 2px 10px', fontSize: 12.5, lineHeight: 1.6 }}>{intro}</p>
      <ControlList
        rows={rows}
        busy={busy}
        onSet={async (key, value) => {
          await write(() => setControl(key, value));
        }}
        onReset={async (key) => {
          await write(() => resetControl(key));
        }}
      />
      <div className="auto-foot">
        These take effect without a restart. <code>config.yaml</code> stays the value a fresh
        install boots into; a change is kept in <code>{controls.file ?? 'state/controls.json'}</code>,
        and deleting that file puts every one of them back.
      </div>
    </section>
  );
}

function ContextSection() {
  const loaded = useAsync(() => getContext(), []);
  const [doc, setDoc] = useState<ContextDoc | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (!loaded.data) return;
    setDoc(loaded.data);
    setDraft(loaded.data.text);
  }, [loaded.data]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const next = await saveContext(draft);
      setDoc(next);
      setDraft(next.text);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }, [draft]);

  if (loaded.loading && !doc) return <Loading what="the context prompt" />;
  if (loaded.error && !doc) return <ErrorState error={loaded.error} what="the context prompt" />;

  const bytes = new TextEncoder().encode(draft).length;
  const max = doc?.max_bytes ?? 16_000;
  const dirty = doc !== null && draft !== doc.text;
  const tooBig = bytes > max;

  return (
    <>
      <div className="panel">
        <div className="pane-head">
          <span className="section-title">administrator context</span>
          {doc ? <span className="dim" style={{ fontSize: 11.5 }}>{doc.path}</span> : null}
          <div style={{ flex: 1 }} />
          <button
            className="btn"
            type="button"
            disabled={saving || !dirty}
            onClick={() => { setDraft(doc?.text ?? ''); setError(null); setSaved(false); }}
          >
            revert
          </button>
          <button
            className="btn"
            type="button"
            disabled={saving || !dirty || tooBig}
            title="The next message you send will be answered with this in front of it"
            onClick={() => void save()}
          >
            {saving ? 'saving…' : 'save'}
          </button>
        </div>

        <p className="dim" style={{ margin: '10px 2px 0', fontSize: 12.5, lineHeight: 1.6 }}>
          Loaded into the administrator's prompt before every message — this box, its stores,
          and how you want it worked. It is background, not authority: it cannot record a
          verdict and it cannot give the chat a tool it does not have.
        </p>

        <div className="subject-refs" style={{ marginTop: 10 }}>
          <div className="ref-line">
            <span className="tag" style={tooBig ? { color: 'var(--crit)', borderColor: 'var(--crit)' } : undefined}>
              {bytes.toLocaleString()} / {max.toLocaleString()} bytes
            </span>
            {doc?.modified_at ? (
              <span className="tag">saved {new Date(doc.modified_at).toLocaleString()}</span>
            ) : (
              <span className="tag">never saved</span>
            )}
            {dirty ? <span className="tag">unsaved</span> : null}
          </div>
        </div>

        {error ? <Notice tone="error" title="That did not save">{error}</Notice> : null}
        {tooBig ? (
          <Notice tone="warn" title="That is too long to send">
            A turn carries this, the tool catalogue, the live status and the conversation in
            one prompt. Above {max.toLocaleString()} bytes the context crowds out the thing it
            is meant to inform, so the server refuses it.
          </Notice>
        ) : null}
        {saved && !dirty && !error ? (
          <Notice tone="info" title="Saved">
            The next message you send is answered with this in front of it. Conversations
            already on screen pick it up too — it is read per turn, not per thread.
          </Notice>
        ) : null}
      </div>

      <section className="panel pane" style={{ marginTop: 14 }}>
        <textarea
          className="proto-editor proto-editor--short"
          value={draft}
          spellCheck={false}
          placeholder={PLACEHOLDER}
          onChange={(e) => { setDraft(e.target.value); setSaved(false); }}
          aria-label="administrator context prompt"
        />
      </section>

    </>
  );
}

/** What this process booted on — `config.yaml` merged over the defaults, masked, read-only. */
function ConfigSection() {
  const state = useAsync(() => getConfig(), []);
  const [copied, setCopied] = useState(false);

  if (state.loading) return <Loading what="the configuration" />;
  if (state.error) return <ErrorState error={state.error} what="the configuration" />;

  const json = state.data?.config ? `${JSON.stringify(state.data.config, null, 2)}\n` : '';

  return (
    <>
      <div className="panel" style={{ marginTop: 14 }}>
        <div className="pane-head">
          <span className="section-title">config.yaml</span>
          <span className="dim" style={{ fontSize: 11.5 }}>{state.data?.path ?? 'defaults only'}</span>
          <div style={{ flex: 1 }} />
          <button
            className="btn"
            type="button"
            disabled={!json}
            onClick={() => {
              void navigator.clipboard?.writeText(json).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>

        <p className="dim" style={{ margin: '10px 2px 0', fontSize: 12.5, lineHeight: 1.6 }}>
          Everything else about this instance. The defaults with <code>config.yaml</code> merged
          over them — what this process booted on, not what the file says on its own. Edit it on
          the volume; it is read at boot, so a change takes effect when Touchstone restarts.
          Credentials are masked before they leave the server. The values that can be changed{' '}
          <em>without</em> a restart — the cadence, the runner, the bench guard — are on the{' '}
          <Link to="/settings/automation">Automation</Link> and <Link to="/settings/workshop">Workshop</Link> tabs,
          and one changed there reads as its old value here until the next boot. The rubric is on{' '}
          <Link to="/protocol">Protocol</Link>.
        </p>

        <div className="subject-refs" style={{ marginTop: 10 }}>
          <div className="ref-line">
            {state.data?.loaded_at ? (
              <span className="tag">read {new Date(state.data.loaded_at).toLocaleString()}</span>
            ) : null}
            <span className="tag">read-only here</span>
          </div>
        </div>

        {state.data?.config ? null : (
          <Notice tone="warn" title="This instance did not hand the page a config">
            The API is running without one — in development, or behind an older server. There
            is nothing to show rather than nothing configured.
          </Notice>
        )}
      </div>

      {json ? (
        <section className="panel pane" style={{ marginTop: 14 }}>
          <pre className="json-view">{json}</pre>
        </section>
      ) : null}
    </>
  );
}

const TOKENS_URL = 'https://github.com/settings/tokens';
const NEW_FINE_GRAINED_URL = 'https://github.com/settings/personal-access-tokens/new';

/**
 * The workshop's GitHub token: what kind to make, exactly how to scope it, and the field to
 * paste it into. Write-only — the field never shows the token in use and is emptied on save.
 */
function GitHubSection() {
  const [nonce, setNonce] = useState(0);
  const state = useAsync(() => getGitHubToken(), [nonce]);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.loading && !state.data) return <Loading what="the GitHub token" />;
  if (state.error && !state.data) return <ErrorState error={state.error} what="the GitHub token" />;
  if (!state.data) return null;
  const { github, github_token: info } = state.data;

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      setNonce((n) => n + 1);
    }
  };
  const save = () =>
    void run(async () => {
      await setGitHubToken(token);
      setToken('');
    });

  const repo = info.repo ?? github.repo;
  const [owner, name] = repo ? repo.split('/') : [undefined, undefined];
  const source =
    info.source === 'page'
      ? `set here${info.set_at ? ` ${since(info.set_at)}` : ''}`
      : info.source === 'boot'
        ? 'from config.yaml / TOUCHSTONE_GITHUB_TOKEN'
        : 'no token';
  const status =
    github.state === 'ok'
      ? `works — as ${github.login}${github.label === false ? '; the "touchstone" label is missing' : ''}`
      : github.state === 'failing'
        ? `does not work — ${github.problems.join('; ')}`
        : github.state === 'unknown'
          ? 'not checked yet'
          : 'the workshop cannot open pull requests until one is set';

  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <div className="pane-head">
        <span className="section-title">workshop · GitHub token</span>
        <span className="dim" style={{ fontSize: 11.5 }}>{repo ?? 'no workshop origin'}</span>
      </div>

      <p className="dim" style={{ margin: '10px 2px 0', fontSize: 12.5, lineHeight: 1.6 }}>
        The account the workshop opens pull requests as. Make a <strong>fine-grained</strong> personal
        access token, <strong>not a classic one</strong>: a classic token works, but it reaches every
        repository the account can, while a fine-grained one reaches only {repo ? <code>{repo}</code> : 'the store'}.
        The pull requests carry that person's name, so use an account that may speak for it
        {info.expected_login ? <> — this instance expects <code>{info.expected_login}</code></> : null}.
      </p>

      <ol className="dim" style={{ margin: '10px 2px 0', paddingLeft: 20, fontSize: 12.5, lineHeight: 1.7 }}>
        <li>
          Open <a href={TOKENS_URL} target="_blank" rel="noreferrer">github.com/settings/tokens</a> →{' '}
          <em>Fine-grained tokens</em> → <em>Generate new token</em> (or go{' '}
          <a href={NEW_FINE_GRAINED_URL} target="_blank" rel="noreferrer">straight to the form</a>).
        </li>
        <li>
          <strong>Resource owner:</strong> {owner ? <code>{owner}</code> : 'the store’s organisation'} — the
          organisation, not your own account. A token owned by your account cannot open a pull request on
          another owner’s repository.
        </li>
        <li>
          <strong>Repository access:</strong> <em>Only select repositories</em> → {name ? <code>{name}</code> : 'the store repository'}.
        </li>
        <li>
          <strong>Repository permissions:</strong> <em>Contents</em> read and write (to push a{' '}
          <code>touchstone/…</code> branch), <em>Pull requests</em> read and write, <em>Metadata</em> read-only
          (GitHub adds it). Nothing else.
        </li>
        <li>
          <strong>Expiration</strong> is your call. When it lapses the status below turns failing and an alert
          opens; paste a new one here.
        </li>
        <li>
          If {owner ? <code>{owner}</code> : 'the organisation'} requires approval, an owner approves it under the
          organisation’s <em>Settings → Personal access tokens</em>; until then GitHub refuses it.
        </li>
      </ol>
      <p className="dim" style={{ margin: '8px 2px 0', fontSize: 12.5, lineHeight: 1.6 }}>
        Once, by hand: create a <code>touchstone</code> label on {repo ? <code>{repo}</code> : 'the repository'}.
        Without it pull requests still open, unlabelled — the token deliberately cannot create labels.
      </p>

      <div className="subject-refs" style={{ marginTop: 10 }}>
        <div className="ref-line">
          <span className="tag">{source}</span>
          <span className="tag" style={github.state === 'failing' ? { color: 'var(--crit)', borderColor: 'var(--crit)' } : undefined}>
            {status}
          </span>
        </div>
      </div>

      {info.settable ? (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 12 }}>
          <input
            className="control"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && token.trim() && !busy) save();
            }}
            placeholder={info.source ? 'paste a new token to replace it' : 'github_pat_…'}
            aria-label="GitHub token"
            style={{ flex: '1 1 16rem', minWidth: 0 }}
          />
          <button className="btn" type="button" disabled={busy || !token.trim()} onClick={save}>
            {busy ? 'checking…' : info.source ? 'replace' : 'save'}
          </button>
          {info.source === 'page' ? (
            <button
              className="btn"
              type="button"
              disabled={busy}
              title={info.boot_token ? 'Falls back to the token from config.yaml / the environment' : 'The workshop will have no token'}
              onClick={() => {
                if (window.confirm(info.boot_token ? 'Clear this token and fall back to the one from config.yaml / the environment?' : 'Clear this token? The workshop will have none.')) {
                  void run(() => clearGitHubToken());
                }
              }}
            >
              clear
            </button>
          ) : null}
        </div>
      ) : (
        <Notice tone="warn" title="This instance cannot keep a token">
          The API has no data directory to write it to; set <code>TOUCHSTONE_GITHUB_TOKEN</code> instead.
        </Notice>
      )}
      <p className="dim" style={{ margin: '8px 2px 0', fontSize: 12 }}>
        Kept in <code>data/github-token</code> and never shown again. It takes effect at once and outranks{' '}
        <code>github.token</code> / <code>TOUCHSTONE_GITHUB_TOKEN</code>; clear falls back to them. Whether the
        workshop then does anything on its own is <Link to="/workshop">Workshop</Link>’s switch.
      </p>

      {error ? <Notice tone="error" title="That did not save">{error}</Notice> : null}
    </div>
  );
}
