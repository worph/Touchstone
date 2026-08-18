import { NavLink } from 'react-router-dom';

/**
 * Two nav items, per UX.md §2 — and only one is built. Activity is shown disabled
 * rather than hidden: the shape of the app is part of what the page communicates,
 * and an item that quietly appears later is a worse surprise than one that is
 * visibly not built yet.
 */
const NAV = [
  { to: '/', label: 'Overview', end: true, enabled: true },
  { to: '/activity', label: 'Activity', end: false, enabled: false },
];

export default function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <Mark />
          Touchstone
        </NavLink>

        <nav className="nav" aria-label="Primary">
          {NAV.map((item) =>
            item.enabled ? (
              <NavLink key={item.to} to={item.to} end={item.end}>
                {item.label}
              </NavLink>
            ) : (
              <a
                key={item.to}
                aria-disabled="true"
                title={`${item.label} is designed in UX.md and lands with the prober (P2).`}
              >
                {item.label}
              </a>
            ),
          )}
        </nav>
      </header>

      <main className="main">{children}</main>
    </div>
  );
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
