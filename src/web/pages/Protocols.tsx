/**
 * The protocol — read it, and change it.
 *
 * The standard every verdict is measured against used to live in a wiki this app only held a
 * slug for. You could not see it here, you could not change it here, and the plan to stop
 * using that wiki would have stranded it. It is a local markdown file now, and this is the
 * screen that edits it.
 *
 * Two things the screen has to be honest about, because they are easy to get wrong from a
 * text box:
 *
 * - **Saving bumps the version.** Every assay records the standard and version it was graded
 *   against, so an edit that left the number alone would make two different rubrics
 *   indistinguishable in the archive. The button says so.
 * - **It takes effect on the next audit, not this one.** The runner reads the files per run.
 */

import { useCallback, useEffect, useState } from 'react';

import type { ProtocolDoc, ProtocolSummary } from '../data/client';
import { getProtocol, getProtocols, saveProtocol } from '../data/client';
import { EmptyState, Loading, Notice } from '../components/Ui';
import MarkdownView from '../components/MarkdownView';
import { useAsync } from '../hooks/useAsync';

export default function Protocols() {
  // `nonce` re-lists after a save, so the version in the tab strip matches the file.
  const [nonce, setNonce] = useState(0);
  const list = useAsync(() => getProtocols(), [nonce]);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<ProtocolDoc | null>(null);
  const [draft, setDraft] = useState<string>('');
  const [mode, setMode] = useState<'read' | 'edit'>('read');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const protocols = list.data?.protocols ?? [];
  const current = selected ?? protocols[0]?.id ?? null;

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
      const d = await saveProtocol(current, draft);
      setDoc(d);
      setDraft(d.body);
      setMode('read');
      setSaved(`saved as v${d.meta.version}`);
      setNonce((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }, [current, draft]);

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
              <button className="btn" type="button" disabled={saving} onClick={() => { setDraft(doc?.body ?? ''); setMode('read'); }}>
                cancel
              </button>
              <button
                className="btn"
                type="button"
                disabled={saving || !dirty}
                title="Saving bumps the version, because every assay records the version it was graded against"
                onClick={() => void save()}
              >
                {saving ? 'saving…' : `save as v${(doc?.meta.version ?? 0) + 1}`}
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
              onClick={() => { setSelected(p.id); setSaved(null); }}
            >
              {p.name}
              <span className="dim"> v{p.version}</span>
              {p.kind === 'orchestrator' ? <span className="tag">composes</span> : null}
              {p.requires?.includes('bench') ? <span className="tag">needs a bench</span> : null}
            </button>
          ))}
        </div>

        {error ? <Notice tone="error" title="That did not work">{error}</Notice> : null}
        {saved && !error ? <Notice tone="info" title={saved}>The next audit will use it. Assays already in the archive keep the version they were graded against.</Notice> : null}

        {doc ? <ProtocolMeta meta={doc.meta} file={doc.file} bytes={doc.bytes} /> : null}
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
    </div>
  );
}

function ProtocolMeta({ meta, file, bytes }: { meta: ProtocolSummary; file: string; bytes: number }) {
  return (
    <div className="subject-refs">
      <div className="ref-line">{file}</div>
      <div className="ref-line">
        <span className="tag">v{meta.version}</span>
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
