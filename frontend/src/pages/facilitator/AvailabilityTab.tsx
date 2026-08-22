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
  getMyAvailability,
  listMyBlackouts,
  saveMyAvailability,
  type AvailabilityWindow,
  type Blackout,
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
    </>
  );
}
