import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes } from 'react-router-dom';

import './styles/base.css';
import './styles/components.css';
import './styles/markdown.css';

import PublicFrame from './components/PublicFrame';
import Shell from './components/Shell';
import { EmptyState } from './components/Ui';
import Activity from './pages/Activity';
import Automation from './pages/Automation';
import Configuration from './pages/Configuration';
import Protocols from './pages/Protocols';
import Settings from './pages/Settings';
import Trials from './pages/Trials';
import AdminChat from './pages/AdminChat';
import Store from './pages/Store';
import PublicBoard from './pages/PublicBoard';
import PublicSubject from './pages/PublicSubject';
import SubjectDetail from './pages/SubjectDetail';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

/**
 * Two frames, not one.
 *
 * `/public/*` is the read-only board an app author is sent to, and it deliberately does not
 * wear the operator shell: no nav to pages that start runs, no alert badge, no poller. The
 * split is a layout route rather than a flag on `Shell`, because a flag is something a future
 * page can forget to pass and this must not be forgettable — a public page cannot render
 * operator chrome if the operator chrome is not in its tree.
 */
createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<PublicFrame><Outlet /></PublicFrame>}>
          <Route path="/public" element={<PublicBoard />} />
          <Route path="/public/s/:name" element={<PublicSubject />} />
        </Route>

        <Route element={<Shell><Outlet /></Shell>}>
          <Route path="/" element={<AdminChat />} />
          <Route path="/store" element={<Store />} />
          <Route path="/s/:name" element={<SubjectDetail />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/automation" element={<Automation />} />
          <Route path="/protocol" element={<Protocols />} />
          <Route path="/trials" element={<Trials />} />
          {/* This instance about itself: the one setting the app owns, and the file it
              booted on. Separate pages because they are separate kinds of thing — one is
              written here, the other is read here and written on the volume. */}
          <Route path="/settings" element={<Settings />} />
          <Route path="/config" element={<Configuration />} />
          {/* Addresses that used to be somewhere else. `/chat` was the administrator's own
              page before it became the front door; `/overview` is the page this one grew out
              of, and the other two predate even that. Kept rather than dropped because they
              are in the operator's history, in the chat's own notes, and in HANDOFF.md. */}
          <Route path="/chat" element={<Navigate to="/" replace />} />
          <Route path="/overview" element={<Navigate to="/store" replace />} />
          <Route path="/subjects" element={<Navigate to="/store" replace />} />
          <Route path="/findings" element={<Navigate to="/store" replace />} />
          <Route
            path="*"
            element={
              <div className="page">
                <EmptyState
                  glyph="⌕"
                  title="No such page"
                  sub="Touchstone has the administrator, the store, a subject, the protocol, trials, automation, activity and settings."
                />
              </div>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
