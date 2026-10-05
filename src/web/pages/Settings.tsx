/**
 * Settings — this instance, in one place: what the app owns and may write, above what it
 * booted on and only reads.
 *
 * Two kinds of thing, and the page keeps them visibly apart rather than on two pages. They
 * were two pages until 2026-10-05 (Settings and Configuration), and an operator looking for
 * "the settings" found the half they were not looking for.
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
 * **`config.yaml`** — read-only, and not as a limitation: it is loaded once at boot and
 * handed to the services as values (the roots, the agent's address), so a save button would
 * change a file without changing what the app is doing until a restart — which is worse than
 * no button at all. What is shown is the **effective** config, the defaults with the file
 * merged over them. Values whose key looks like a credential arrive already masked — the
 * redaction is on the server, so the browser is never sent the secret in the first place.
 * The values something live *re-reads* are **controls**, changed on Automation; one changed
 * there reads as its old value here until the next boot, and the Automation row says which
 * is in force because it is the only place that can.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { ContextDoc } from '../data/client';
import { getConfig, getContext, saveContext } from '../data/client';
import { ErrorState, Loading, Notice } from '../components/Ui';
import { useAsync } from '../hooks/useAsync';

const PLACEHOLDER = `Anything the administrator should know before it answers. For example:

This instance audits the Yundera store on holyhorse, which is a test box — nothing on it
is customer data. The scheduler is deliberately disarmed; n8n still drives the real loop.
When I ask about "the store" I mean Yundera/AppStore@main.`;

export default function Settings() {
  return (
    <div className="page page--wide">
      <ContextSection />
      <ConfigSection />
    </div>
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
      <div className="panel" id="config" style={{ marginTop: 22 }}>
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
          <em>without</em> a restart — the cadence, the switches, the bench guard — are on{' '}
          <Link to="/automation">Automation</Link>, and one changed there reads as its old value
          here until the next boot. The workshop's GitHub token is set on{' '}
          <Link to="/workshop">Workshop</Link>; the rubric is on <Link to="/protocol">Protocol</Link>.
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
