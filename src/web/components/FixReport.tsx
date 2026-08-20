/**
 * "Fix report" — the audit, turned round to face the dev team.
 *
 * A verdict tells someone their app fails. This tells them what to change, in a form they can
 * paste straight into whatever assistant they use: the findings worst-first, the audit's own
 * evidence quoted verbatim, the remedy it proposed where it proposed one, and the requirement
 * ids that must flip to `pass` as the acceptance criteria.
 *
 * The document is composed on the server (`domain/fixreport.ts`) and fetched, not built here.
 * Two copies of a document are two documents, and the one someone pastes has to be the one the
 * `fix.md` endpoint serves to a script.
 *
 * It is shown as raw markdown rather than rendered, deliberately: the point of the panel is to
 * take the text away, and rendered markdown is markdown you cannot copy correctly.
 *
 * The button and the panel are separate exports because they sit in different places — the
 * button belongs beside `re-assay` in the subject header, the panel needs the full width of
 * the page — and one component cannot be in two parents.
 */

import { useCallback, useEffect, useState } from 'react';

import { getFixReport } from '../data/client';

export function FixReportButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button className="btn" type="button" onClick={onToggle} aria-expanded={open}>
      fix report
    </button>
  );
}

type CopyState = 'idle' | 'copied' | 'failed';

export default function FixReportPanel({ subject, onClose }: { subject: string; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<CopyState>('idle');

  useEffect(() => {
    let live = true;
    setText(null);
    setError(null);
    getFixReport(subject)
      .then((body) => live && setText(body))
      .catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [subject]);

  const copy = useCallback(async () => {
    if (!text) return;
    try {
      // `navigator.clipboard` needs a secure context — https, or localhost. On a plain-http
      // LAN address it is simply absent, so say so rather than appearing to do nothing.
      if (!navigator.clipboard) throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      setCopied('copied');
    } catch {
      setCopied('failed');
    }
    setTimeout(() => setCopied('idle'), 2500);
  }, [text]);

  const download = useCallback(() => {
    if (!text) return;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${subject}-fix.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }, [text, subject]);

  return (
    <section className="panel pane" style={{ marginTop: 14 }}>
      <div className="pane-head">
        <span className="section-title">fix report</span>
        <span className="dim" style={{ fontSize: 11.5 }}>
          markdown · written to be handed to a developer or a model
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn" type="button" onClick={() => void copy()} disabled={!text}>
          {copied === 'copied' ? 'copied ✓' : copied === 'failed' ? 'needs https' : 'copy'}
        </button>
        <button className="btn" type="button" onClick={download} disabled={!text}>
          download
        </button>
        <button className="btn" type="button" onClick={onClose}>
          close
        </button>
      </div>

      <div className="pane-body">
        {error ? (
          <p className="notice notice--error">{error}</p>
        ) : !text ? (
          <p className="dim">Composing…</p>
        ) : (
          <>
            <p className="fixrep-note">
              Composed from what the audit recorded — nothing is re-derived, and where the audit
              proposed no remedy this says so rather than inventing one. The same document is at{' '}
              <code className="mono">/api/v1/subjects/{encodeURIComponent(subject)}/fix.md</code> for
              a script or a CI job.
            </p>
            <pre className="fixrep-body">{text}</pre>
          </>
        )}
      </div>
    </section>
  );
}
