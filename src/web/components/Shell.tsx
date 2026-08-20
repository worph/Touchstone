import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { getAlerts, getEvents } from '../data/client';
import { seenSeq } from '../lib/badge';

const BADGE_MS = 30_000;

/**
 * Three nav items, per UX.md §2. The badge on Activity counts open alerts and unread error
 * rows — nothing else, deliberately.
 */
export default function Shell({ children }: { children: React.ReactNode }) {
  const badge = useBadge();

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <Mark />
          Touchstone
        </NavLink>

        <nav className="nav" aria-label="Primary">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/activity">
            Activity
            {badge > 0 ? (
              <span className="nav-badge" aria-label={`${badge} needing attention`}>
                {badge}
              </span>
            ) : null}
          </NavLink>
          {/* The rubric every verdict is measured against. It used to live in a wiki this
              app only held a slug for; it is a local file now, and editable. */}
          <NavLink to="/protocol">Protocol</NavLink>
        </nav>
      </header>

      <main className="main">{children}</main>
    </div>
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
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
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
