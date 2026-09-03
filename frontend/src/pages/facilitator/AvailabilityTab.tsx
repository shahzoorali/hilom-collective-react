/**
 * Facilitator → Availability.
 *
 * Two things live here: the recurring weekly grid, and one-off blackouts.
 *
 * The grid is edited as a whole and saved in one call, matching how the backend
 * stores it (delete-then-insert rather than a per-row diff). That keeps the
 * "what am I actually offering" question answerable by looking at one screen,
 * which is the question a facilitator actually has.
 *
 * Times are entered in the facilitator's *own* timezone — the same zone the
 * rules are stored against — so what they type is what they mean. Clients see
 * these projected into their own zone by the slot engine.
 */
import { useEffect, useState } from 'react';
import {
  createMyBlackout,
  deleteMyBlackout,
  formatInZone,
  getMyAvailability,
  listMyBlackouts,
  listMyServices,
  previewMySlots,
  saveMyAvailability,
  type AvailabilityFinding,
  type AvailabilityWindow,
  type Blackout,
  type FacilitatorService,
  type SlotOption,
} from '../../lib/booking';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** 540 → "09:00", for a native <input type="time">. */
function toTimeValue(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function fromTimeValue(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * What a client would actually be offered, for one service, over two weeks.
 *
 * The reason this screen needs it: a facilitator sets weekly hours here, then
 * a buffer, a minimum notice, an advance window and a daily cap over in
 * Services — four interacting rules on top of this grid — and until now had no
 * way to see the result. The failure mode is silent. Twelve hours' notice plus
 * a two-hour buffer plus one session a day can produce an entirely empty
 * calendar, and the only symptom is that the bookings stop coming.
 *
 * When it is empty, the server says why (see previewAvailability in
 * backend/src/lib/scheduling.ts — the reasons are found by re-running the real
 * engine with one rule lifted, so they cannot drift from what it actually
 * does).
 */
function SlotPreview({ timezone }: { timezone: string }) {
  const [services, setServices] = useState<FacilitatorService[] | null>(null);
  const [serviceId, setServiceId] = useState<string>('');
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [findings, setFindings] = useState<AvailabilityFinding[]>([]);
  const [isLive, setIsLive] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    listMyServices()
      .then((list) => {
        setServices(list);
        // Default to the first service rather than making them choose before
        // they can see anything — most facilitators have one or two.
        if (list.length > 0) setServiceId((current) => current || list[0].id);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!serviceId) return;
    let live = true;
    setLoading(true);
    setError(null);
    const from = new Date();
    const to = new Date(from.getTime() + 14 * 86_400_000);
    previewMySlots(serviceId, from, to)
      .then((r) => {
        if (!live) return;
        setSlots(r.slots);
        setFindings(r.findings);
        setIsLive(r.isLive);
      })
      .catch((err: Error) => live && setError(err.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [serviceId]);

  if (services !== null && services.length === 0) return null;

  // Grouped by the facilitator's own local day, because that is the unit they
  // think in — "am I offering anything on Tuesday?" is the question.
  const byDay = new Map<string, SlotOption[]>();
  for (const slot of slots ?? []) {
    const day = formatInZone(slot.startsAt, timezone, { dateStyle: 'full', timeStyle: undefined });
    byDay.set(day, [...(byDay.get(day) ?? []), slot]);
  }

  return (
    <>
      <h2 style={{ marginTop: '2.5rem' }}>What clients see</h2>
      <p className="small muted">
        The next two weeks of bookable times, after your weekly hours, buffer, notice period,
        booking window, daily limit, time off and existing sessions have all been applied.
      </p>

      <label className="field" style={{ maxWidth: 420 }}>
        <span>For which session</span>
        <select value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
          {(services ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
              {s.is_active ? '' : ' (hidden)'}
            </option>
          ))}
        </select>
      </label>

      {error && <div className="alert alert-error">{error}</div>}
      {loading && <div className="spinner" aria-label="Loading" />}

      {!loading && !isLive && (
        <div className="alert alert-info">
          These times are correct, but nobody can book them yet — the service is hidden, or your
          profile is not published.
        </div>
      )}

      {!loading && findings.length > 0 && (
        <div className="alert alert-warning">
          <strong>No bookable times in the next two weeks.</strong>
          <ul className="small" style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
            {findings.map((f) => (
              <li key={f.rule}>{f.message}</li>
            ))}
          </ul>
        </div>
      )}

      {!loading && slots !== null && slots.length === 0 && findings.length === 0 && (
        <p className="muted">No bookable times in the next two weeks.</p>
      )}

      {[...byDay.entries()].map(([day, daySlots]) => (
        <div key={day} className="card" style={{ marginBottom: '0.5rem' }}>
          <strong className="small">{day}</strong>
          <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.4rem' }}>
            {daySlots.map((slot) => (
              <span key={slot.startsAt} className="pill">
                {formatInZone(slot.startsAt, timezone, { dateStyle: undefined, timeStyle: 'short' })}
              </span>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

export default function AvailabilityTab({ timezone }: { timezone: string }) {
  const [windows, setWindows] = useState<AvailabilityWindow[] | null>(null);
  const [blackouts, setBlackouts] = useState<Blackout[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [blackoutStart, setBlackoutStart] = useState('');
  const [blackoutEnd, setBlackoutEnd] = useState('');
  const [blackoutReason, setBlackoutReason] = useState('');

  function reload() {
    getMyAvailability()
      .then((r) => setWindows(r.windows))
      .catch((err: Error) => setError(err.message));
    listMyBlackouts()
      .then(setBlackouts)
      .catch((err: Error) => setError(err.message));
  }

  useEffect(() => reload(), []);

  function addWindow(weekday: number) {
    setWindows((current) => [
      ...(current ?? []),
      // 9am–12pm: a sane default that is almost always adjusted, and never a
      // zero-length window the validator would reject.
      { weekday, start_minute: 9 * 60, end_minute: 12 * 60 },
    ]);
  }

  function updateWindow(index: number, patch: Partial<AvailabilityWindow>) {
    setWindows((current) => (current ?? []).map((w, i) => (i === index ? { ...w, ...patch } : w)));
  }

  function removeWindow(index: number) {
    setWindows((current) => (current ?? []).filter((_, i) => i !== index));
  }

  async function save() {
    if (!windows) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveMyAvailability(windows);
      setWindows(result.windows);
      setNotice('Availability saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  async function addBlackout() {
    if (!blackoutStart || !blackoutEnd) return;
    setError(null);
    try {
      await createMyBlackout({
        starts_at: new Date(blackoutStart).toISOString(),
        ends_at: new Date(blackoutEnd).toISOString(),
        reason: blackoutReason || undefined,
      });
      setBlackoutStart('');
      setBlackoutEnd('');
      setBlackoutReason('');
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add');
    }
  }

  if (windows === null) return <div className="spinner" aria-label="Loading" />;

  return (
    <>
      <div className="admin-toolbar">
        <h2 style={{ margin: 0 }}>Availability</h2>
        <button type="button" className="btn btn-accent small" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save weekly hours'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <p className="small muted">
        Times are in your own timezone ({timezone}). Clients see them converted to theirs.
      </p>

      {DAYS.map((dayName, weekday) => {
        const dayWindows = windows
          .map((w, index) => ({ w, index }))
          .filter(({ w }) => w.weekday === weekday);

        return (
          <div key={weekday} className="card" style={{ marginBottom: '0.6rem' }}>
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
              <strong>{dayName}</strong>
              <button type="button" className="btn btn-ghost small" onClick={() => addWindow(weekday)}>
                + Add hours
              </button>
            </div>

            {dayWindows.length === 0 && (
              <p className="small muted" style={{ margin: '0.4rem 0 0' }}>Unavailable</p>
            )}

            {dayWindows.map(({ w, index }) => (
              <div key={index} className="row" style={{ gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
                <input
                  type="time"
                  value={toTimeValue(w.start_minute)}
                  onChange={(e) => updateWindow(index, { start_minute: fromTimeValue(e.target.value) })}
                />
                <span className="muted">to</span>
                <input
                  type="time"
                  value={toTimeValue(w.end_minute)}
                  onChange={(e) => updateWindow(index, { end_minute: fromTimeValue(e.target.value) })}
                />
                <button type="button" className="btn btn-ghost small" onClick={() => removeWindow(index)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        );
      })}

      <h2 style={{ marginTop: '2.5rem' }}>Time off</h2>
      <p className="small muted">
        Blocks new bookings in a date range. Sessions already booked in that range stay in your
        calendar — cancel those individually if you need to, so the client is told and refunded.
      </p>

      <div className="panel">
        <div className="two-col">
          <label className="field">
            <span>From</span>
            <input
              type="datetime-local"
              value={blackoutStart}
              onChange={(e) => setBlackoutStart(e.target.value)}
            />
          </label>
          <label className="field">
            <span>Until</span>
            <input
              type="datetime-local"
              value={blackoutEnd}
              onChange={(e) => setBlackoutEnd(e.target.value)}
            />
          </label>
        </div>
        <label className="field">
          <span>Reason (optional, only you see this)</span>
          <input value={blackoutReason} onChange={(e) => setBlackoutReason(e.target.value)} />
        </label>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!blackoutStart || !blackoutEnd}
          onClick={() => void addBlackout()}
        >
          Add time off
        </button>
      </div>

      {(blackouts ?? []).map((b) => (
        <div key={b.id} className="card" style={{ marginBottom: '0.5rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="small">
              {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(b.starts_at),
              )}{' '}
              –{' '}
              {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(
                new Date(b.ends_at),
              )}
              {b.reason && <span className="muted"> · {b.reason}</span>}
            </span>
            <button
              type="button"
              className="btn btn-ghost small"
              onClick={() => void deleteMyBlackout(b.id).then(reload)}
            >
              Remove
            </button>
          </div>
        </div>
      ))}

      {/* Last, deliberately: it is the answer to everything above it. */}
      <SlotPreview timezone={timezone} />
    </>
  );
}
