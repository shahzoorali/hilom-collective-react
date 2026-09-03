/**
 * Facilitator → Services.
 *
 * List + slide-over editor, following `admin/EventsTab.tsx` — the house pattern
 * for this shape of CRUD screen.
 *
 * Prices are edited in pesos and stored in centavos. The conversion happens at
 * the edges here so nothing downstream ever sees a fractional centavo; the fee
 * split is integer arithmetic and a float leaking in would show up as a
 * one-centavo discrepancy in a payout batch.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../../components/Layout';
import {
  createMyService,
  deactivateMyService,
  describeRefundPolicy,
  intakeQuestionId,
  formatDuration,
  listMyConnections,
  listMyServices,
  updateMyService,
  type Connection,
  type FacilitatorService,
  type IntakeQuestion,
  type IntegrationProvider,
  type ServiceKind,
} from '../../lib/booking';

type MeetingProvider = 'manual' | IntegrationProvider;

const PROVIDER_LABEL: Record<IntegrationProvider, string> = {
  google_meet: 'Google Meet',
  zoom: 'Zoom',
};

interface Draft {
  kind: ServiceKind;
  title: string;
  description: string;
  duration_minutes: number;
  pricePesos: string;
  sessions_count: number;
  delivery_mode: 'online' | 'in_person' | 'both';
  meeting_provider: MeetingProvider;
  meeting_url: string;
  buffer_minutes: number;
  min_notice_minutes: number;
  max_advance_days: number;
  max_per_day: string;
  cancellation_policy: string;
  refund_full_hours: number;
  refund_half_hours: number;
  intake_questions: IntakeQuestion[];
  is_active: boolean;
  sort_order: number;
}

const blankDraft = (): Draft => ({
  kind: 'standard',
  title: '',
  description: '',
  duration_minutes: 60,
  pricePesos: '',
  sessions_count: 1,
  delivery_mode: 'online',
  meeting_provider: 'manual',
  meeting_url: '',
  buffer_minutes: 0,
  min_notice_minutes: 720,
  max_advance_days: 60,
  max_per_day: '',
  cancellation_policy: '',
  refund_full_hours: 24,
  refund_half_hours: 12,
  intake_questions: [],
  is_active: true,
  sort_order: 0,
});

function toDraft(s: FacilitatorService): Draft {
  return {
    kind: s.kind,
    title: s.title,
    description: s.description ?? '',
    duration_minutes: s.duration_minutes,
    pricePesos: s.price_centavos ? String(s.price_centavos / 100) : '',
    sessions_count: s.sessions_count,
    delivery_mode: s.delivery_mode,
    meeting_provider: s.meeting_provider ?? 'manual',
    meeting_url: s.meeting_url ?? '',
    buffer_minutes: s.buffer_minutes,
    min_notice_minutes: s.min_notice_minutes,
    max_advance_days: s.max_advance_days,
    max_per_day: s.max_per_day === null ? '' : String(s.max_per_day),
    cancellation_policy: s.cancellation_policy ?? '',
    refund_full_hours: s.refund_full_hours ?? 24,
    refund_half_hours: s.refund_half_hours ?? 12,
    intake_questions: s.intake_questions ?? [],
    is_active: s.is_active,
    sort_order: s.sort_order,
  };
}

function toInput(d: Draft): Record<string, unknown> {
  return {
    kind: d.kind,
    title: d.title,
    description: d.description || null,
    duration_minutes: d.duration_minutes,
    // Rounded, not truncated: 1500.005 pesos is a typo, not an instruction to
    // discard half a centavo.
    price_centavos: d.kind === 'exploratory' ? 0 : Math.round(Number(d.pricePesos || 0) * 100),
    sessions_count: d.sessions_count,
    delivery_mode: d.delivery_mode,
    meeting_provider: d.meeting_provider,
    meeting_url: d.meeting_url || null,
    buffer_minutes: d.buffer_minutes,
    min_notice_minutes: d.min_notice_minutes,
    max_advance_days: d.max_advance_days,
    max_per_day: d.max_per_day === '' ? null : Number(d.max_per_day),
    cancellation_policy: d.cancellation_policy || null,
    refund_full_hours: d.refund_full_hours,
    refund_half_hours: d.refund_half_hours,
    // Questions with no label are half-typed rows the facilitator abandoned;
    // the server rejects them, so they are dropped here rather than turning a
    // save into an error about something they had already given up on.
    intake_questions: d.intake_questions.filter((q) => q.label.trim()),
    is_active: d.is_active,
    sort_order: d.sort_order,
  };
}

/**
 * Build the questions a client is asked before this session (0032).
 *
 * Kept small on purpose. This is a screening form — "is there anything about
 * your health I should know", "have you done this before", a consent tick —
 * not a form builder, and every extra field type is one more thing a client has
 * to work out how to answer on a phone thirty seconds before paying.
 *
 * Ids are derived from the label and assigned when a question is *created*,
 * then never changed. An answer joins on the id, so re-deriving it from an
 * edited label would orphan every answer already given.
 */
function IntakeEditor({
  questions,
  onChange,
}: {
  questions: IntakeQuestion[];
  onChange: (questions: IntakeQuestion[]) => void;
}) {
  const update = (index: number, patch: Partial<IntakeQuestion>) =>
    onChange(questions.map((q, i) => (i === index ? { ...q, ...patch } : q)));

  const add = () =>
    onChange([
      ...questions,
      {
        // A placeholder id, replaced once the label is typed — see `blur` below.
        id: `q${questions.length + 1}-${Date.now().toString(36)}`,
        label: '',
        help: null,
        type: 'text',
        required: false,
        options: [],
      },
    ]);

  return (
    <>
      <h4 style={{ marginBottom: '0.25rem' }}>Before the session</h4>
      <p className="small muted" style={{ marginTop: 0 }}>
        Questions your client answers when they book. They can revise their answers up until the
        session starts, and you'll see them on the booking. Keep it short — this is asked mid-
        checkout.
      </p>

      {questions.map((q, index) => (
        <div key={q.id} className="card" style={{ marginBottom: '0.5rem' }}>
          <label className="field">
            <span>Question</span>
            <input
              value={q.label}
              placeholder="Is there anything about your health I should know?"
              onChange={(e) => update(index, { label: e.target.value })}
              onBlur={(e) => {
                // Settled on blur, and only while the question is still new:
                // an answered question's id is load-bearing and re-deriving it
                // from an edited label would orphan those answers.
                if (!q.label.trim()) return;
                const settled = intakeQuestionId(e.target.value, index);
                if (settled !== q.id && !questions.some((other) => other.id === settled)) {
                  update(index, { id: settled });
                }
              }}
            />
          </label>

          <div className="two-col">
            <label className="field">
              <span>Answer type</span>
              <select
                value={q.type}
                onChange={(e) =>
                  update(index, {
                    type: e.target.value as IntakeQuestion['type'],
                    // A type that has no options must not keep stale ones.
                    options: e.target.value === 'choice' ? q.options : [],
                  })
                }
              >
                <option value="text">Short answer</option>
                <option value="longtext">Long answer</option>
                <option value="choice">Choose one</option>
                <option value="checkbox">Tick to confirm</option>
              </select>
            </label>

            <label className="field row" style={{ gap: '0.5rem', alignItems: 'center' }}>
              <input
                type="checkbox"
                checked={q.required}
                onChange={(e) => update(index, { required: e.target.checked })}
              />
              <span>They must answer this</span>
            </label>
          </div>

          {q.type === 'choice' && (
            <label className="field">
              <span>Options, one per line</span>
              <textarea
                rows={3}
                value={q.options.join('\n')}
                placeholder={'Never\nOnce or twice\nRegularly'}
                onChange={(e) =>
                  update(index, {
                    options: e.target.value.split('\n').map((line) => line.trim()).filter(Boolean),
                  })
                }
              />
            </label>
          )}

          <label className="field">
            <span>Help text (optional)</span>
            <input
              value={q.help ?? ''}
              onChange={(e) => update(index, { help: e.target.value || null })}
              placeholder="Anything ongoing, or medication you're taking."
            />
          </label>

          <button
            type="button"
            className="btn btn-ghost small"
            onClick={() => onChange(questions.filter((_, i) => i !== index))}
          >
            Remove this question
          </button>
        </div>
      ))}

      <button type="button" className="btn btn-ghost small" onClick={add}>
        + Add a question
      </button>
    </>
  );
}

export default function ServicesTab() {
  const [services, setServices] = useState<FacilitatorService[] | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [openId, setOpenId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function reload() {
    listMyServices()
      .then(setServices)
      .catch((err: Error) => setError(err.message));
  }

  useEffect(() => {
    reload();
    // Which providers are connected decides which picker options are live. A
    // failure here is not worth blocking the screen — the options just fall
    // back to "connect first".
    listMyConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  }, []);

  const connectedProviders = new Set(
    connections.filter((c) => c.connected && !c.broken).map((c) => c.provider),
  );

  function open(service?: FacilitatorService) {
    setError(null);
    if (service) {
      setDraft(toDraft(service));
      setOpenId(service.id);
    } else {
      setDraft(blankDraft());
      setOpenId('new');
    }
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (openId === 'new') await createMyService(toInput(draft));
      else if (openId) await updateMyService(openId, toInput(draft));
      setOpenId(null);
      setNotice('Saved');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function deactivate(service: FacilitatorService) {
    if (
      !window.confirm(
        `Remove "${service.title}" from your profile?\n\nSessions already booked are unaffected and stay in your calendar.`,
      )
    )
      return;
    try {
      await deactivateMyService(service.id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove');
    }
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>Services</h2>
        <button type="button" className="btn btn-accent small" onClick={() => open()}>
          Add a service
        </button>
      </div>

      {error && !openId && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}
      {services === null && <div className="spinner" aria-label="Loading" />}

      {services !== null && services.length === 0 && (
        <div className="panel">
          <p style={{ marginTop: 0 }}>
            You haven't added a service yet. Most facilitators start with a free 20-minute intro
            call and one paid session.
          </p>
          <button type="button" className="btn btn-accent" onClick={() => open()}>
            Add your first service
          </button>
        </div>
      )}

      {(services ?? []).map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: '0.75rem', opacity: s.is_active ? 1 : 0.55 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>{s.title}</strong>
            <span>{s.price_centavos === 0 ? 'Free' : money(s.price_centavos, s.currency)}</span>
          </div>
          <p className="small muted" style={{ margin: '0.25rem 0 0.6rem' }}>
            {formatDuration(s.duration_minutes)}
            {s.kind === 'exploratory' && ' · complimentary intro call'}
            {s.kind === 'package' && ` · ${s.sessions_count} sessions`}
            {!s.is_active && ' · not shown on your profile'}
            {s.delivery_mode !== 'in_person' && (
              s.meeting_provider === 'google_meet'
                ? ' · Google Meet'
                : s.meeting_provider === 'zoom'
                  ? ' · Zoom'
                  : !s.meeting_url && ' · no meeting link set'
            )}
          </p>
          <div className="row" style={{ gap: '0.5rem' }}>
            <button type="button" className="btn btn-ghost small" onClick={() => open(s)}>
              Edit
            </button>
            {s.is_active && (
              <button type="button" className="btn btn-ghost small" onClick={() => void deactivate(s)}>
                Remove
              </button>
            )}
          </div>
        </div>
      ))}

      {openId && (
        <div className="admin-drawer-overlay" role="dialog" aria-modal="true">
          <div className="admin-drawer">
            <header className="admin-drawer-header">
              <h3 style={{ margin: 0 }}>{openId === 'new' ? 'New service' : 'Edit service'}</h3>
              <button type="button" className="btn btn-ghost small" onClick={() => setOpenId(null)}>
                Close
              </button>
            </header>

            <div className="admin-drawer-body">
              {error && <div className="alert alert-error">{error}</div>}

              <label className="field">
                <span>Type</span>
                {/* "Package of sessions" is deliberately absent: buying one
                    charged the full price and produced a single session, so
                    it is closed at the point of sale until multi-session
                    scheduling exists. The backend rejects it too — see
                    SELLABLE_SERVICE_KINDS in facilitator-input.ts. */}
                <select value={draft.kind} onChange={(e) => set('kind', e.target.value as ServiceKind)}>
                  <option value="standard">Single session</option>
                  <option value="exploratory">Complimentary intro call</option>
                </select>
              </label>

              {draft.kind === 'exploratory' && (
                <p className="small muted">
                  Always free, and each client can book one per facilitator. You can only have one
                  active intro call.
                </p>
              )}

              <label className="field">
                <span>Title</span>
                <input value={draft.title} onChange={(e) => set('title', e.target.value)} maxLength={160} />
              </label>

              <label className="field">
                <span>Description</span>
                <textarea
                  rows={4}
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                />
              </label>

              <div className="two-col">
                <label className="field">
                  <span>Length (minutes)</span>
                  <input
                    type="number"
                    min={5}
                    max={480}
                    value={draft.duration_minutes}
                    onChange={(e) => set('duration_minutes', Number(e.target.value))}
                  />
                </label>

                {draft.kind !== 'exploratory' && (
                  <label className="field">
                    <span>Price (₱)</span>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={draft.pricePesos}
                      onChange={(e) => set('pricePesos', e.target.value)}
                    />
                  </label>
                )}
              </div>

              {draft.kind === 'package' && (
                <label className="field">
                  <span>Number of sessions</span>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={draft.sessions_count}
                    onChange={(e) => set('sessions_count', Number(e.target.value))}
                  />
                </label>
              )}

              <label className="field">
                <span>Delivered</span>
                <select
                  value={draft.delivery_mode}
                  onChange={(e) => set('delivery_mode', e.target.value as Draft['delivery_mode'])}
                >
                  <option value="online">Online</option>
                  <option value="in_person">In person</option>
                  <option value="both">Either</option>
                </select>
              </label>

              {draft.delivery_mode !== 'in_person' && (
                <MeetingProviderPicker
                  provider={draft.meeting_provider}
                  onProvider={(p) => set('meeting_provider', p)}
                  backupUrl={draft.meeting_url}
                  onBackupUrl={(v) => set('meeting_url', v)}
                  connectedProviders={connectedProviders}
                />
              )}

              <h4>Scheduling rules</h4>

              <div className="two-col">
                <label className="field">
                  <span>Gap after each session (minutes)</span>
                  <input
                    type="number"
                    min={0}
                    max={240}
                    value={draft.buffer_minutes}
                    onChange={(e) => set('buffer_minutes', Number(e.target.value))}
                  />
                </label>

                <label className="field">
                  <span>Minimum notice (hours)</span>
                  <input
                    type="number"
                    min={0}
                    max={720}
                    value={draft.min_notice_minutes / 60}
                    onChange={(e) => set('min_notice_minutes', Math.round(Number(e.target.value) * 60))}
                  />
                </label>
              </div>

              <div className="two-col">
                <label className="field">
                  <span>Bookable up to (days ahead)</span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={draft.max_advance_days}
                    onChange={(e) => set('max_advance_days', Number(e.target.value))}
                  />
                </label>

                <label className="field">
                  <span>Max per day</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={draft.max_per_day}
                    placeholder="No limit"
                    onChange={(e) => set('max_per_day', e.target.value)}
                  />
                </label>
              </div>

              {/* These two numbers *are* the policy — the refund a cancelling
                  client gets is computed from them, and the sentence below is
                  generated from the same values, so what a client is promised
                  and what they are paid cannot drift apart. */}
              <div className="two-col">
                <label className="field">
                  <span>Full refund with at least (hours notice)</span>
                  <input
                    type="number"
                    min={0}
                    max={720}
                    value={draft.refund_full_hours}
                    onChange={(e) => {
                      const full = Number(e.target.value);
                      set('refund_full_hours', full);
                      // Keeping the pair ordered as they type, rather than
                      // letting them save an impossible ladder and reading the
                      // rejection back off the server.
                      if (draft.refund_half_hours > full) set('refund_half_hours', full);
                    }}
                  />
                </label>

                <label className="field">
                  <span>Half refund with at least (hours notice)</span>
                  <input
                    type="number"
                    min={0}
                    max={draft.refund_full_hours}
                    value={draft.refund_half_hours}
                    onChange={(e) =>
                      set('refund_half_hours', Math.min(Number(e.target.value), draft.refund_full_hours))
                    }
                  />
                </label>
              </div>

              <p className="small muted" style={{ marginTop: '-0.25rem' }}>
                Clients will see: “{describeRefundPolicy(draft)}”
              </p>

              <label className="field">
                <span>Cancellation note (optional)</span>
                <input
                  value={draft.cancellation_policy}
                  onChange={(e) => set('cancellation_policy', e.target.value)}
                  placeholder="Anything else clients should know — shown under the policy above."
                />
              </label>

              <IntakeEditor
                questions={draft.intake_questions}
                onChange={(questions) => set('intake_questions', questions)}
              />

              <label className="field row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={draft.is_active}
                  onChange={(e) => set('is_active', e.target.checked)}
                />
                <span>Show this on my profile</span>
              </label>
            </div>

            <footer className="admin-drawer-footer">
              <button type="button" className="btn btn-ghost" onClick={() => setOpenId(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-accent" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * "Where do you meet?" — the meeting-link choice for one service.
 *
 * Three options. Google Meet and Zoom generate a real link per booking in the
 * facilitator's own account; "I'll provide my own link" is the original
 * behaviour, a single standing room typed by hand.
 *
 * An unconnected provider is shown but disabled, with the connect prompt
 * inline. Hiding it would make the feature undiscoverable; enabling it would
 * produce a service that silently cannot create links. The "you need an
 * account" message lives here, at the moment of the decision, not in a
 * tooltip.
 */
function MeetingProviderPicker({
  provider,
  onProvider,
  backupUrl,
  onBackupUrl,
  connectedProviders,
}: {
  provider: MeetingProvider;
  onProvider: (p: MeetingProvider) => void;
  backupUrl: string;
  onBackupUrl: (v: string) => void;
  connectedProviders: Set<string>;
}) {
  const integrated: IntegrationProvider[] = ['google_meet', 'zoom'];

  return (
    <fieldset className="field choice-set">
      <legend>Where do you meet?</legend>

      {integrated.map((p) => {
        const connected = connectedProviders.has(p);
        const selected = provider === p;
        return (
          <label
            key={p}
            className={`choice-row${selected ? ' choice-row--on' : ''}`}
            style={connected ? undefined : { opacity: 0.7 }}
          >
            <input
              type="radio"
              name="meeting_provider"
              checked={selected}
              disabled={!connected}
              onChange={() => onProvider(p)}
            />
            <span>
              <strong>{PROVIDER_LABEL[p]}</strong>
              <span className="small muted" style={{ display: 'block' }}>
                {p === 'google_meet'
                  ? 'A fresh Meet link is created for each booking.'
                  : 'Each booking becomes a scheduled meeting in your Zoom account, with you as host.'}
              </span>
              {!connected && (
                <span className="small" style={{ display: 'block', marginTop: '0.15rem' }}>
                  <Link to="/facilitator/connections">Connect your {PROVIDER_LABEL[p]} account</Link>{' '}
                  first.
                </span>
              )}
            </span>
          </label>
        );
      })}

      <label className={`choice-row${provider === 'manual' ? ' choice-row--on' : ''}`}>
        <input
          type="radio"
          name="meeting_provider"
          checked={provider === 'manual'}
          onChange={() => onProvider('manual')}
        />
        <span>
          <strong>I’ll provide my own link</strong>
          <span className="small muted" style={{ display: 'block' }}>
            One standing room you enter below, reused for every session.
          </span>
        </span>
      </label>

      {/* The URL field does double duty: the link itself for 'manual', an
          optional backup for the integrated providers (used only if automatic
          creation fails at booking time). */}
      <label className="field" style={{ marginTop: '0.75rem' }}>
        <span>{provider === 'manual' ? 'Meeting link' : 'Backup link (optional)'}</span>
        <input
          value={backupUrl}
          onChange={(e) => onBackupUrl(e.target.value)}
          placeholder="https://zoom.us/j/..."
        />
        <small className="muted">
          {provider === 'manual'
            ? 'Sent to the client once their booking is confirmed. Never shown publicly.'
            : 'Used only if the automatic link cannot be created. Setting one is a good safety net.'}
        </small>
      </label>
    </fieldset>
  );
}
