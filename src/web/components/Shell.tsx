import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { getAlerts, getEvents } from '../data/client';
import Mark from './Mark';
import { seenSeq } from '../lib/badge';
import { useRunStatus } from '../data/runStatus';
import RunningStrip, { RunTitle } from './RunningStrip';

const BADGE_MS = 30_000;

/**
 * The destinations. The administrator is not among them: it is the front page now, so the
 * brand — the one piece of chrome on every screen, sidebar and phone header alike — is the
 * link back to it, and a nav row pointing at `/` would be a second door to the same room.
 * The badge on Activity counts open alerts and unread error rows — nothing else, deliberately.
 *
 * Grouped in the sidebar the way the app divides: the standard and what it is measured
 * against on top, what the machine is doing under that, and what this particular instance is
 * set up as at the bottom. The phone gets the same list as tabs, minus the ones marked
 * `tab: false` — the tab bar is a hand's width and Configuration is a page you read once,
 * reached from Settings, rather than one you switch to.
 */
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Conformance',
    items: [
      // Every app the store tracks, what it currently carries, and the button that starts
      // an audit of one. The Overview it replaced drew only the apps already in the archive.
      { to: '/store', label: 'Store' },
      // The rubric every verdict is measured against. It used to live in a wiki this
      // app only held a slug for; it is a local file now, and editable.
      { to: '/protocol', label: 'Protocol' },
      // Auditing a ref before it is merged. Under Conformance rather than Operations because
      // it answers the same question the Store page does — would this pass — about code that
      // is not in the store yet.
      { to: '/trials', label: 'Trials' },
    ],
  },
  {
    group: 'Operations',
    items: [
      // The loop that drives everything under it, above the log of what it did. Its badge is
      // the *request* queue rather than the backlog: the backlog is seventy-three rows on a
      // good day and a permanent number beside a nav row is furniture, while a request is
      // work somebody is waiting on and worth being told about from any page.
      { to: '/automation', label: 'Automation', queue: true },
      { to: '/activity', label: 'Activity', badge: true },
    ],
  },
  {
    group: 'Instance',
    items: [
      // The one setting the app itself owns: what the administrator is told before it
      // answers. Everything else about this box is the file below it.
      { to: '/settings', label: 'Settings' },
      // Read-only, and read rarely — so it keeps its sidebar row and gives up its tab.
      { to: '/config', label: 'Configuration', tab: false },
    ],
  },
];

type NavItem = {
  to: string;
  label: string;
  end?: boolean;
  badge?: boolean;
  /** Count the request queue rather than the alert badge. */
  queue?: boolean;
  tab?: boolean;
};

const TABS = NAV.flatMap((section) => section.items).filter((item) => item.tab !== false);

export default function Shell({ children }: { children: ReactNode }) {
  const badge = useBadge();
  // Off the one poller every other run-aware surface reads, rather than a fetch of its own.
  const queued = useRunStatus()?.queued ?? 0;
  const location = useLocation();

  return (
    <div className="app">
      <RunTitle />

      <header className="mobile-head">
        {/* The brand is the way back to the administrator on the phone, where the tab bar
            has no row for it. */}
        <NavLink to="/" className="brand" title="Administrator">
          <Mark />
          Touchstone
        </NavLink>
        {/* The phone has no sidebar to put the strip in, and the header is the one piece of
            chrome that is on screen everywhere. Compact, so it costs no height. */}
        <RunningStrip variant="compact" />
      </header>

      <nav className="sidebar" aria-label="Primary">
        <NavLink to="/" className="brand" title="Administrator" end>
          <Mark />
          Touchstone
        </NavLink>

        <div className="nav-groups">
          {NAV.map((section) => (
            <div key={section.group}>
              <div className="nav-group-name">{section.group}</div>
              {section.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className="nav-link">
                  {item.label}
                  {item.badge ? <Badge count={badge} /> : null}
                  {item.queue ? <Badge count={queued} /> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </div>

        {/* Not on Activity: the run card is the first thing on that page, and the strip a
            few centimetres away saying the same thing twice is furniture. */}
        {location.pathname === '/activity' ? null : <RunningStrip />}

        {/* The board an app author sees. Linked from here rather than from the nav so it
            stays out of the phone's tab bar — and so an operator can check what is being
            published without having to remember the path. */}
        <div className="sidebar-foot">
          conformance agent
          <a href="/public" target="_blank" rel="noopener noreferrer">public board ↗</a>
        </div>
      </nav>

      <main className="main">{children}</main>

      <nav className="tabbar" aria-label="Sections">
        {TABS.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className="tab">
            <span className="tab-glyph">
              <TabIcon to={item.to} />
              {item.badge ? <TabBadge count={badge} /> : null}
              {item.queue ? <TabBadge count={queued} /> : null}
            </span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="nav-badge" aria-label={`${count} needing attention`}>
      {count}
    </span>
  );
}

/** The same count as a dot on a tab icon, where there is no room for a word. */
function TabBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="tab-badge" aria-label={`${count} needing attention`}>
      {count > 9 ? '9+' : count}
    </span>
  );
}

/**
 * Poll for the badge count.
 *
 * Half a minute, and it survives an unreachable API by holding the last count rather than
 * dropping to zero: a nav that goes quiet when the server dies says the opposite of what
 * is true.
 */
function useBadge(): number {
  const [count, setCount] = useState(0);
  const location = useLocation();

  useEffect(() => {
    let live = true;
    const read = async () => {
      try {
        const [alerts, errors] = await Promise.all([
          getAlerts(),
          getEvents({ level: 'error', limit: 200 }),
        ]);
        if (!live) return;
        const seen = seenSeq();
        setCount(alerts.open.length + errors.events.filter((e) => e.seq > seen).length);
      } catch {
        /* hold the previous count */
      }
    };
    void read();
    const timer = setInterval(() => void read(), BADGE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
    // Re-read on navigation so leaving Activity clears the unread half immediately.
  }, [location.pathname]);

  return count;
}

/** Line icons for the tab bar, where a word alone is too small to aim at. */
function TabIcon({ to }: { to: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {GLYPH[to]}
    </svg>
  );
}

const GLYPH: Record<string, ReactNode> = {
  // a checklist: the subject table
  '/store': (
    <>
      <path d="M9 6h11" />
      <path d="M9 12h11" />
      <path d="M9 18h11" />
      <path d="m3 6 1.5 1.5L7 5" />
      <path d="m3 12 1.5 1.5L7 11" />
      <path d="m3 18 1.5 1.5L7 17" />
    </>
  ),
  // a bell: what is waiting
  '/activity': (
    <>
      <path d="M18 8A6 6 0 1 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.7 21a2 2 0 0 1-3.4 0" />
    </>
  ),
  // a page: the rubric
  '/protocol': (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </>
  ),
  // a branch: a ref that is not in the store yet
  '/trials': (
    <>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </>
  ),
  // sliders: what this instance is set to
  '/settings': (
    <>
      <path d="M5 21V14" />
      <path d="M5 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M19 21v-5" />
      <path d="M19 12V3" />
      <path d="M2.5 14h5" />
      <path d="M9.5 12h5" />
      <path d="M16.5 16h5" />
    </>
  ),
  // a loop: the queue coming round again
  '/automation': (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4" />
      <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4" />
      <path d="M20 3v4h-4" />
      <path d="M4 21v-4h4" />
    </>
  ),
};
