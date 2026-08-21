/**
 * What the audit is actually looking at.
 *
 * The rest of the run card says what the agent has *decided* — requirements settled, phases
 * passed. This says what it is *doing*, which is the half hour a functional audit spends
 * inside a browser, and the difference between "installing, slowly" and "stuck on a login
 * page" is invisible from a progress counter.
 *
 * Two things it must not do:
 *
 * - **Not claim to be live when it is a still.** The per-tab screencast arrived in browser-mcp
 *   1.1.6; on an older sidecar this polls a PNG of the whole *screen* instead — which takes ~11 s
 *   and may not even be showing this audit's tab. The caption says both, because a frozen image
 *   labelled "live" is worse than an honest one labelled "every 15s, and maybe not your tab".
 * - **Not go quiet when the sidecar is down.** An unreachable browser is a legitimate state —
 *   invariant 7 — so it renders as a sentence about the browser, never as an empty box.
 */

import { useEffect, useState } from 'react';

import { browserStillUrl, getBrowserPages, type BrowserPages } from '../data/client';

/**
 * How often the still refreshes.
 *
 * Not a preference: `/api/screenshot` took 11 s on an idle sidecar, so anything faster stacks
 * requests on the browser that is trying to run the audit. The per-tab screencast (browser-mcp
 * 1.1.6+) is the real answer; this is the honest fallback.
 */
const STILL_MS = 15000;
/** The tab list changes when the agent opens or closes a page, which is rare. */
const PAGES_MS = 6000;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function BrowserView({ benchHost }: { benchHost?: string | null }) {
  const [data, setData] = useState<BrowserPages | null>(null);
  const [nonce, setNonce] = useState(() => Date.now());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const tick = () => {
      void getBrowserPages()
        .then((d) => alive && setData(d))
        .catch(() => alive && setData(null));
    };
    tick();
    const t = setInterval(tick, PAGES_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Only while the panel is open: an invisible panel polling a screenshot is a browser doing
  // work nobody asked for, on the box that is trying to run an audit.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => setNonce(Date.now()), STILL_MS);
    return () => clearInterval(t);
  }, [open]);

  if (!data) return null;

  const page = data.pages[0] ?? null;

  return (
    <div className="bview">
      <button
        className="bview-toggle"
        onClick={() => {
          setOpen((v) => !v);
          setNonce(Date.now());
        }}
        aria-expanded={open}
      >
        {open ? '▾' : '▸'} What it is looking at
      </button>

      {data.unreachable ? (
        <div className="bview-note">
          The browser is not answering — <code>{data.unreachable}</code>. Sections that need it
          are recorded blocked, which is a statement about the environment and not about the app.
        </div>
      ) : (
        <>
          <div className="bview-meta">
            {page ? (
              <>
                <span className="bview-title">{page.title || 'untitled'}</span>
                <span className="dim"> · {hostOf(page.url)}</span>
              </>
            ) : (
              <span className="dim">no tab open</span>
            )}
            {/* Said plainly: whether this is the audit's own context or every tab on the box. */}
            {data.filtered ? null : (
              <span className="dim"> · all tabs, not this audit's</span>
            )}
          </div>

          {open ? (
            <>
              <img
                className="bview-still"
                src={browserStillUrl(nonce)}
                alt="the screen of the browser the audit is driving"
              />
              <div className="bview-note">
                The browser's screen, refreshed every {Math.round(STILL_MS / 1000)}s — not a
                video, and not necessarily this audit's tab.{' '}
                <a href={data.vnc_url} target="_blank" rel="noreferrer">
                  Open the full console ↗
                </a>{' '}
                for what lives outside the page: downloads, dialogs, a crashed tab.
              </div>
            </>
          ) : null}
        </>
      )}

      {benchHost ? (
        <div className="bview-note">
          Installing on{' '}
          <a href={benchHost} target="_blank" rel="noreferrer">
            {hostOf(benchHost)} ↗
          </a>
        </div>
      ) : null}
    </div>
  );
}
