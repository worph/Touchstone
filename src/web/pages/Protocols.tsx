/**
 * The protocol — read it, change it, and see what it used to say.
 *
 * The standard every verdict is measured against used to live in a wiki this app only held a
 * slug for. You could not see it here, you could not change it here, and the plan to stop
 * using that wiki would have stranded it. It is a local markdown file now, and this is the
 * screen that edits it.
 *
 * Three things the screen has to be honest about, because they are easy to get wrong from a
 * text box:
 *
 * - **A protocol is identified by its bytes.** Not by a version number it carries — that
 *   number moved whether or not the content changed, never noticed an edit made over SSH, and
 *   pointed at text that no longer existed. The tab strip shows a hash, and the history below
 *   is where that hash resolves.
 * - **Saving needs a reason.** The diff says what changed; only the person saving can say why,
 *   and that is the one thing nobody can reconstruct afterwards.
 * - **It takes effect on the next audit, not this one.** The runner reads the files per run.
 */

import { shortSha, type Revision } from '@shared/standard';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import type { ProtocolDoc, ProtocolSummary } from '../data/client';
import { getProtocol, getProtocols, saveProtocol } from '../data/client';
import { EmptyState, Loading, Notice } from '../components/Ui';
import MarkdownView from '../components/MarkdownView';
import ProtocolHistory from '../components/ProtocolHistory';
import { useAsync } from '../hooks/useAsync';

export default function Protocols() {
  // `nonce` re-lists after a save, so the hash in the tab strip matches the file.
  const [nonce, setNonce] = useState(0);
  const list = useAsync(() => getProtocols(), [nonce]);
  // A report links here with the revision that judged it — `?p=static&rev=<sha>` — so the
  // recorded identity is something you can follow rather than merely quote.
  const [params, setParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<ProtocolDoc | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [message, setMessage] = useState<string>('');
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const protocols = list.data?.protocols ?? [];
  const linked = params.get('p');
  const current = selected ?? (linked && protocols.some((p) => p.id === linked) ? linked : null) ?? protocols[0]?.id ?? null;

  const load = useCallback(async (id: string) => {
    setError(null);
    try {
      const d = await getProtocol(id);
      setDoc(d);
      setDraft(d.body);
      setMode('read');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read that protocol.');
    }
  }, []);

  useEffect(() => {
    if (current) void load(current);
  }, [current, load]);

  const save = useCallback(async () => {
    if (!current) return;
    setSaving(true);
    setError(null);
    try {
      const d = await saveProtocol(current, draft, message);
      setDoc(d);
      setDraft(d.body);
      setMessage('');
      setMode('read');
      // No revision means the bytes were identical and nothing was written — worth saying, or
      // the absence of a new row in the history below looks like the history is broken.
      setSaved(d.revision ? `saved as @${shortSha(d.revision.sha256)}` : 'no change to save');
      setNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }, [current, draft, message]);

  if (list.loading) return <div className="page"><Loading what="the protocol" /></div>;
  if (list.error) {
    return (
      <div className="page">
        <Notice tone="error" title="Could not list the protocols">{list.error.message}</Notice>
      </div>
    );
  }

  if (protocols.length === 0) {
    return (
      <div className="page">
        <div className="panel">
          <EmptyState
            glyph="📄"
            title="There is no protocol on disk"
            sub={`Drop a markdown file into ${list.data?.directory ?? 'data/protocols'}. Without one, an audit has no rubric of its own and falls back to whatever the agent already knows.`}
          />
        </div>
      </div>
    );
  }

  const dirty = doc !== null && draft !== doc.body;

  return (
    <div className="page page--wide">
      <div className="panel">
        <div className="pane-head">
          <span className="section-title">protocol</span>
          <span className="dim" style={{ fontSize: 11.5 }}>{list.data?.directory}</span>
          <div style={{ flex: 1 }} />
          {mode === 'read' ? (
            <button className="btn" type="button" onClick={() => setMode('edit')}>edit</button>
          ) : (
            <>
              <input
                className="control proto-why"
                value={message}
                maxLength={200}
                placeholder="why this change"
                aria-label="why this change"
                onChange={(e) => setMessage(e.target.value)}
              />
              <button className="btn" type="button" disabled={saving} onClick={() => { setDraft(doc?.body ?? ''); setMessage(''); setMode('read'); }}>
                cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={saving || !dirty || message.trim() === ''}
                title="Saving records a new revision. Every assay records the revision that judged it, and the reason is the only part a diff cannot recover."
                onClick={() => void save()}
              >
                {saving ? 'saving…' : 'save'}
              </button>
            </>
          )}
        </div>

        <div className="proto-tabs">
          {protocols.map((p) => (
            <button
              key={p.id}
              type="button"
              className="proto-tab"
              aria-pressed={p.id === current}
              onClick={() => { setSelected(p.id); setSaved(null); setParams({}, { replace: true }); }}
            >
              {p.name}
              <span className="dim mono"> @{shortSha(p.sha256)}</span>
              {p.kind === 'orchestrator' ? <span className="tag">composes</span> : null}
              {p.requires?.includes('bench') ? <span className="tag">needs a bench</span> : null}
            </button>
          ))}
        </div>

        {error ? <Notice tone="error" title="That did not work">{error}</Notice> : null}
        {saved && !error ? <Notice tone="info" title={saved}>The next audit will use it. Assays already in the archive keep the revision they were graded against, and it is still readable below.</Notice> : null}
        {list.data?.history_failed ? (
          <Notice tone="warn" title="The protocol history is not being recorded">
            {list.data.history_failed}. The rubric itself is unaffected — audits still run and
            still record which revision judged them; there is just nowhere to read it back.
          </Notice>
        ) : null}

        {doc ? <ProtocolMeta meta={doc.meta} file={doc.file} sha256={doc.sha256} bytes={doc.bytes} revision={doc.revision} /> : null}
      </div>

      <section className="panel pane" style={{ marginTop: 14 }}>
        {mode === 'edit' ? (
          <textarea
            className="proto-editor"
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="protocol source"
          />
        ) : doc ? (
          <MarkdownView html={doc.html} />
        ) : (
          <Loading what="the protocol" />
        )}
      </section>

      {current && mode === 'read' ? (
        <ProtocolHistory
          id={current}
          nonce={nonce}
          openSha={params.get('rev')}
          onLoadIntoEditor={(text) => {
            // Restoring is forward-only: an old revision becomes a draft, and saving it is an
            // ordinary edit with its own reason. There is no rewind — see `routes/protocols.ts`.
            setDraft(text);
            setMode('edit');
            setMessage('');
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
        />
      ) : null}
    </div>
  );
}

function ProtocolMeta({
  meta,
  file,
  sha256,
  bytes,
  revision,
}: {
  meta: ProtocolSummary;
  file: string;
  sha256: string;
  bytes: number;
  revision: Revision | null;
}) {
  return (
    <div className="subject-refs">
      <div className="ref-line">{file}</div>
      <div className="ref-line">
        <span className="tag mono" title={sha256}>@{shortSha(sha256)}</span>
        {/* The ordinal is the log's, not the file's — it says where this sits in this box's
            history, and it is deliberately not something the protocol carries. */}
        {revision ? <span className="tag">revision {revision.seq}</span> : null}
        {meta.kind === 'leaf' ? <span className="tag">section {meta.id}</span> : null}
        {meta.requires?.length ? <span className="tag">needs {meta.requires.join(' + ')}</span> : null}
        {meta.phases?.length ? <span className="tag">{meta.phases.length} phases</span> : null}
        <span className="tag">{(bytes / 1024).toFixed(1)} KB</span>
        {/* Provenance. Nothing reads it — it records that this text was a wiki page once. */}
        {meta.imported_from ? <span className="tag">from {meta.imported_from}</span> : null}
      </div>
    </div>
  );
}
