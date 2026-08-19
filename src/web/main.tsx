import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import './styles/base.css';
import './styles/components.css';
import './styles/markdown.css';

import Shell from './components/Shell';
import { EmptyState } from './components/Ui';
import Activity from './pages/Activity';
import Overview from './pages/Overview';
import SubjectDetail from './pages/SubjectDetail';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <BrowserRouter>
      <Shell>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/s/:name" element={<SubjectDetail />} />
          <Route path="/activity" element={<Activity />} />
          <Route path="/subjects" element={<Navigate to="/" replace />} />
          <Route path="/findings" element={<Navigate to="/" replace />} />
          <Route
            path="*"
            element={
              <div className="page">
                <EmptyState
                  glyph="⌕"
                  title="No such page"
                  sub="Touchstone has three: the overview, a subject, and activity."
                />
              </div>
            }
          />
        </Routes>
      </Shell>
    </BrowserRouter>
  </StrictMode>,
);
