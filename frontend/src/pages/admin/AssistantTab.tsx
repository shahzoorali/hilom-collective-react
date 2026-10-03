/**
 * Admin → Assistant: ask anything about Hilom — data, code, payments, logs,
 * infra, the Help Centre — and get a sourced answer. Read-only by
 * construction; see docs/admin-assistant.md.
 *
 * Answers take 10–90 s (the assistant runs SQL, reads code and searches logs
 * before replying), so a question starts a run and this screen polls it,
 * showing each tool step live. That progress is also the audit trail: every
 * step, including the exact SQL, is expandable under the answer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import {
  askAssistant,
  deleteAssistantConversation,
  getAssistantConversation,
  getAssistantRun,
  listAssistantConversations,
  type AssistantConversation,
  type AssistantRun,
  type AssistantStep,
} from '../../lib/assistant';
import { Icon } from './ui/Icon';
import { adminConfirm, adminToast } from './ui/feedback';

const POLL_MS = 1500;

const STARTERS = [
  'Give me a health check: stuck orders, failed enrollments, queue depths and errors in the last 24h.',
  'What did we sell in the last 30 days, by product, in PHP?',
  'Walk me through what happens from checkout to Moodle enrollment.',
  'How does a facilitator get approved and paid out?',
  'Which help articles exist for facilitators?',
  'A buyer says they paid but cannot access their course. How do I investigate?',
];

function Markdown({ source }: { source: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false, gfm: true, breaks: false }) as string;
    return DOMPurify.sanitize(raw);
  }, [source]);
  // Sanitised above; links open in a new tab so the conversation isn't lost.
  return (
    <div
      className="assistant-md"
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a');
        if (a && a.href) {
          e.preventDefault();
          window.open(a.href, '_blank', 'noopener');
        }
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const TOOL_ICON: Record<string, string> = {
  query_db: 'box',
  describe_schema: 'columns',
  search_help: 'bulb',
  list_files: 'file',
  search_code: 'search',
  read_file: 'file',
  list_log_groups: 'activity',
  query_logs: 'activity',
  describe_infra: 'settings',
  queue_depths: 'inbox',
  moodle_call: 'cap',
  paymongo_lookup: 'card',
};

function Steps({ steps, live }: { steps: AssistantStep[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  if (steps.length === 0) return live ? <div className="assistant-thinking">Thinking…</div> : null;
  const shown = live ? steps.slice(-4) : steps;
  return (
    <div className="assistant-steps">
      {!live && (
        <button type="button" className="assistant-steps__toggle" onClick={() => setOpen((o) => !o)}>
          {open ? '▾' : '▸'} {steps.length} step{steps.length === 1 ? '' : 's'} ·{' '}
          {(steps.reduce((t, s) => t + s.ms, 0) / 1000).toFixed(1)}s of tool time
        </button>
      )}
      {(live || open) && (
        <ol className="assistant-steps__list">
          {shown.map((s, i) => (
            <li key={i} className={s.ok ? '' : 'is-error'}>
              <Icon name={TOOL_ICON[s.tool] ?? 'arrow'} size={14} />
              <details>
                <summary>
                  <span className="assistant-steps__label">{s.label}</span>
                  <span className="muted small"> {s.ms} ms{s.ok ? '' : ' · failed'}</span>
                </summary>
                <pre>{s.preview}</pre>
              </details>
            </li>
          ))}
          {live && <li className="assistant-thinking">Working…</li>}
        </ol>
      )}
    </div>
  );
}

function RunView({ run }: { run: AssistantRun }) {
  const live = run.status === 'queued' || run.status === 'running';
  const [copied, setCopied] = useState(false);
  return (
    <div className="assistant-run">
      <div className="assistant-q">
        <div className="assistant-q__bubble">{run.question}</div>
      </div>
      <div className="assistant-a">
        <div className="assistant-a__avatar" aria-hidden>
          H
        </div>
        <div className="assistant-a__body">
          <Steps steps={run.steps ?? []} live={live} />
          {run.status === 'done' && run.answer && (
            <>
              <Markdown source={run.answer} />
              <div className="assistant-a__meta">
                <button
                  type="button"
                  className="btn btn-ghost small"
                  onClick={() => {
                    void navigator.clipboard.writeText(run.answer ?? '');
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  }}
                >
                  {copied ? 'Copied' : 'Copy answer'}
                </button>
                {run.finished_at && (
                  <span className="muted small">
                    {((new Date(run.finished_at).getTime() - new Date(run.created_at).getTime()) / 1000).toFixed(0)}s
                  </span>
                )}
              </div>
            </>
          )}
          {run.status === 'error' && <div className="alert alert-error">Something went wrong: {run.error}</div>}
        </div>
      </div>
    </div>
  );
}

export default function AssistantTab({ adminKey }: { adminKey: string }) {
  const [conversations, setConversations] = useState<AssistantConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [runs, setRuns] = useState<AssistantRun[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Phones only: the conversation list is a drawer over the thread.
  const [historyOpen, setHistoryOpen] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const refreshList = useCallback(() => {
    listAssistantConversations(adminKey).then(setConversations).catch(() => undefined);
  }, [adminKey]);
  useEffect(refreshList, [refreshList]);

  const busy = sending || runs.some((r) => r.status === 'queued' || r.status === 'running');

  // Poll whichever run is still going.
  useEffect(() => {
    const pending = runs.find((r) => r.status === 'queued' || r.status === 'running');
    if (!pending) return;
    const t = setTimeout(async () => {
      try {
        const fresh = await getAssistantRun(adminKey, pending.id);
        setRuns((rs) => rs.map((r) => (r.id === fresh.id ? fresh : r)));
        if (fresh.status === 'done' || fresh.status === 'error') refreshList();
      } catch (e) {
        setError((e as Error).message);
      }
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [runs, adminKey, refreshList]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [runs.length, runs[runs.length - 1]?.status, runs[runs.length - 1]?.steps?.length]);

  const openConversation = async (id: string) => {
    setHistoryOpen(false);
    setError(null);
    setConversationId(id);
    try {
      setRuns(await getAssistantConversation(adminKey, id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const newConversation = () => {
    setHistoryOpen(false);
    setConversationId(undefined);
    setRuns([]);
    setError(null);
    input.current?.focus();
  };

  const removeConversation = async (c: AssistantConversation) => {
    const yes = await adminConfirm({
      title: 'Delete this conversation?',
      body: `“${c.title}” and every answer in it will be permanently deleted, including the record of what was asked and which queries ran. This can't be undone.`,
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!yes) return;
    try {
      await deleteAssistantConversation(adminKey, c.id);
      setConversations((cs) => cs.filter((x) => x.id !== c.id));
      if (c.id === conversationId) {
        setConversationId(undefined);
        setRuns([]);
      }
      adminToast.success('Conversation deleted');
    } catch (e) {
      adminToast.error((e as Error).message);
    }
  };

  const send = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setSending(true);
    setError(null);
    try {
      const { runId, conversationId: cid } = await askAssistant(adminKey, q, conversationId);
      setConversationId(cid);
      setDraft('');
      setRuns((rs) => [
        ...rs,
        { id: runId, question: q, status: 'queued', steps: [], answer: null, error: null, created_at: new Date().toISOString(), finished_at: null },
      ]);
      if (!conversationId) refreshList();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="assistant">
      {historyOpen && <div className="assistant-backdrop" onClick={() => setHistoryOpen(false)} aria-hidden />}
      <aside className={`assistant-side${historyOpen ? ' is-open' : ''}`} aria-label="Conversations">
        <button type="button" className="btn btn-primary" onClick={newConversation}>
          + New conversation
        </button>
        <ul className="assistant-side__list">
          {conversations.map((c) => (
            <li key={c.id} className="assistant-side__item">
              <button
                type="button"
                className={c.id === conversationId ? 'is-active' : ''}
                onClick={() => void openConversation(c.id)}
                title={`${c.title}\n${c.actor_label} · ${new Date(c.updated_at).toLocaleString()}`}
              >
                <span className="assistant-side__title">{c.title}</span>
                <span className="muted small">
                  {c.actor_label} · {new Date(c.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                </span>
              </button>
              <button
                type="button"
                className="assistant-side__delete"
                onClick={() => void removeConversation(c)}
                aria-label={`Delete conversation: ${c.title}`}
                title="Delete conversation"
              >
                <Icon name="trash" size={15} />
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="assistant-main">
        <div className="assistant-mobilebar">
          <button type="button" className="btn btn-ghost small" onClick={() => setHistoryOpen(true)}>
            <Icon name="menu" size={16} /> History
          </button>
          <span className="assistant-mobilebar__title">
            {conversations.find((c) => c.id === conversationId)?.title ?? 'New conversation'}
          </span>
          <button type="button" className="btn btn-ghost small" onClick={newConversation} aria-label="New conversation">
            +
          </button>
        </div>
        <div className="assistant-thread">
          {runs.length === 0 ? (
            <div className="assistant-empty">
              <h2>Ask Hilom anything</h2>
              <p className="muted">
                Orders, payments, enrollments, facilitators, events, how a feature works, what the logs say, how to do
                something in the admin. The assistant reads the live database, the code, logs, Moodle, PayMongo and the
                Help Centre — and can't change anything.
              </p>
              <div className="assistant-starters">
                {STARTERS.map((s) => (
                  <button key={s} type="button" onClick={() => void send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            runs.map((r) => <RunView key={r.id} run={r} />)
          )}
          <div ref={bottom} />
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        <form
          className="assistant-composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            ref={input}
            value={draft}
            rows={2}
            placeholder={busy ? 'Working on it…' : 'Ask anything about Hilom…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send(draft);
              }
            }}
          />
          <button type="submit" className="btn btn-primary" disabled={busy || !draft.trim()}>
            {busy ? '…' : 'Ask'}
          </button>
        </form>
        <p className="muted small assistant-foot">
          Read-only. Every question and every query it runs is logged with your name. Verify before acting on anything
          involving money.
        </p>
      </section>
    </div>
  );
}
