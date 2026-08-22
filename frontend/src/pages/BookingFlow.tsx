/**
 * `/book/:slug/:serviceId` — pick a time, confirm, pay.
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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { money } from '../components/Layout';
import { currentUser, login } from '../lib/auth';
import {
  createBooking,
  formatDuration,
  getAvailability,
  getFacilitator,
  viewerTimezone,
  zoneLabel,
  type Facilitator,
  type FacilitatorService,
  type SlotOption,
} from '../lib/booking';

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

export default function BookingFlow() {
  const { slug = '', serviceId = '' } = useParams();
  const navigate = useNavigate();
  const user = currentUser();

  const [facilitator, setFacilitator] = useState<Facilitator | null>(null);
  const [service, setService] = useState<FacilitatorService | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [weekOffset, setWeekOffset] = useState(0);
  const [slots, setSlots] = useState<SlotOption[] | null>(null);
  const [slotsError, setSlotsError] = useState<string | null>(null);

  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const viewerZone = viewerTimezone();

  useEffect(() => {
    let live = true;
    getFacilitator(slug)
      .then((res) => {
        if (!live) return;
        setFacilitator(res.facilitator);
        setService(res.services.find((s) => s.id === serviceId) ?? null);
      })
      .catch((err: Error) => live && setLoadError(err.message));
    return () => {
      live = false;
    };
  }, [slug, serviceId]);

  // The visible week. Starts from "now" rather than Monday so the first screen
  // is always the soonest bookable days, not a mostly-past week.
  const { from, to } = useMemo(() => {
    const start = new Date(Date.now() + weekOffset * 7 * DAY_MS);
    return { from: start, to: new Date(start.getTime() + 7 * DAY_MS) };
  }, [weekOffset]);

  const loadSlots = useCallback(() => {
    if (!service) return () => undefined;
    let live = true;
    setSlots(null);
    setSlotsError(null);
    getAvailability(slug, serviceId, from, to)
      .then((res) => live && setSlots(res.slots))
      .catch((err: Error) => live && setSlotsError(err.message));
    return () => {
      live = false;
    };
  }, [slug, serviceId, service, from, to]);

  useEffect(() => loadSlots(), [loadSlots]);

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
    setSelectedSlot(null);
  }, [slots, days, byDay, selectedDay]);

  async function confirm() {
    if (!selectedSlot || !facilitator) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await createBooking({
        facilitatorSlug: facilitator.slug,
        serviceId,
        startsAt: selectedSlot,
        notes: notes.trim() || undefined,
      });

      if (result.free) {
        navigate(`/booking/processing?bookingId=${encodeURIComponent(result.bookingId)}`);
        return;
      }

      // Stashed for the same reason course checkout does it: PayMongo cannot
      // template an id into success_url, so the return screen reads it back.
      sessionStorage.setItem('hilom.pendingBooking', result.bookingId);
      window.location.href = result.checkoutUrl!;
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Something went wrong');
      setSubmitting(false);
      // The slot may have gone in the seconds since it was offered — reload so
      // the picker reflects reality rather than repeating the same failure.
      loadSlots();
      setSelectedSlot(null);
    }
  }

  if (loadError) {
    return (
      <section className="section">
        <div className="container"><div className="alert alert-error">{loadError}</div></div>
      </section>
    );
  }

  if (!facilitator || !service) {
    return (
      <section className="section">
        <div className="container">
          {slots === null && !loadError ? (
            <div className="spinner" aria-label="Loading" />
          ) : (
            <p className="muted">That session isn't available.</p>
          )}
        </div>
      </section>
    );
  }

  const isFree = service.price_centavos === 0;

  const summary = (
    <div className="panel" style={{ marginBottom: '1.5rem' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{service.title}</strong>
        <strong>{isFree ? 'Free' : money(service.price_centavos, service.currency)}</strong>
      </div>
      <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
        with {facilitator.display_name} · {formatDuration(service.duration_minutes)}
      </p>
    </div>
  );

  // Same anti-phishing reasoning as Checkout.tsx: an unannounced bounce to
  // amazoncognito.com at the moment of commitment reads as a scam.
  if (!user) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          <h1>Book a session</h1>
          {summary}
          <div className="panel">
            <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>First, your Hilom account</h2>
            <p>
              Your bookings, meeting links and receipts live in this account — so let's set it up
              before you choose a time.
            </p>
            <button
              className="btn btn-accent btn-block"
              type="button"
              onClick={() => void login(`/book/${slug}/${serviceId}`)}
            >
              Continue with your Hilom account
            </button>
          </div>
        </div>
      </section>
    );
  }

  const daySlots = selectedDay ? (byDay.get(selectedDay) ?? []) : [];
  const zonesDiffer = facilitator.timezone !== viewerZone;

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 720 }}>
        <Link to={`/facilitators/${facilitator.slug}`} className="linklike small">
          ← {facilitator.display_name}'s profile
        </Link>

        <h1 style={{ marginTop: '0.75rem' }}>Choose a time</h1>
        {summary}

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
                  setSelectedSlot(null);
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

        {slotsError && <div className="alert alert-error">{slotsError}</div>}
        {slots === null && !slotsError && <div className="spinner" aria-label="Loading times" />}

        {slots !== null && slots.length === 0 && (
          <p className="muted" style={{ marginTop: '1rem' }}>
            No times open this week. Try a later week.
          </p>
        )}

        {daySlots.length > 0 && (
          <>
            <p className="small muted" style={{ marginTop: '1.25rem', marginBottom: '0.5rem' }}>
              Times shown in your local time ({zoneLabel(viewerZone)})
              {zonesDiffer && <> · {facilitator.display_name.split(' ')[0]} is in {facilitator.timezone}</>}
            </p>

            <div className="slot-times">
              {daySlots.map((slot) => (
                <button
                  key={slot.startsAt}
                  type="button"
                  className={`btn ${selectedSlot === slot.startsAt ? 'btn-primary' : 'btn-ghost'} slot-time`}
                  onClick={() => setSelectedSlot(slot.startsAt)}
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

        {selectedSlot && (
          <div className="panel" style={{ marginTop: '2rem' }}>
            <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Confirm your session</h2>
            <p>
              <strong>
                {new Intl.DateTimeFormat('en-PH', {
                  dateStyle: 'full',
                  timeStyle: 'short',
                  timeZone: viewerZone,
                }).format(new Date(selectedSlot))}
              </strong>{' '}
              <span className="small muted">({zoneLabel(viewerZone)})</span>
            </p>

            <label className="field">
              <span>Anything you'd like {facilitator.display_name.split(' ')[0]} to know? (optional)</span>
              <textarea
                rows={3}
                value={notes}
                maxLength={2000}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="What brings you here, or anything you'd like to focus on."
              />
            </label>

            {submitError && <div className="alert alert-error">{submitError}</div>}

            <button
              type="button"
              className="btn btn-accent btn-block"
              disabled={submitting}
              onClick={() => void confirm()}
            >
              {submitting
                ? 'Holding your slot…'
                : isFree
                  ? 'Confirm your free call'
                  : `Pay ${money(service.price_centavos, service.currency)}`}
            </button>

            {!isFree && (
              <p className="small muted" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
                We'll hold this time for 20 minutes while you pay.
              </p>
            )}
            {service.cancellation_policy && (
              <p className="small muted" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
                {service.cancellation_policy}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
