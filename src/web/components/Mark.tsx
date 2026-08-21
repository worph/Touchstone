/**
 * A solid bar and a hatched bar: the app's whole thesis in 16 pixels.
 *
 * Lives on its own because two shells wear it — the operator's sidebar and the public
 * board's header — and a logo duplicated is a logo that eventually differs.
 */
export default function Mark() {
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
