/**
 * Pick a time from a facilitator's open slots.
 *
 * Extracted from BookingFlow so booking and rescheduling offer the same times
 * in the same way. They ask the same question of the same endpoint, and two
 * copies of a week-strip calendar would drift the first time either changed —
 * the same reasoning that keeps CommunityForm out of its own page.
 *
 * ## Why the picker looks like this
 *
 * A week strip of days plus a list of times, rather than a month grid. There is
 * no date-picker dependency in this project and adding one for this would bring
 * a component that renders every day of a month — including the ~80% with no
 * availability at all — and then needs fighting to look like the rest of the
 * site. A week of real, tappable times is less code, reads better on a phone,
 * and never shows a date that turns out to be unbookable.
 *
 * ## Timezones
 *
 * Times are rendered in the *viewer's* zone and labelled with it, with the
 * facilitator's zone shown alongside when the two differ. A Manila facilitator
 * with a client in Sydney is the normal case here, and an unlabelled "3:00 PM"
 * is exactly how someone misses their session.
 */
import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type Ref } from 'react';
import { getAvailability, viewerTimezone, zoneLabel, type SlotOption } from '../lib/booking';

const DAY_MS = 86_400_000;

/** The local calendar date of an instant, as `YYYY-MM-DD`, in a given zone. */
function dayKey(value: string | Date, timezone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** Lets a parent re-fetch after a failed write, so the grid reflects reality. */
export interface SlotPickerHandle {
  reload: () => void;
}

export default function SlotPicker({
  facilitatorSlug,
  serviceId,
  facilitatorTimezone,
  facilitatorName,
  selected,
  onSelect,
  handleRef,
}: {
  facilitatorSlug: string;
  serviceId: string;
  facilitatorTimezone: string;
  facilitatorName: string;
  selected: string | null;
  onSelect: (startsAt: string | null) => void;
  handleRef?: Ref<SlotPickerHandle>;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const viewerZone = viewerTimezone();

  useImperativeHandle(handleRef, () => ({ reload: () => setReloadKey((k) => k + 1) }), []);

  // The visible week. Starts from "now" rather than Monday so the first screen
  // is always the soonest bookable days, not a mostly-past week.
  const { from, to } = useMemo(() => {
    const start = new Date(Date.now() + weekOffset * 7 * DAY_MS);
    return { from: start, to: new Date(start.getTime() + 7 * DAY_MS) };
  }, [weekOffset]);

  const load = useCallback(() => {
    let live = true;
    setSlots(null);
    setError(null);
    getAvailability(facilitatorSlug, serviceId, from, to)
      .then((res) => live && setSlots(res.slots))
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [facilitatorSlug, serviceId, from, to]);

  useEffect(() => load(), [load, reloadKey]);

  const byDay = useMemo(() => {
    const map = new Map<string, SlotOption[]>();
    for (const slot of slots ?? []) {
      const key = dayKey(slot.startsAt, viewerZone);
      const list = map.get(key) ?? [];
      list.push(slot);
      map.set(key, list);
    }
    return map;
  }, [slots, viewerZone]);

  // Seven consecutive days from the window start, so empty days still render
  // as visibly empty rather than silently vanishing from the strip.
  const days = useMemo(() => {
    const out: { key: string; date: Date }[] = [];
    for (let i = 0; i < 7; i += 1) {
      const date = new Date(from.getTime() + i * DAY_MS);
      out.push({ key: dayKey(date, viewerZone), date });
    }
    return out;
  }, [from, viewerZone]);

  // Land on the first day that actually has times, so nobody has to hunt.
  useEffect(() => {
    if (!slots) return;
    if (selectedDay && byDay.has(selectedDay)) return;
    const firstWithSlots = days.find((d) => (byDay.get(d.key)?.length ?? 0) > 0);
    setSelectedDay(firstWithSlots?.key ?? null);
    onSelect(null);
    // onSelect is intentionally omitted: it is a parent setter, and including
    // it would re-run this whenever the parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slots, days, byDay, selectedDay]);

  const daySlots = selectedDay ? (byDay.get(selectedDay) ?? []) : [];
  const zonesDiffer = facilitatorTimezone !== viewerZone;
  const firstName = facilitatorName.split(' ')[0];

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <button
          type="button"
          className="btn btn-ghost small"
          onClick={() => setWeekOffset((w) => Math.max(0, w - 1))}
          disabled={weekOffset === 0}
        >
          ← Earlier
        </button>
        <span className="small muted">
          {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: viewerZone }).format(from)}
          {' – '}
          {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: viewerZone }).format(
            new Date(to.getTime() - DAY_MS),
          )}
        </span>
        <button type="button" className="btn btn-ghost small" onClick={() => setWeekOffset((w) => w + 1)}>
          Later →
        </button>
      </div>

      <div className="slot-days" role="tablist" aria-label="Choose a date">
        {days.map(({ key, date }) => {
          const count = byDay.get(key)?.length ?? 0;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selectedDay === key}
              className={`slot-day${selectedDay === key ? ' slot-day--active' : ''}`}
              disabled={count === 0}
              onClick={() => {
                setSelectedDay(key);
                onSelect(null);
              }}
            >
              <span className="slot-day__dow">
                {new Intl.DateTimeFormat('en-PH', { weekday: 'short', timeZone: viewerZone }).format(date)}
              </span>
              <span className="slot-day__num">
                {new Intl.DateTimeFormat('en-PH', { day: 'numeric', timeZone: viewerZone }).format(date)}
              </span>
              <span className="slot-day__count">{count > 0 ? `${count}` : '—'}</span>
            </button>
          );
        })}
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {slots === null && !error && <div className="spinner" aria-label="Loading times" />}

      {slots !== null && slots.length === 0 && (
        <p className="muted" style={{ marginTop: '1rem' }}>
          No times open this week. Try a later week.
        </p>
      )}

      {daySlots.length > 0 && (
        <>
          <p className="small muted" style={{ marginTop: '1.25rem', marginBottom: '0.5rem' }}>
            Times shown in your local time ({zoneLabel(viewerZone)})
            {zonesDiffer && <> · {firstName} is in {facilitatorTimezone}</>}
          </p>

          <div className="slot-times">
            {daySlots.map((slot) => (
              <button
                key={slot.startsAt}
                type="button"
                className={`btn ${selected === slot.startsAt ? 'btn-primary' : 'btn-ghost'} slot-time`}
                onClick={() => onSelect(slot.startsAt)}
              >
                {new Intl.DateTimeFormat('en-PH', {
                  timeStyle: 'short',
                  timeZone: viewerZone,
                }).format(new Date(slot.startsAt))}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
