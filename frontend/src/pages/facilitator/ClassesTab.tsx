/**
 * Facilitator → Classes (0049).
 *
 * A class is the offering — "Thursday morning breathwork" as a thing that
 * exists — and a session is one occurrence of it. The screen is shaped around
 * that split because it is the split people actually work in: the description
 * and the price are written once, and then a date is added most weeks.
 *
 * ## The minimum does not do anything
 *
 * `min_joiners` is advisory and the copy says so out loud, in the form and on
 * every session row. A number labelled "minimum" that silently did nothing
 * would be read as a promise that the class gets cancelled and refunded below
 * it, and the one thing worse than not having that feature is appearing to.
 *
 * ## Cancelling does not refund
 *
 * Refunds on this platform are manual, everywhere. Cancelling a session frees
 * the seats and reports what is owed; an admin moves the money.
 *
 * That is said three times over, which is deliberate rather than repetitive:
 * standing above the date list once a session has anyone on it, again in the
 * confirmation, and again in the result, which names the amount Hilom now owes
 * out. A window.confirm is read by someone who has already decided and often
 * not read at all, so it cannot be the only place this appears — and a
 * facilitator who cancels a paid class believing the refunds went out
 * automatically is the one outcome here that costs a client real money and
 * real silence.
 */
import { useEffect, useState } from 'react';
import { money } from '../../components/Layout';
import {
  listMyClasses,
  createMyClass,
  updateMyClass,
  deactivateMyClass,
  listMyClassSessions,
  scheduleMyClassSession,
  cancelMyClassSession,
  updateMyClassSessionPrice,
  viewerTimezone,
  formatInZone,
  type GroupClass,
  type GroupClassInput,
  type ClassSession,
} from '../../lib/booking';

const MODE_LABEL: Record<string, string> = {
  online: 'Online',
  in_person: 'In person',
  both: 'Online or in person',
};

function priceLabel(p: { price_centavos: number; is_pay_what_you_want?: boolean; min_centavos?: number | null }) {
  if (p.is_pay_what_you_want) return `Pay what you want, from ${money(p.min_centavos ?? p.price_centavos)}`;
  return p.price_centavos === 0 ? 'Free' : money(p.price_centavos);
}

/** Whether a scheduled date still charges what the class now charges. */
function samePricing(
  s: { price_centavos: number; is_pay_what_you_want?: boolean; min_centavos?: number | null; suggested_centavos?: number[] },
  c: { price_centavos: number; is_pay_what_you_want?: boolean; min_centavos?: number | null; suggested_centavos?: number[] },
) {
  if (Boolean(s.is_pay_what_you_want) !== Boolean(c.is_pay_what_you_want)) return false;
  if (!c.is_pay_what_you_want) return s.price_centavos === c.price_centavos;
  return (
    (s.min_centavos ?? null) === (c.min_centavos ?? null) &&
    (s.suggested_centavos ?? []).join(',') === (c.suggested_centavos ?? []).join(',')
  );
}

const BLANK: GroupClassInput = {
  title: '',
  description: '',
  delivery_mode: 'online',
  location: '',
  meeting_url: '',
  duration_minutes: 60,
  price_centavos: 0,
  min_joiners: 1,
  max_joiners: 8,
};

export default function ClassesTab() {
  const [classes, setClasses] = useState<GroupClass[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** null = list, 'new' = a blank class, otherwise the id being edited. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The class whose sessions are open below the list. */
  const [openSessions, setOpenSessions] = useState<string | null>(null);

  const zone = viewerTimezone();

  function reload() {
    listMyClasses()
      .then(setClasses)
      .catch((err: Error) => setError(err.message));
  }

  useEffect(reload, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (classes === null) return <div className="spinner" aria-label="Loading" />;

  if (editing) {
    return (
      <ClassForm
        existing={editing === 'new' ? null : (classes.find((c) => c.id === editing) ?? null)}
        onDone={() => {
          reload();
          setEditing(null);
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>Group classes</h2>
        <button type="button" className="btn btn-accent small" onClick={() => setEditing('new')}>
          New class
        </button>
      </div>

      {classes.length === 0 && (
        <p className="muted">
          No classes yet. A group class is one session many people join at the same time —
          online or in a room — with a cap on how many.
        </p>
      )}

      {classes.map((c) => (
        <div key={c.id} className="card" style={{ marginBottom: '0.6rem', opacity: c.is_active ? 1 : 0.6 }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <strong>{c.title}</strong>
              {!c.is_active && <span className="small muted"> · not on sale</span>}
              <p className="small muted" style={{ margin: '0.2rem 0 0' }}>
                {MODE_LABEL[c.delivery_mode]} · {c.duration_minutes} min ·{' '}
                {priceLabel(c)} · up to {c.max_joiners}
                {/* Said in full rather than as a bare number, because the
                    number alone reads as a rule that is enforced. */}
                {c.min_joiners > 1 && (
                  <span> · runs with {c.min_joiners}+, but goes ahead either way</span>
                )}
              </p>
            </div>
            <div className="row" style={{ gap: '0.4rem' }}>
              <button
                type="button"
                className="btn btn-ghost btn-small"
                onClick={() => setOpenSessions(openSessions === c.id ? null : c.id)}
              >
                {openSessions === c.id ? 'Close' : 'Dates'}
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => setEditing(c.id)}
              >
                Edit
              </button>
            </div>
          </div>

          {openSessions === c.id && <SessionList cls={c} zone={zone} onChanged={reload} />}
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

/** The occurrences of one class, and who is on each. */
function SessionList({
  cls,
  zone,
  onChanged,
}: {
  cls: GroupClass;
  zone: string;
  onChanged: () => void;
}) {
  const [sessions, setSessions] = useState<ClassSession[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);

  function reload() {
    listMyClassSessions(cls.id)
      .then(setSessions)
      .catch((err: Error) => setError(err.message));
  }

  useEffect(reload, [cls.id]);

  async function add() {
    if (!when) return;
    setBusy(true);
    setError(null);
    try {
      // The input is zoneless local time; the browser's zone is what someone
      // typing "7pm" means.
      await scheduleMyClassSession(cls.id, new Date(when).toISOString());
      setWhen('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not schedule that');
    } finally {
      setBusy(false);
    }
  }

  async function cancel(session: ClassSession) {
    const taken = session.seatsTaken;
    const warning =
      taken > 0
        ? `${taken} ${taken === 1 ? 'person has' : 'people have'} a place in this session. ` +
          'Cancelling frees their seats but does NOT refund them — Hilom does that by hand. ' +
          'Continue?'
        : 'Cancel this session?';
    if (!window.confirm(warning)) return;

    const reason = window.prompt('What should they be told? (optional)') ?? '';

    setBusy(true);
    setError(null);
    try {
      const result = await cancelMyClassSession(session.id, reason);
      reload();
      onChanged();
      setNotice(
        result.refundsOwed > 0
          ? `Cancelled. ${result.refundsOwed} ${result.refundsOwed === 1 ? 'person is' : 'people are'} owed ` +
            `${money(result.refundTotalCentavos)} — Hilom has been left to refund that by hand.`
          : 'Cancelled.',
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel that');
    } finally {
      setBusy(false);
    }
  }

  /**
   * A session snapshots the class's price when it is scheduled, so editing
   * the class afterwards leaves earlier dates carrying the old number —
   * silently, until this. Only reachable while nobody has joined (the row
   * below only shows the control then), and the backend re-checks it.
   */
  async function fixPrice(session: ClassSession) {
    const when = formatInZone(session.starts_at, zone, { dateStyle: 'medium', timeStyle: 'short' });
    // Pay-what-you-want has more than one number, so a prompt can't carry it —
    // the fix is "use the class's current pricing" for this date.
    if (cls.is_pay_what_you_want || session.is_pay_what_you_want) {
      if (!window.confirm(`Update ${when} to the class's current pricing (${priceLabel(cls)})?`)) return;
      setBusy(true);
      setError(null);
      try {
        await updateMyClassSessionPrice(session.id, cls.price_centavos, {
          is_pay_what_you_want: Boolean(cls.is_pay_what_you_want),
          min_centavos: cls.min_centavos ?? null,
          suggested_centavos: cls.suggested_centavos ?? [],
        });
        reload();
        setNotice('Pricing updated for that date.');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update that price');
      } finally {
        setBusy(false);
      }
      return;
    }

    const current = (session.price_centavos / 100).toFixed(2);
    const raw = window.prompt(
      `Correct the price for ${formatInZone(session.starts_at, zone, { dateStyle: 'medium', timeStyle: 'short' })}.\n\n` +
        `This changes only this date, not the class.`,
      current,
    );
    if (raw === null) return;
    const pesos = Number(raw);
    if (!Number.isFinite(pesos) || pesos < 0) {
      setError(`"${raw}" is not a valid price.`);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await updateMyClassSessionPrice(session.id, Math.round(pesos * 100));
      reload();
      setNotice('Price corrected for that date.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update that price');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: '0.75rem', borderTop: '1px solid var(--line)', paddingTop: '0.75rem' }}>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <div className="row" style={{ gap: '0.4rem', alignItems: 'flex-end', marginBottom: '0.75rem' }}>
        <label className="field" style={{ marginBottom: 0 }}>
          <span className="small">Add a date</span>
          <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy || !when}
          onClick={() => void add()}
        >
          Schedule
        </button>
      </div>

      {/* Stated standing, not only in the confirmation. A window.confirm is
          read by someone who has already decided, and half the time not read
          at all — this is the version a facilitator sees while they are still
          thinking about whether to cancel. */}
      {(sessions ?? []).some((s) => s.status === 'scheduled' && s.seatsTaken > 0) && (
        <p className="small muted" style={{ margin: '0 0 0.75rem' }}>
          Cancelling a date frees everyone's place but does not refund them — Hilom does
          that by hand. Give as much notice as you can.
        </p>
      )}

      {sessions === null ? (
        <div className="spinner" aria-label="Loading" />
      ) : sessions.length === 0 ? (
        <p className="small muted">No dates yet.</p>
      ) : (
        sessions.map((s) => (
          <div
            key={s.id}
            style={{
              padding: '0.5rem 0',
              borderBottom: '1px solid var(--line)',
              opacity: s.status === 'scheduled' ? 1 : 0.6,
            }}
          >
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <strong className="small">
                  {formatInZone(s.starts_at, zone, { dateStyle: 'medium', timeStyle: 'short' })}
                </strong>
                {s.status !== 'scheduled' && <span className="small muted"> · {s.status}</span>}
                <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                  {s.seatsTaken} of {s.capacity} joined
                  {/* Reported, never acted on. */}
                  {s.min_joiners > 1 && !s.meetsMinimum && (
                    <span> · below your {s.min_joiners}, still going ahead</span>
                  )}
                </p>
                {/* The class's price is written once and a date is scheduled
                    against it most weeks — this is what stops that snapshot
                    from going stale invisibly. This date's own price is what
                    it actually charges; the class's current price is shown
                    only when the two have come apart. */}
                <p className="small" style={{ margin: '0.15rem 0 0' }}>
                  {priceLabel(s)}
                  {!samePricing(s, cls) && (
                    <span className="muted">
                      {' '}
                      — the class is now {priceLabel(cls).toLowerCase()}
                    </span>
                  )}
                  {s.status === 'scheduled' && s.seatsTaken === 0 && (
                    <>
                      {' '}
                      ·{' '}
                      <button
                        type="button"
                        className="linklike small"
                        disabled={busy}
                        onClick={() => void fixPrice(s)}
                      >
                        Fix
                      </button>
                    </>
                  )}
                </p>
              </div>
              {s.status === 'scheduled' && (
                <button
                  type="button"
                  className="btn btn-ghost btn-small"
                  disabled={busy}
                  onClick={() => void cancel(s)}
                >
                  Cancel
                </button>
              )}
            </div>

            {(s.roster ?? []).length > 0 && (
              <ul className="small" style={{ margin: '0.35rem 0 0', paddingLeft: '1.1rem' }}>
                {(s.roster ?? []).map((r) => (
                  <li key={r.id}>
                    {r.client_name || r.client_email}
                    {r.status === 'pending_payment' && <span className="muted"> · still paying</span>}
                    {r.client_notes && <span className="muted"> — {r.client_notes}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function ClassForm({
  existing,
  onDone,
  onCancel,
}: {
  existing: GroupClass | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<GroupClassInput>(
    existing
      ? {
          title: existing.title,
          description: existing.description ?? '',
          delivery_mode: existing.delivery_mode,
          location: existing.location ?? '',
          meeting_url: existing.meeting_url ?? '',
          duration_minutes: existing.duration_minutes,
          price_centavos: existing.price_centavos,
          is_pay_what_you_want: Boolean(existing.is_pay_what_you_want),
          min_centavos: existing.min_centavos ?? null,
          suggested_centavos: existing.suggested_centavos ?? [],
          min_joiners: existing.min_joiners,
          max_joiners: existing.max_joiners,
          is_active: existing.is_active,
        }
      : BLANK,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof GroupClassInput>(key: K, value: GroupClassInput[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (existing) await updateMyClass(existing.id, draft);
      else await createMyClass(draft);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function deactivate() {
    if (!existing) return;
    if (!window.confirm('Take this class off sale? Dates already scheduled still go ahead.')) return;
    setBusy(true);
    try {
      const result = await deactivateMyClass(existing.id);
      if (result.upcomingSessions > 0) {
        window.alert(
          `Taken off sale. ${result.upcomingSessions} scheduled ${
            result.upcomingSessions === 1 ? 'date is' : 'dates are'
          } still going ahead — cancel them individually if you need to.`,
        );
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>{existing ? 'Edit class' : 'New class'}</h2>
        <div className="row" style={{ gap: '0.4rem' }}>
          <button type="button" className="btn btn-ghost small" onClick={onCancel}>
            Back
          </button>
          {existing?.is_active && (
            <button type="button" className="btn btn-ghost small" disabled={busy} onClick={() => void deactivate()}>
              Take off sale
            </button>
          )}
          <button type="button" className="btn btn-accent small" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save class'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <label className="field">
        <span>Title</span>
        <input
          value={draft.title}
          onChange={(e) => set('title', e.target.value)}
          placeholder="Thursday morning breathwork"
        />
      </label>

      <label className="field">
        <span>Description</span>
        <textarea
          rows={6}
          value={draft.description}
          onChange={(e) => set('description', e.target.value)}
          placeholder="What happens in the session, who it suits, what to bring."
        />
      </label>

      <div className="two-col">
        <label className="field">
          <span>Where</span>
          <select
            value={draft.delivery_mode}
            onChange={(e) => set('delivery_mode', e.target.value as GroupClassInput['delivery_mode'])}
          >
            <option value="online">Online</option>
            <option value="in_person">In person</option>
            <option value="both">Online or in person</option>
          </select>
        </label>
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
      </div>

      {draft.delivery_mode !== 'online' && (
        <label className="field">
          <span>Venue</span>
          <input
            value={draft.location}
            onChange={(e) => set('location', e.target.value)}
            placeholder="Studio address, or the area"
          />
        </label>
      )}

      {draft.delivery_mode !== 'in_person' && (
        <label className="field">
          <span>Joining link</span>
          <input
            value={draft.meeting_url}
            onChange={(e) => set('meeting_url', e.target.value)}
            placeholder="https://zoom.us/j/…"
          />
          <small className="muted">
            Only people who have paid ever see this. It is never on the public page.
          </small>
        </label>
      )}

      <label className="field" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        <input
          type="checkbox"
          style={{ width: 'auto' }}
          checked={Boolean(draft.is_pay_what_you_want)}
          onChange={(e) => {
            const on = e.target.checked;
            setDraft((d) => ({
              ...d,
              is_pay_what_you_want: on,
              min_centavos: on ? (d.min_centavos ?? (d.price_centavos || 10_000)) : null,
            }));
          }}
        />
        <span>Pay what you want (donation-based)</span>
      </label>

      {draft.is_pay_what_you_want ? (
        <div className="two-col">
          <label className="field">
            <span>Minimum (₱)</span>
            <input
              type="number"
              min={1}
              value={(draft.min_centavos ?? 0) / 100}
              onChange={(e) => set('min_centavos', Math.round(Number(e.target.value) * 100))}
            />
            <small className="muted">People can pay this or more. It can't be ₱0 — use a free class for that.</small>
          </label>
          <label className="field">
            <span>Suggested amounts (₱, optional)</span>
            <SuggestedInput
              value={draft.suggested_centavos ?? []}
              onChange={(next) => set('suggested_centavos', next)}
            />
            <small className="muted">Comma-separated, e.g. 300, 500, 800. Shown as quick-pick buttons.</small>
          </label>
        </div>
      ) : (
        <label className="field">
          <span>Price (₱)</span>
          <input
            type="number"
            min={0}
            // Stored in centavos, typed in pesos: nobody thinks in centavos, and
            // the conversion in one place is safer than in every reader.
            value={draft.price_centavos / 100}
            onChange={(e) => set('price_centavos', Math.round(Number(e.target.value) * 100))}
          />
          <small className="muted">Leave at 0 for a free class — people join without a checkout.</small>
        </label>
      )}

      <div className="two-col">
        <label className="field">
          <span>Minimum joiners</span>
          <input
            type="number"
            min={1}
            value={draft.min_joiners}
            onChange={(e) => set('min_joiners', Number(e.target.value))}
          />
          <small className="muted">
            A guide for you, and shown as “runs with {draft.min_joiners}+”. The class still goes
            ahead below it — nothing is cancelled or refunded automatically.
          </small>
        </label>
        <label className="field">
          <span>Maximum joiners</span>
          <input
            type="number"
            min={1}
            value={draft.max_joiners}
            onChange={(e) => set('max_joiners', Number(e.target.value))}
          />
          <small className="muted">This one is a real cap — the class sells out here.</small>
        </label>
      </div>
    </>
  );
}

/** Pesos typed as "300, 500" ↔ centavos. Keeps the raw text so typing a comma isn't eaten. */
function SuggestedInput({ value, onChange }: { value: number[]; onChange: (next: number[]) => void }) {
  const [text, setText] = useState(value.map((c) => c / 100).join(', '));
  return (
    <input
      value={text}
      placeholder="300, 500, 800"
      onChange={(e) => {
        setText(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((part) => Math.round(Number(part.trim()) * 100))
            .filter((c) => Number.isInteger(c) && c > 0),
        );
      }}
    />
  );
}
