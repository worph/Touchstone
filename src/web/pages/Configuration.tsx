/**
 * Configuration — what this process booted on.
 *
 * Read-only, and not as a limitation: `config.yaml` is loaded once at boot and handed to the
 * services as values (the roots, the scheduler's constants, the agent's address), so a save
 * button here would change a file without changing what the app is doing until a restart —
 * which is worse than no button at all. The page says where the file is and when it was read.
 *
 * What is shown is the **effective** config: the defaults with `config.yaml` merged over
 * them, which is what is actually running rather than what the file says on its own. Values
 * whose key looks like a credential arrive already masked — the redaction is on the server,
 * so the browser is never sent the secret in the first place.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';

import { getConfig } from '../data/client';
import { ErrorState, Loading, Notice } from '../components/Ui';
import { useAsync } from '../hooks/useAsync';

export default function Configuration() {
  const state = useAsync(() => getConfig(), []);
  const [copied, setCopied] = useState(false);

  if (state.loading) return <div className="page"><Loading what="the configuration" /></div>;
  if (state.error) return <ErrorState error={state.error} what="the configuration" />;

  const json = state.data?.config ? `${JSON.stringify(state.data.config, null, 2)}\n` : '';

  return (
    <div className="page page--wide">
      <div className="panel">
        <div className="pane-head">
          <span className="section-title">configuration</span>
          <span className="dim" style={{ fontSize: 11.5 }}>{state.data?.path ?? 'defaults only'}</span>
          <div style={{ flex: 1 }} />
          <button
            className="btn"
            type="button"
            disabled={!json}
            onClick={() => {
              void navigator.clipboard?.writeText(json).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? 'copied' : 'copy'}
          </button>
        </div>

        <p className="dim" style={{ margin: '10px 2px 0', fontSize: 12.5, lineHeight: 1.6 }}>
          The defaults with <code>config.yaml</code> merged over them — what this process is
          running on, not what the file says on its own. Edit it on the volume; it is read at
          boot, so a change takes effect when Touchstone restarts. Credentials are masked
          before they leave the server.
        </p>

        <div className="subject-refs" style={{ marginTop: 10 }}>
          <div className="ref-line">
            {state.data?.loaded_at ? (
              <span className="tag">read {new Date(state.data.loaded_at).toLocaleString()}</span>
            ) : null}
            <span className="tag">read-only here</span>
          </div>
        </div>

        {state.data?.config ? null : (
          <Notice tone="warn" title="This instance did not hand the page a config">
            The API is running without one — in development, or behind an older server. There
            is nothing to show rather than nothing configured.
          </Notice>
        )}
      </div>

      {json ? (
        <section className="panel pane" style={{ marginTop: 14 }}>
          <pre className="json-view">{json}</pre>
        </section>
      ) : null}

      <p className="dim" style={{ margin: '12px 2px 0', fontSize: 12.5 }}>
        The one setting that is editable from the app is the{' '}
        <Link to="/settings">administrator's context prompt</Link>; the rubric is on{' '}
        <Link to="/protocol">Protocol</Link>.
      </p>
    </div>
  );
}
