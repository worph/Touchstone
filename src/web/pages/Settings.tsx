/**
 * Settings — the administrator's context prompt.
 *
 * The standing instructions the model is handed before every message: which box this is,
 * which apps matter here, what the operator wants left alone. It is prepended to the
 * administrator's prompt rather than being part of it, and this page has to be honest about
 * the three things that are easy to assume from a text box:
 *
 * - **It takes effect on the next message**, not on the next conversation and not after a
 *   restart. The file is read per turn.
 * - **It is not a rule the app enforces.** Nothing here can record a verdict or widen what
 *   the chat's tools do — the tool registry is the whole of that, deliberately (invariant 6).
 * - **It costs room.** A turn carries the catalogue, the live status and the history in the
 *   same prompt, so the byte count is on screen rather than discovered at the limit.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import type { ContextDoc } from '../data/client';
import { getContext, saveContext } from '../data/client';
import { ErrorState, Loading, Notice } from '../components/Ui';
import { useAsync } from '../hooks/useAsync';

const PLACEHOLDER = `Anything the administrator should know before it answers. For example:

This instance audits the Yundera store on holyhorse, which is a test box — nothing on it
is customer data. The scheduler is deliberately disarmed; n8n still drives the real loop.
When I ask about "the store" I mean Yundera/AppStore@main.`;

export default function Settings() {
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

  if (loaded.loading && !doc) return <div className="page"><Loading what="the context prompt" /></div>;
  if (loaded.error && !doc) return <ErrorState error={loaded.error} what="the context prompt" />;

  const bytes = new TextEncoder().encode(draft).length;
  const max = doc?.max_bytes ?? 16_000;
  const dirty = doc !== null && draft !== doc.text;
  const tooBig = bytes > max;

  return (
    <div className="page page--wide">
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

      <p className="dim" style={{ margin: '12px 2px 0', fontSize: 12.5 }}>
        The rest of this instance's settings are in <code>config.yaml</code> on the volume,
        and are read at boot — <Link to="/config">see what it is running on</Link>.
      </p>
    </div>
  );
}
