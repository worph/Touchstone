/**
 * The administrator chat.
 *
 * The other pages answer "what is the state of the store". This one answers "do something
 * about it" — and, more usefully, "what should I do next", which is the question a screen
 * full of correct information cannot answer.
 *
 * It is the front page: the first question an operator has on opening Touchstone is almost
 * never "show me the table", it is "what needs me". The Overview is one nav row away and the
 * chat's own answers link into it, so nothing is buried — the order is just reversed.
 */

import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '@shared/activity';

import { clearChat, getChat, streamChatTurn } from '../data/client';
import { useRunStatus } from '../data/runStatus';
import { useAsync } from '../hooks/useAsync';

const OPENERS = [
  'What is the state of the store?',
  'Run a static review on FileBrowser',
  'Is anything broken right now?',
];

/** One tool call, folded away: the answer matters, the mechanics are there if you look. */
function ToolRow({ row }: { row: ChatMessage }) {
  const args = row.tool_input as Record<string, unknown> | undefined;
  const summary = args && Object.keys(args).length > 0 ? JSON.stringify(args) : 'no arguments';
  return (
    <details className="chat-tool">
      <summary>
        <span className={`chat-tool__mark ${row.ok ? 'is-ok' : 'is-refused'}`} aria-hidden="true">
          {row.ok ? '✓' : '✕'}
        </span>
        <code>{row.tool_name}</code>
        <span className="chat-tool__args">{summary}</span>
      </summary>
      <pre className="chat-tool__body">{row.content}</pre>
    </details>
  );
}

function Turn({ row }: { row: ChatMessage }) {
  if (row.role === 'tool') return <ToolRow row={row} />;
  // Touchstone itself, not either speaker: an audit started here has finished, minutes after
  // the turn that asked for it ended. Set apart so it cannot be read as the assistant's claim.
  if (row.role === 'note') {
    return (
      <p className="chat-note">
        <span className="chat-note__mark" aria-hidden="true">
          ◆
        </span>
        {row.content}
      </p>
    );
  }
  if (row.role === 'user') {
    return (
      <div className="chat-turn chat-turn--user">
        <div className="chat-bubble">{row.content}</div>
      </div>
    );
  }
  // Plain text, not markdown: the prompt asks for a sentence or two, and rendering markdown
  // in the browser would mean shipping a parser to display "Started a static audit."
  return (
    <div className="chat-turn chat-turn--assistant">
      <p className="chat-said">{row.content}</p>
    </div>
  );
}

export default function AdminChat() {
  const state = useAsync(getChat, []);
  const run = useRunStatus();
  const [draft, setDraft] = useState('');
  const [streamed, setStreamed] = useState<ChatMessage[]>([]);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // The stored rows plus anything this turn has streamed, deduped by id: the refetch after a
  // turn carries the streamed rows too, and rendering both would double every answer.
  const stored = state.data?.messages ?? [];
  const seen = new Set(stored.map((m) => m.id));
  const messages = [...stored, ...streamed.filter((m) => !seen.has(m.id))];

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, thinking]);

  /**
   * Pick up the note a finished audit writes into the thread.
   *
   * The transcript is only refetched at mount and after a turn, so a completion arriving
   * minutes later would sit unread in a file until the operator typed again. This watches the
   * shared run poller — no second interval — and refetches on the running → idle edge, which
   * is exactly when a note can have been written.
   */
  const wasRunning = useRef(false);
  useEffect(() => {
    const running = Boolean(run?.running);
    if (wasRunning.current && !running) void state.reload();
    wasRunning.current = running;
  }, [run?.running?.started_at, Boolean(run?.running)]);

  const unavailable = state.data && !state.data.available;

  async function send(text: string) {
    const message = text.trim();
    if (!message || thinking) return;
    setDraft('');
    setError(null);
    setThinking(true);
    try {
      await streamChatTurn(message, {
        onMessage: (row) => setStreamed((current) => [...current, row]),
        onError: setError,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setThinking(false);
      // The rows are the record; drop the local copy and take the server's.
      setStreamed([]);
      await state.reload();
    }
  }

  async function startNew() {
    try {
      await clearChat();
      setStreamed([]);
      setError(null);
      await state.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const composer = (
    <form
      className="chat-composer"
      onSubmit={(e) => {
        e.preventDefault();
        void send(draft);
      }}
    >
      <textarea
        className="chat-input"
        rows={1}
        value={draft}
        placeholder={unavailable ? 'The agent is not answering — see Activity' : 'Ask, or tell it what to run…'}
        onChange={(e) => {
          setDraft(e.target.value);
          e.target.style.height = 'auto';
          e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
        }}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter is a newline. A chat that needs a mouse to send is not one.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            void send(draft);
          }
        }}
      />
      <button type="submit" className="btn" disabled={thinking || !draft.trim()}>
        Send
      </button>
    </form>
  );

  if (state.error) {
    return (
      <section className="page">
        <h1>Administrator</h1>
        <p className="empty">The API is not reachable, so there is nothing to talk to.</p>
      </section>
    );
  }

  return (
    <section className="page chat-page">
      <header className="chat-head">
        <h1>Administrator</h1>
        {messages.length > 0 ? (
          <button type="button" className="btn btn--sm" onClick={() => void startNew()} disabled={thinking}>
            New conversation
          </button>
        ) : null}
      </header>

      {unavailable ? (
        <p className="notice notice--warn">
          No agent is answering, so a turn cannot be taken. The Activity page shows what its
          state is.
        </p>
      ) : null}

      {messages.length === 0 ? (
        <div className="chat-empty">
          <p className="chat-empty__lede">What should Touchstone do?</p>
          <ul className="chat-openers">
            {OPENERS.map((opener) => (
              <li key={opener}>
                <button type="button" className="chip" onClick={() => void send(opener)} disabled={thinking}>
                  {opener}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="chat-log">
          {messages.map((row) => (
            <Turn key={row.id} row={row} />
          ))}
          {thinking ? (
            <p className="chat-thinking" aria-label="Thinking">
              <span />
              <span />
              <span />
            </p>
          ) : null}
          {error ? <p className="notice notice--error">{error}</p> : null}
          <div ref={bottom} />
        </div>
      )}

      {composer}
    </section>
  );
}
