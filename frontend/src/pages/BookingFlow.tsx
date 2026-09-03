/**
 * `/book/:slug/:serviceId` — pick a time, confirm, pay.
 *
 * The calendar itself lives in components/SlotPicker.tsx, shared with the
 * reschedule flow in AccountBookings so both offer the same times the same
 * way. What stays here is everything specific to a *new* booking: the account
 * gate, the client's note, and the handoff to PayMongo.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { money } from '../components/Layout';
import SlotPicker, { type SlotPickerHandle } from '../components/SlotPicker';
import { currentUser, login } from '../lib/auth';
import {
  createBooking,
  describeRefundPolicy,
  formatDuration,
  getFacilitator,
  viewerTimezone,
  zoneLabel,
  type Facilitator,
  type FacilitatorService,
} from '../lib/booking';

export default function BookingFlow() {
  const { slug = '', serviceId = '' } = useParams();
  const navigate = useNavigate();
  const user = currentUser();

  const [facilitator, setFacilitator] = useState<Facilitator | null>(null);
  const [service, setService] = useState<FacilitatorService | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selectedSlot, setSelectedSlot] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const pickerRef = useRef<SlotPickerHandle>(null);
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
      pickerRef.current?.reload();
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
          {loadError ? <p className="muted">That session isn't available.</p> : <div className="spinner" aria-label="Loading" />}
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

  // Same reasoning as Checkout.tsx: an unannounced bounce to
  // auth.hilomcollective.com at the moment of commitment reads as a surprise.
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
            <p className="small muted" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
              Stuck? <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a> is a
              real inbox we check.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 720 }}>
        <Link to={`/facilitators/${facilitator.slug}`} className="linklike small">
          ← {facilitator.display_name}'s profile
        </Link>

        <h1 style={{ marginTop: '0.75rem' }}>Choose a time</h1>
        {summary}

        <SlotPicker
          handleRef={pickerRef}
          facilitatorSlug={facilitator.slug}
          serviceId={serviceId}
          facilitatorTimezone={facilitator.timezone}
          facilitatorName={facilitator.display_name}
          selected={selectedSlot}
          onSelect={setSelectedSlot}
        />

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
            {/* Generated from the service's own thresholds, so what the client
                agrees to here is exactly what a later cancellation applies. The
                facilitator's free text follows as their own notes. */}
            <p className="small muted" style={{ marginTop: '0.5rem', marginBottom: 0 }}>
              {describeRefundPolicy(service)}
            </p>
            {service.cancellation_policy && (
              <p className="small muted" style={{ marginTop: '0.25rem', marginBottom: 0 }}>
                {service.cancellation_policy}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
