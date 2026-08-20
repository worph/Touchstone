import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { getAlerts, getEvents } from '../data/client';
import { seenSeq } from '../lib/badge';
import RunningStrip, { RunTitle } from './RunningStrip';

const BADGE_MS = 30_000;

/**
 * Five destinations: the three of UX.md §2, the administrator chat, and the loop's own page. The badge on Activity counts open alerts and unread
 * error rows — nothing else, deliberately.
 *
 * Grouped in the sidebar the way the app divides: the standard and what it is measured against on top, what the machine is
 * doing underneath. With only five there is nothing to hide behind a "more" sheet, so the phone gets all five as tabs.
 */
const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Conformance',
    items: [
      { to: '/', label: 'Overview', end: true },
      // The rubric every verdict is measured against. It used to live in a wiki this
      // app only held a slug for; it is a local file now, and editable.
      { to: '/protocol', label: 'Protocol' },
    ],
  },
  {
    group: 'Operations',
    items: [
      // The loop that drives everything under it, above the log of what it did.
      { to: '/automation', label: 'Automation' },
      { to: '/activity', label: 'Activity', badge: true },
      { to: '/chat', label: 'Administrator' },
    ],
  },
];

type NavItem = { to: string; label: string; end?: boolean; badge?: boolean };

const TABS = NAV.flatMap((section) => section.items);

export default function Shell({ children }: { children: ReactNode }) {
  const badge = useBadge();
  const location = useLocation();

  return (
    <div className="app">
      <RunTitle />

      <header className="mobile-head">
        <NavLink to="/" className="brand">
          <Mark />
          Touchstone
        </NavLink>
        {/* The phone has no sidebar to put the strip in, and the header is the one piece of
            chrome that is on screen everywhere. Compact, so it costs no height. */}
        <RunningStrip variant="compact" />
      </header>

      <nav className="sidebar" aria-label="Primary">
        <NavLink to="/" className="brand" end>
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
                </NavLink>
              ))}
            </div>
          ))}
        </div>

        {/* Not on Activity: the run card is the first thing on that page, and the strip a
            few centimetres away saying the same thing twice is furniture. */}
        {location.pathname === '/activity' ? null : <RunningStrip />}

        <div className="sidebar-foot">conformance agent</div>
      </nav>

      <main className="main">{children}</main>

      <nav className="tabbar" aria-label="Sections">
        {TABS.map((item) => (
          <NavLink key={item.to} to={item.to} end={item.end} className="tab">
            <span className="tab-glyph">
              <TabIcon to={item.to} />
              {item.badge ? <TabBadge count={badge} /> : null}
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

/** A solid bar and a hatched bar: the app's whole thesis in 16 pixels. */
function Mark() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="2" width="4.5" height="12" rx="1" fill="var(--ok)" />
      <g fill="var(--unknown)">
        <rect x="8.5" y="2" width="6" height="1.7" rx="0.6" />
        <rect x="8.5" y="5.2" width="6" height="1.7" rx="0.6" />
        <rect x="8.5" y="8.4" width="6" height="1.7" rx="0.6" />
        <rect x="8.5" y="11.6" width="6" height="1.7" rx="0.6" />
      </g>
    </svg>
  );
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
  '/': (
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
  // a loop: the queue coming round again
  '/automation': (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9 9 0 0 1 7.5 4" />
      <path d="M21 12a9 9 0 0 1-9 9 9 9 0 0 1-7.5-4" />
      <path d="M20 3v4h-4" />
      <path d="M4 21v-4h4" />
    </>
  ),
  // a speech bubble: the chat
  '/chat': <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-3.8-.9L3 20.5l1.5-4.4A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" />,
};
