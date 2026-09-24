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

/** Order-independent fingerprint of the grid, for the unsaved-changes check. */
function snapshot(windows: AvailabilityWindow[]): string {
  return JSON.stringify(
    windows
      .map(({ weekday, start_minute, end_minute }) => ({ weekday, start_minute, end_minute }))
      .sort((a, b) => a.weekday - b.weekday || a.start_minute - b.start_minute),
  );
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
    <section className="fs-card fs-section">
      <header className="fs-section-head fs-section-head--row">
        <div>
          <h2>What clients see</h2>
          <p>
            The next two weeks of bookable times, after your hours, buffer, notice, booking window,
            daily limit, time off and existing sessions are applied.
          </p>
        </div>
        <select className="fs-select" value={serviceId} onChange={(e) => setServiceId(e.target.value)} aria-label="For which session">
          {(services ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
              {s.is_active ? '' : ' (hidden)'}
            </option>
          ))}
        </select>
      </header>

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
        <p className="muted small">No bookable times in the next two weeks.</p>
      )}

      <div className="fs-slotdays">
        {[...byDay.entries()].map(([day, daySlots]) => (
          <div key={day} className="fs-slotday">
            <span className="fs-slotday-name">{day}</span>
            <div className="fs-slotday-times">
              {daySlots.map((slot) => (
                <span key={slot.startsAt} className="fs-chip">
                  {formatInZone(slot.startsAt, timezone, { dateStyle: undefined, timeStyle: 'short' })}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
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
      .then((r) => {
        setWindows(r.windows);
        setSaved(snapshot(r.windows));
      })
      .catch((err: Error) => setError(err.message));
    listMyBlackouts()
      .then(setBlackouts)
      .catch((err: Error) => setError(err.message));
  }

  useEffect(() => reload(), []);

  // Snapshot of what is saved, so the save bar can say when there is
  // something to save and the button is not a guess.
  const [saved, setSaved] = useState<string>('[]');
  const [copyFrom, setCopyFrom] = useState<number | null>(null);
  const [copyTargets, setCopyTargets] = useState<number[]>([]);

  function addWindow(weekday: number) {
    setWindows((current) => {
      const list = current ?? [];
      const same = list.filter((w) => w.weekday === weekday).sort((x, y) => x.end_minute - y.end_minute);
      const last = same[same.length - 1];
      // A second block starts an hour after the first ends, so the new row is
      // never an overlap the validator would reject; the first defaults to
      // 9am–5pm, a sane working day that is easy to trim.
      const start = last ? Math.min(last.end_minute + 60, 22 * 60) : 9 * 60;
      const end = last ? Math.min(start + 180, 24 * 60 - 1) : 17 * 60;
      return [...list, { weekday, start_minute: start, end_minute: end }];
    });
  }

  function updateWindow(index: number, patch: Partial<AvailabilityWindow>) {
    setWindows((current) => (current ?? []).map((w, i) => (i === index ? { ...w, ...patch } : w)));
  }

  function removeWindow(index: number) {
    setWindows((current) => (current ?? []).filter((_, i) => i !== index));
  }

  function toggleDay(weekday: number, on: boolean) {
    if (on) addWindow(weekday);
    else setWindows((current) => (current ?? []).filter((w) => w.weekday !== weekday));
  }

  /** Replace the target days' hours with a copy of one day's. */
  function copyDay(from: number, targets: number[]) {
    setWindows((current) => {
      const list = current ?? [];
      const source = list.filter((w) => w.weekday === from);
      return [
        ...list.filter((w) => !targets.includes(w.weekday)),
        ...targets.flatMap((weekday) => source.map((w) => ({ weekday, start_minute: w.start_minute, end_minute: w.end_minute }))),
      ];
    });
    setCopyFrom(null);
  }

  function applyPreset(days: number[], blocks: Array<[number, number]>) {
    setWindows(days.flatMap((weekday) => blocks.map(([s, e]) => ({ weekday, start_minute: s * 60, end_minute: e * 60 }))));
  }

  async function save() {
    if (!windows) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await saveMyAvailability(windows);
      setWindows(result.windows);
      setSaved(snapshot(result.windows));
      setNotice('Weekly hours saved');
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

  const dirty = snapshot(windows) !== saved;
  const openDays = DAYS.filter((_, d) => windows.some((w) => w.weekday === d)).length;
  const weeklyMinutes = windows.reduce((sum, w) => sum + Math.max(0, w.end_minute - w.start_minute), 0);
  // Monday-first, the way people plan a working week.
  const ORDER = [1, 2, 3, 4, 5, 6, 0];

  return (
    <div className="fs-page">
      <header className="fs-pagehead">
        <div>
          <h1>Availability</h1>
          <p>
            Your regular weekly hours, in your own timezone <span className="fs-tz">{timezone}</span>.
            Clients see them converted to theirs.
          </p>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <section className="fs-card fs-section">
        <header className="fs-section-head fs-section-head--row">
          <div>
            <h2>Weekly hours</h2>
            <p>
              {openDays === 0
                ? 'No hours set — nobody can book you yet.'
                : `${openDays} ${openDays === 1 ? 'day' : 'days'} a week · ${Math.round(weeklyMinutes / 6) / 10} hours open`}
            </p>
          </div>
          <div className="fs-presets" role="group" aria-label="Quick start">
            <span className="fs-presets-label">Quick start</span>
            <button type="button" className="fs-btn" onClick={() => applyPreset([1, 2, 3, 4, 5], [[9, 17]])}>Weekdays 9–5</button>
            <button type="button" className="fs-btn" onClick={() => applyPreset([1, 2, 3, 4, 5], [[9, 12], [13, 17]])}>With lunch break</button>
            <button type="button" className="fs-btn" onClick={() => applyPreset([1, 2, 3, 4, 5], [[18, 21]])}>Evenings</button>
            <button type="button" className="fs-btn" onClick={() => applyPreset([0, 6], [[9, 13]])}>Weekends only</button>
            <button type="button" className="fs-btn fs-btn--quiet" onClick={() => setWindows([])}>Clear</button>
          </div>
        </header>

        {/* The week at a glance: 6am–midnight, one lane per day. */}
        <div className="fs-week" aria-hidden="true">
          {ORDER.map((weekday) => (
            <div key={weekday} className="fs-week-lane">
              <span>{DAYS[weekday].slice(0, 3)}</span>
              <div className="fs-week-track">
                {windows
                  .filter((w) => w.weekday === weekday)
                  .map((w, i) => {
                    const from = Math.max(w.start_minute, 360);
                    const to = Math.min(w.end_minute, 1440);
                    if (to <= from) return null;
                    return (
                      <i
                        key={i}
                        style={{ left: `${((from - 360) / 1080) * 100}%`, width: `${((to - from) / 1080) * 100}%` }}
                      />
                    );
                  })}
              </div>
            </div>
          ))}
          <div className="fs-week-scale">
            <span>6am</span><span>12pm</span><span>6pm</span><span>12am</span>
          </div>
        </div>

        <ul className="fs-days">
          {ORDER.map((weekday) => {
            const dayName = DAYS[weekday];
            const dayWindows = windows
              .map((w, index) => ({ w, index }))
              .filter(({ w }) => w.weekday === weekday)
              .sort((x, y) => x.w.start_minute - y.w.start_minute);
            const on = dayWindows.length > 0;

            return (
              <li key={weekday} className={`fs-day${on ? '' : ' fs-day--off'}`}>
                <label className="fs-switch">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => toggleDay(weekday, e.target.checked)}
                    aria-label={`Available on ${dayName}`}
                  />
                  <span className="fs-switch-track" />
                  <span className="fs-day-name">{dayName}</span>
                </label>

                <div className="fs-day-blocks">
                  {!on && <span className="fs-day-off">Unavailable</span>}
                  {dayWindows.map(({ w, index }) => (
                    <div key={index} className="fs-block">
                      <input
                        type="time"
                        value={toTimeValue(w.start_minute)}
                        onChange={(e) => updateWindow(index, { start_minute: fromTimeValue(e.target.value) })}
                        aria-label={`${dayName} start`}
                      />
                      <span className="fs-block-dash">–</span>
                      <input
                        type="time"
                        value={toTimeValue(w.end_minute)}
                        onChange={(e) => updateWindow(index, { end_minute: fromTimeValue(e.target.value) })}
                        aria-label={`${dayName} end`}
                      />
                      <button
                        type="button"
                        className="fs-icon-btn"
                        onClick={() => removeWindow(index)}
                        aria-label="Remove these hours"
                        title="Remove"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <div className="fs-day-actions">
                  <button
                    type="button"
                    className="fs-icon-btn"
                    onClick={() => addWindow(weekday)}
                    aria-label={`Add hours on ${dayName}`}
                    title="Add hours"
                  >
                    ＋
                  </button>
                  {on && (
                    <button
                      type="button"
                      className="fs-icon-btn"
                      onClick={() => {
                        setCopyFrom(copyFrom === weekday ? null : weekday);
                        setCopyTargets([]);
                      }}
                      aria-label={`Copy ${dayName}'s hours to other days`}
                      aria-expanded={copyFrom === weekday}
                      title="Copy to other days"
                    >
                      ⧉
                    </button>
                  )}
                </div>

                {copyFrom === weekday && (
                  <div className="fs-copy">
                    <span className="fs-copy-title">Copy {dayName}'s hours to…</span>
                    <div className="fs-copy-days">
                      {ORDER.filter((d) => d !== weekday).map((d) => (
                        <label key={d} className={`fs-daychip${copyTargets.includes(d) ? ' is-on' : ''}`}>
                          <input
                            type="checkbox"
                            checked={copyTargets.includes(d)}
                            onChange={(e) =>
                              setCopyTargets((t) => (e.target.checked ? [...t, d] : t.filter((x) => x !== d)))
                            }
                          />
                          {DAYS[d].slice(0, 3)}
                        </label>
                      ))}
                    </div>
                    <div className="fs-copy-actions">
                      <button type="button" className="fs-btn fs-btn--quiet" onClick={() => setCopyTargets([1, 2, 3, 4, 5].filter((d) => d !== weekday))}>
                        Weekdays
                      </button>
                      <button type="button" className="fs-btn fs-btn--quiet" onClick={() => setCopyTargets(ORDER.filter((d) => d !== weekday))}>
                        Every day
                      </button>
                      <button
                        type="button"
                        className="fs-btn fs-btn--primary"
                        disabled={copyTargets.length === 0}
                        onClick={() => copyDay(weekday, copyTargets)}
                      >
                        Apply to {copyTargets.length || ''} {copyTargets.length === 1 ? 'day' : 'days'}
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="fs-card fs-section">
        <header className="fs-section-head">
          <h2>Time off</h2>
          <p>
            Blocks new bookings in a date range. Sessions already booked stay in your calendar —
            cancel those individually so the client is told and refunded.
          </p>
        </header>

        <div className="fs-timeoff-form">
          <label className="field">
            <span>From</span>
            <input type="datetime-local" value={blackoutStart} onChange={(e) => setBlackoutStart(e.target.value)} />
          </label>
          <label className="field">
            <span>Until</span>
            <input type="datetime-local" value={blackoutEnd} onChange={(e) => setBlackoutEnd(e.target.value)} />
          </label>
          <label className="field">
            <span>Reason (only you see this)</span>
            <input value={blackoutReason} onChange={(e) => setBlackoutReason(e.target.value)} placeholder="Retreat" />
          </label>
          <button
            type="button"
            className="fs-btn fs-btn--primary fs-timeoff-add"
            disabled={!blackoutStart || !blackoutEnd}
            onClick={() => void addBlackout()}
          >
            Add time off
          </button>
        </div>

        {(blackouts ?? []).length > 0 && (
          <ul className="fs-list">
            {(blackouts ?? []).map((b) => (
              <li key={b.id}>
                <span className="fs-list-icon" aria-hidden="true">🌴</span>
                <span className="fs-list-main">
                  {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(
                    new Date(b.starts_at),
                  )}{' '}
                  →{' '}
                  {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(
                    new Date(b.ends_at),
                  )}
                  {b.reason && <span className="muted"> · {b.reason}</span>}
                </span>
                <button
                  type="button"
                  className="fs-btn fs-btn--quiet"
                  onClick={() => void deleteMyBlackout(b.id).then(reload)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Last, deliberately: it is the answer to everything above it. */}
      <SlotPreview timezone={timezone} />

      <div className={`fs-savebar${dirty ? ' is-dirty' : ''}`}>
        <span>{dirty ? '● Unsaved changes to your weekly hours' : 'Weekly hours saved'}</span>
        <div className="row" style={{ gap: '0.5rem' }}>
          {dirty && (
            <button type="button" className="fs-btn fs-btn--quiet" onClick={() => setWindows(JSON.parse(saved) as AvailabilityWindow[])}>
              Discard
            </button>
          )}
          <button type="button" className="fs-btn fs-btn--primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save hours'}
          </button>
        </div>
      </div>
    </div>
  );
}
