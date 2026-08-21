/**
 * The chrome the public board wears.
 *
 * Not `Shell`, and not a variant of it. The operator shell is a control surface — a nav to six
 * pages that start runs and edit the rubric, a badge that counts open alerts, a strip polling
 * the audit in flight. None of that is meant for the person whose app is on the list, and half
 * of it would 401 behind the SSO sidecar anyway.
 *
 * So this is a header, the page, and a footer that says what the reader is looking at. It
 * renders nothing that polls, nothing that links inward, and nothing to press. The one place
 * that judgement is enforced rather than stated is the API: `/api/v1/public/*` is the only
 * prefix anything under here may call, and it has no write route to reach.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import Mark from './Mark';

export default function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="pub">
      <header className="pub-head">
        <Link to="/public" className="pub-brand">
          <Mark />
          <span className="pub-brand-name">Touchstone</span>
          <span className="pub-brand-sub">app conformance</span>
        </Link>
      </header>

      <main className="pub-main">{children}</main>

      <footer className="pub-foot">
        <p>
          Every verdict here is the record of one <strong>assay</strong> — one run of a versioned
          standard against one app — and it stands until the next assay contradicts it. The
          standard, the version that judged each app, and the evidence behind every finding are
          all shown on the app's own page.
        </p>
        <p>
          <strong>Blocked is not failed.</strong> A hatched cell means the check could not be
          made — no demo instance was free, a browser was unreachable — and it is never a
          statement about the app. Nothing on this page can be changed from it: it is a read-only
          view of what has already been recorded.
        </p>
      </footer>
    </div>
  );
}
