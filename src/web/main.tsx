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
import Protocols from './pages/Protocols';
import Trials from './pages/Trials';
import AdminChat from './pages/AdminChat';
import Overview from './pages/Overview';
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
          <Route path="/overview" element={<Overview />} />
          <Route path="/s/:name" element={<SubjectDetail />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/automation" element={<Automation />} />
          <Route path="/protocol" element={<Protocols />} />
          <Route path="/trials" element={<Trials />} />
          {/* Addresses that used to be somewhere else. `/chat` was the administrator's own
              page before it became the front door; the other two predate the Overview. */}
          <Route path="/chat" element={<Navigate to="/" replace />} />
          <Route path="/subjects" element={<Navigate to="/overview" replace />} />
          <Route path="/findings" element={<Navigate to="/overview" replace />} />
          <Route
            path="*"
            element={
              <div className="page">
                <EmptyState
                  glyph="⌕"
                  title="No such page"
                  sub="Touchstone has the administrator, the overview, a subject, automation and activity."
                />
              </div>
            }
          />
        </Route>
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
