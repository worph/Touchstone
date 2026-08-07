/**
 * MarkdownView — injects the server-rendered report HTML.
 *
 * The reports are almost entirely wide tables (phase tables, checklist tables),
 * so the rule that matters most here: **every table is wrapped in its own
 * `overflow-x: auto` box.** A report must never be able to widen the page and
 * push the findings list off-screen.
 *
 * The HTML is escaped and rendered by the API (MVP.md §6: "Markdown → HTML
 * rendering escapes HTML in source"), so this is an injection point that trusts
 * exactly one producer. It is not for user-authored content.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';

interface Props {
  html: string | null | undefined;
  raw?: string | null;
  /** `rendered` shows the HTML, `raw` shows the markdown source verbatim. */
  view?: 'rendered' | 'raw';
  /** Forwarded so the parent can scroll this container to a heading. */
  bodyRef?: React.RefObject<HTMLDivElement | null>;
  /** Rendered instead of the report when there is nothing to show. */
  emptyState?: React.ReactNode;
}

/** Words that appear as whole cells in the report tables and carry a verdict. */
const CELL_TONE: Record<string, string> = {
  FAIL: 'cell-fail',
  fail: 'cell-fail',
  UNVERIFIED: 'cell-unverified',
  unverified: 'cell-unverified',
  pass: 'cell-pass',
  PASS: 'cell-pass',
  blocked: 'cell-blocked',
  'n/a': 'cell-blocked',
};

export default function MarkdownView({ html, raw, view = 'rendered', bodyRef, emptyState }: Props) {
  const localRef = useRef<HTMLDivElement>(null);
  const hostRef = bodyRef ?? localRef;
  const mdRef = useRef<HTMLDivElement>(null);

  // Inject imperatively rather than via dangerouslySetInnerHTML: we mutate the
  // result immediately afterwards, and React must not think it owns that DOM.
  useLayoutEffect(() => {
    const el = mdRef.current;
    if (!el || view !== 'rendered') return;
    el.innerHTML = html ?? '';
    decorate(el);
  }, [html, view]);

  // Re-evaluate the "there is more table to the right" affordance on resize.
  useEffect(() => {
    const el = mdRef.current;
    if (!el || view !== 'rendered') return;
    const wraps = Array.from(el.querySelectorAll<HTMLElement>('.md-table-wrap'));
    const sync = () => wraps.forEach(markOverflow);
    sync();
    const ro = new ResizeObserver(sync);
    ro.observe(el);
    wraps.forEach((w) => w.addEventListener('scroll', () => markOverflow(w), { passive: true }));
    return () => ro.disconnect();
  }, [html, view]);

  const missing = view === 'rendered' ? !html?.trim() : !raw?.trim();
  if (missing) {
    return (
      <div ref={hostRef} className="pane-body">
        {emptyState ?? <DefaultEmpty />}
      </div>
    );
  }

  return (
    <div ref={hostRef} className="pane-body">
      {view === 'raw' ? (
        <pre className="md-raw">{raw}</pre>
      ) : (
        <div ref={mdRef} className="md" />
      )}
    </div>
  );
}

function DefaultEmpty() {
  return (
    <div className="empty">
      <div className="empty-glyph" aria-hidden="true">
        ▨
      </div>
      <div className="empty-title">No report body</div>
      <div className="empty-sub">
        This assay recorded frontmatter but no narrative. The findings are still authoritative.
      </div>
    </div>
  );
}

/** Post-processing of the injected HTML. Idempotent. */
function decorate(root: HTMLElement): void {
  // 1. every table gets its own horizontal scroll box
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('md-table-wrap')) continue;
    const wrap = document.createElement('div');
    wrap.className = 'md-table-wrap';
    wrap.setAttribute('tabindex', '0');
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'report table, scrolls horizontally');
    table.parentNode?.insertBefore(wrap, table);
    wrap.appendChild(table);
  }

  // 2. verdict words in table cells get the same three-channel treatment as
  //    StatusCell, so the report and the findings list never disagree visually
  for (const td of Array.from(root.querySelectorAll('td'))) {
    const tone = CELL_TONE[(td.textContent ?? '').trim()];
    if (tone) td.classList.add(tone);
  }

  // 3. external links open away from the app; internal anchors stay put
  for (const a of Array.from(root.querySelectorAll('a'))) {
    const href = a.getAttribute('href') ?? '';
    if (/^https?:\/\//i.test(href)) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
}

function markOverflow(wrap: HTMLElement): void {
  const over = wrap.scrollWidth > wrap.clientWidth + 1;
  wrap.dataset.overflowing = String(over);
  const atEnd = wrap.scrollLeft + wrap.clientWidth >= wrap.scrollWidth - 2;
  wrap.dataset.scrolled = atEnd ? 'end' : 'mid';
}

/** The "report file is gone" degraded state from UX.md §4. */
export function MissingReport({ path, onReassay }: { path: string; onReassay?: () => void }) {
  return (
    <div className="empty">
      <div className="empty-glyph" aria-hidden="true">
        ⌫
      </div>
      <div className="empty-title">Report file is missing</div>
      <div className="empty-sub">
        Nothing on disk at <code className="mono">{path}</code>. The findings above still render
        from the index, which is built from frontmatter — but the evidence for them is gone.
      </div>
      <button className="btn" type="button" disabled title="Re-assay lands in MVP-1" onClick={onReassay}>
        Re-assay this subject
      </button>
    </div>
  );
}
