/**
 * What this protocol used to say, and when it stopped saying it.
 *
 * One row per recorded revision of the section's rubric *and* of the script it names, because
 * those two are edited for the same reasons and an operator asking "what changed about the
 * currency check" means both. Expanding a row fetches the diff against its parent.
 *
 * The row's source is the part worth reading carefully:
 *
 * - **saved** came through this page and carries a reason.
 * - **changed on disk** is an edit the sweep found on the volume. There is no reason recorded
 *   and there never can be, which is the honest thing to show rather than a blank.
 * - **first seen** is the file's first sighting — a fresh install, or the boot that introduced
 *   the history to a directory that already had protocols in it.
 *
 * Built on Activity's log idiom (`.log`, `.log-time`, `.log-toggle`, `.log-detail`) with its
 * own grid, because the columns differ: this one has a hash and a size delta where that one
 * has a category.
 */

import { shortSha, type Revision } from '@shared/standard';
import type { Diff } from '@shared/linediff';
import { useCallback, useEffect, useState } from 'react';

import { getProtocolDiff, getProtocolRevision, getProtocolRevisions } from '../data/client';
import { Loading, Notice } from './Ui';
import { useAsync } from '../hooks/useAsync';
import { stamp } from '../lib/format';

const SOURCE: Record<Revision['source'], { glyph: string; label: string; unsaid: string }> = {
  save: { glyph: '✎', label: 'saved', unsaid: 'saved, no reason recorded' },
  observed: {
    glyph: '⌁',
    label: 'changed on disk',
    // The one row that is missing something. A file edited on the volume can never carry a
    // reason, and saying so is the point of the contrast with a save.
    unsaid: 'changed on disk, no reason recorded',
  },
  // Not missing anything: a first sighting was nobody's edit, so there is no why to withhold.
  seed: { glyph: '·', label: 'first seen', unsaid: 'first seen — the state it was already in' },
};

export default function ProtocolHistory({
  id,
  nonce,
  openSha,
  onLoadIntoEditor,
}: {
  id: string;
  /** Bumped by the page after a save, so the list re-reads. */
  nonce: number;
  /** A revision to expand on arrival — how a report's `@hash` link lands on its own text. */
  openSha: string | null;
  onLoadIntoEditor: (text: string) => void;
}) {
  const history = useAsync(() => getProtocolRevisions(id), [id, nonce]);
  const revisions = history.data?.revisions ?? [];

  if (history.loading) return <section className="panel pane" style={{ marginTop: 14 }}><Loading what="the history" /></section>;

  return (
    <section className="panel pane" style={{ marginTop: 14 }}>
      <div className="pane-head">
        <span className="section-title">history</span>
        <span className="dim" style={{ fontSize: 11.5 }}>
          {history.data?.files.join(' · ')}
        </span>
      </div>

      {history.error ? (
        <Notice tone="warn" title="Could not read the history">{history.error.message}</Notice>
      ) : revisions.length === 0 ? (
        <Notice tone="info" title="Nothing recorded yet">
          The history starts at the first boot after it was added, so a protocol that has not
          changed since then has one entry and no more. Nothing before that was kept — there
          was nowhere to keep it.
        </Notice>
      ) : (
        <div className="log">
          {revisions.map((rev) => (
            <RevisionRow
              key={rev.sha256 + rev.seq}
              id={id}
              rev={rev}
              multiFile={(history.data?.files.length ?? 1) > 1}
              startOpen={!!openSha && rev.sha256.startsWith(openSha)}
              onLoadIntoEditor={onLoadIntoEditor}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function RevisionRow({
  id,
  rev,
  multiFile,
  startOpen,
  onLoadIntoEditor,
}: {
  id: string;
  rev: Revision;
  multiFile: boolean;
  startOpen: boolean;
  onLoadIntoEditor: (text: string) => void;
}) {
  const [open, setOpen] = useState(startOpen);
  const source = SOURCE[rev.source];

  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);

  return (
    <div className="log-row rev-row" data-source={rev.source} data-open={open || undefined}>
      <time className="log-time" dateTime={rev.at} title={stamp(rev.at)}>
        {rev.at.slice(0, 10)}
      </time>
      <span className="log-glyph" aria-hidden="true">{source.glyph}</span>
      <span className="log-message">
        {multiFile ? <span className="rev-file mono">{rev.file}</span> : null}
        {rev.message ?? <span className="dim">{source.unsaid}</span>}
      </span>
      <span className="log-code mono" title={rev.sha256}>@{shortSha(rev.sha256)}</span>
      <button
        type="button"
        className="log-toggle"
        aria-expanded={open}
        aria-label={open ? 'Hide what changed' : 'Show what changed'}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? '▾' : '▸'}
      </button>
      {open ? <RevisionDetail id={id} rev={rev} onLoadIntoEditor={onLoadIntoEditor} /> : null}
    </div>
  );
}

function RevisionDetail({
  id,
  rev,
  onLoadIntoEditor,
}: {
  id: string;
  rev: Revision;
  onLoadIntoEditor: (text: string) => void;
}) {
  const diff = useAsync(() => getProtocolDiff(id, rev), [id, rev.sha256, rev.seq]);
  const [loading, setLoading] = useState(false);

  const restore = useCallback(async () => {
    setLoading(true);
    try {
      const got = await getProtocolRevision(id, rev.sha256);
      // The snapshot is the whole file; the editor edits the prose. `body` is null only when
      // the bytes are gone, in which case there is nothing to load.
      if (got.body !== null) onLoadIntoEditor(stripFrontmatter(got.body));
    } finally {
      setLoading(false);
    }
  }, [id, rev.sha256, onLoadIntoEditor]);

  return (
    <div className="rev-detail">
      <div className="rev-detail-head">
        <span className="dim">
          {SOURCE[rev.source].label}
          {rev.parent ? ` · replaced @${shortSha(rev.parent)}` : ' · first revision of this file'}
          {` · ${(rev.bytes / 1024).toFixed(1)} KB`}
        </span>
        <div style={{ flex: 1 }} />
        {rev.file.endsWith('.md') ? (
          <button
            className="btn btn--sm"
            type="button"
            disabled={loading}
            title="Load this text into the editor. Saving it is an ordinary edit with its own reason — nothing is rewound."
            onClick={() => void restore()}
          >
            {loading ? 'loading…' : 'open in editor'}
          </button>
        ) : null}
      </div>
      {diff.loading ? (
        <Loading what="the diff" />
      ) : diff.error ? (
        <Notice tone="warn" title="Could not read what changed">{diff.error.message}</Notice>
      ) : diff.data ? (
        <DiffView diff={diff.data.diff} />
      ) : null}
    </div>
  );
}

function DiffView({ diff }: { diff: Diff }) {
  if (diff.hunks.length === 0) {
    return <p className="dim" style={{ margin: '6px 0 0' }}>No textual change.</p>;
  }
  return (
    <>
      <p className="dim rev-tally">
        +{diff.added} −{diff.removed}
        {diff.coarse ? ' · too large to align line by line, shown as a wholesale replacement' : ''}
      </p>
      <div className="diff">
        {diff.hunks.map((h, i) => (
          <div className="diff-hunk" key={`${h.old_start}-${h.new_start}-${i}`}>
            <div className="diff-head">
              @@ −{h.old_start},{h.old_lines} +{h.new_start},{h.new_lines} @@
            </div>
            {h.lines.map((l, j) => (
              <div className="diff-line" data-op={l.op} key={j}>
                {/* The glyph, not only the colour: severity and state are never carried by
                    colour alone anywhere in this app (styles/base.css). */}
                <span className="diff-gutter" aria-hidden="true">
                  {l.op === 'add' ? '+' : l.op === 'remove' ? '−' : ' '}
                </span>
                <span className="diff-text">{l.text === '' ? ' ' : l.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/** A snapshot is the whole file; the editor holds the prose. */
function stripFrontmatter(raw: string): string {
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  return (m ? raw.slice(m[0].length) : raw).trim();
}
