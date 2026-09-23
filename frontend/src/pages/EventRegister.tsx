/**
 * Registering for a ticketed event.
 *
 * Built from the same layout primitives as Home.tsx — `.hero`, alternating
 * `.section` bands, `.split`, `.grid`/`.card` — rather than the narrow single
 * `.container` column this page used to be. A retreat page competing for
 * attention against a Squarespace landing page needs to look like the rest of
 * the site's marketing pages, not like a checkout form that happens to have a
 * description above it.
 *
 * Two decisions carry over unchanged from the previous version.
 *
 * **The instalment schedule is shown in full, before anyone commits.** Not
 * "₱5,000 today" with the rest in a confirmation email — the whole plan, with
 * real dates and real amounts, next to the option that takes it all at once.
 * Someone choosing to pay ₱30,000 across four months should be looking at
 * every one of those payments when they choose.
 *
 * **Places remaining is shown but never trusted.** The count comes from
 * outside the lock that actually allocates a place, so it is advisory by
 * construction and the server can still refuse. The page is written so that
 * refusal is an ordinary outcome with a clear message rather than an error
 * state — nothing has been charged at that point, and saying so matters.
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { currentUser, login } from '../lib/auth';
import { money } from '../components/Layout';
import { REGISTRANT_FIELD_LABELS } from '../lib/cms';
import { Skeleton, SkeletonText, SkeletonMedia, SkeletonBoundary } from '../components/Skeleton';
import {
  getEventTicketing,
  registerForEvent,
  joinEventWaitlist,
  checkEventPromo,
  formatDueDate,
  formatEventDates,
  dueNow,
  type EventGalleryImage,
  type EventPlan,
  type TicketingResponse,
  type TicketedEvent,
} from '../lib/registrations';

/**
 * The venue gallery at full size.
 *
 * Built on the native `<dialog>` rather than a hand-rolled overlay, because
 * `showModal()` already provides the three things such an overlay usually gets
 * wrong: focus is trapped inside it, Escape closes it, and it renders in the
 * top layer so nothing on the page can stack above it. That leaves only the
 * arrow keys and the click-outside-to-close to wire up by hand.
 *
 * The thumbnails are a 4:3 `object-fit: cover` crop; this shows the whole
 * frame instead, which is the actual point of enlarging a photo of a room.
 *
 * Nothing here listens for the native `close` event — see AgreementDialog for
 * why that was closing these dialogs milliseconds after they opened. The
 * "belt and braces" this used to have was catching its own teardown.
 */
function GalleryLightbox({
  images,
  index,
  onClose,
  onMove,
}: {
  images: EventGalleryImage[];
  index: number;
  onClose: () => void;
  onMove: (delta: number) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    // showModal() does not reliably stop the page behind from scrolling.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      if (el.open) el.close();
    };
  }, []);

  const image = images[index];
  if (!image) return null;

  return (
    <dialog
      ref={ref}
      className="lightbox"
      aria-label="Venue photographs"
      onCancel={onClose}
      // The dialog box fills the viewport, so anything that lands on the
      // dialog itself rather than the figure inside it is a click outside.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      onKeyDown={(e) => {
        // Escape is handled here rather than left to the browser so that React
        // stays the single source of truth for whether this is open. Letting
        // the dialog close natively takes the element out of the top layer
        // without unmounting the component, which strands the body scroll lock.
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
          return;
        }
        if (images.length < 2) return;
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onMove(1);
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onMove(-1);
        }
      }}
    >
      <button type="button" className="lightbox-close" onClick={onClose} aria-label="Close">
        ✕
      </button>

      {images.length > 1 && (
        <button
          type="button"
          className="lightbox-nav lightbox-prev"
          onClick={() => onMove(-1)}
          aria-label="Previous photograph"
        >
          ‹
        </button>
      )}

      <figure className="lightbox-figure">
        <img src={image.url} alt={image.alt} />
        {(image.alt || images.length > 1) && (
          <figcaption>
            {image.alt}
            {images.length > 1 && (
              <span className="lightbox-count">
                {index + 1} / {images.length}
              </span>
            )}
          </figcaption>
        )}
      </figure>

      {images.length > 1 && (
        <button
          type="button"
          className="lightbox-nav lightbox-next"
          onClick={() => onMove(1)}
          aria-label="Next photograph"
        >
          ›
        </button>
      )}
    </dialog>
  );
}

/**
 * The participant agreement, shown on demand rather than inline.
 *
 * The registration form links to this from the consent checkbox instead of
 * embedding the full text on the page: the agreement runs to a couple of
 * thousand words, and a scroll box that long buried in a form is read by
 * nobody. Opening it in a modal makes "read the agreement" a deliberate act,
 * which is also what lets the tick that follows it mean something.
 *
 * Same native <dialog> mechanics as GalleryLightbox — showModal() handles
 * focus trapping, Escape and top-layer stacking; the body scroll lock is done
 * by hand.
 *
 * Nothing listens for the native `close` event, by either route: it is
 * dispatched as a queued task, so the one fired by this effect's own teardown
 * landed *after* the effect had re-run — and under StrictMode's
 * mount/unmount/mount that closed the dialog a few milliseconds after it
 * opened. Removing the manual listener is not enough on its own, because the
 * `onClose` prop React was also carrying is a binding for that same event and
 * survives the remount. Every real way out of here — Escape via `onCancel`,
 * the ✕, a click on the backdrop margin — calls `onClose` directly.
 */
function AgreementDialog({
  title,
  html,
  onClose,
}: {
  title: string;
  html: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!el.open) el.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
      if (el.open) el.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="agreement-modal"
      aria-label={title}
      onCancel={onClose}
      // The dialog is not full-viewport, but a click that lands on the element
      // itself rather than its content is still a click on the backdrop margin.
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="agreement-modal-head">
        <strong>{title}</strong>
        <button type="button" className="agreement-modal-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      <div className="agreement-modal-body" dangerouslySetInnerHTML={{ __html: html }} />
    </dialog>
  );
}

/**
 * The event's own marketing content — hero, cover photo, description, gallery
 * and facilitators — identical whether or not someone is signed in. It fills
 * the width of the page: no `.container` wrapper here, because each block
 * inside sets its own, the same way Home.tsx alternates full-bleed section
 * backgrounds with a centered content column.
 *
 * Rendered in all three states (signed-out, closed/sold-out, and the
 * registration form itself) so that whoever lands here from the events
 * listing or a shared link sees what they are registering for before being
 * asked to sign in, not after.
 */
function EventHeader({ event }: { event: TicketedEvent }) {
  const [lightbox, setLightbox] = useState<number | null>(null);
  const move = (delta: number) =>
    setLightbox((i) =>
      i === null ? i : (i + delta + event.gallery.length) % event.gallery.length,
    );

  return (
    <>
      <section className="hero">
        <div className="container">
          {event.subtitle && <p className="badge">{event.subtitle}</p>}
          <h1>{event.title}</h1>
          <p className="lede" style={{ fontWeight: 600, color: 'var(--forest)' }}>
            {formatEventDates(event.starts_at, event.ends_at)}
            {event.location && ` · ${event.location}`}
          </p>
        </div>
      </section>

      {event.image_url && (
        <div className="container">
          <div className="event-poster">
            {/* Decorative only — the real image is the <img> below, and this
                is the same file again, blurred, so a portrait poster sits on
                its own colours instead of on grey bars. */}
            <div
              className="event-poster__backdrop"
              aria-hidden="true"
              style={{ backgroundImage: `url(${JSON.stringify(event.image_url)})` }}
            />
            <img src={event.image_url} alt={event.image_alt ?? ''} />
          </div>
        </div>
      )}

      {(event.description || event.venue_details) && (
        <section className="section">
          {/* 680, not the 760 the rest of the page uses: this is the one block
              of long-form prose on the page, and 760px of 16px text runs to
              ~85 characters a line — past comfortable reading. */}
          <div className="container" style={{ maxWidth: 680 }}>
            {event.description && (
              <div className="event-prose" dangerouslySetInnerHTML={{ __html: event.description }} />
            )}
            {event.venue_details && (
              <div className="event-note" style={{ marginTop: event.description ? undefined : 0 }}>
                <p>{event.venue_details}</p>
              </div>
            )}
          </div>
        </section>
      )}

      {event.gallery.length > 0 && (
        <section className="section" style={{ background: 'var(--cream)' }}>
          <div className="container">
            <p className="badge">The Venue</p>
            <h2>Where you'll be staying</h2>
            <div
              className="grid"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', marginTop: '1.5rem' }}
            >
              {event.gallery.map((img, i) => (
                <button
                  key={i}
                  type="button"
                  className="gallery-thumb"
                  onClick={() => setLightbox(i)}
                  aria-label={img.alt ? `Enlarge: ${img.alt}` : `Enlarge photograph ${i + 1}`}
                >
                  <img src={img.url} alt={img.alt} loading="lazy" />
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      {lightbox !== null && (
        <GalleryLightbox
          images={event.gallery}
          index={lightbox}
          onClose={() => setLightbox(null)}
          onMove={move}
        />
      )}

      {event.facilitators.length > 0 && (
        <section className="section">
          <div className="container">
            <p className="badge">Facilitated By</p>
            <h2>Who's holding the space</h2>
            <div
              className="grid"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', marginTop: '1.5rem' }}
            >
              {event.facilitators.map((f, i) => (
                <div key={i} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                  {f.photo_url && (
                    <img
                      src={f.photo_url}
                      alt={f.photo_alt ?? f.name}
                      loading="lazy"
                      style={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', display: 'block' }}
                    />
                  )}
                  <div style={{ padding: '1.1rem' }}>
                    <h3 style={{ marginBottom: '0.15rem' }}>{f.name}</h3>
                    {f.title && (
                      <p className="small muted" style={{ margin: '0 0 0.6rem' }}>
                        {f.title}
                      </p>
                    )}
                    {f.bio && <p className="desc">{f.bio}</p>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}
    </>
  );
}

export default function EventRegister() {
  const { eventId } = useParams<{ eventId: string }>();
  const navigate = useNavigate();
  const user = currentUser();

  const [data, setData] = useState<TicketingResponse | null>(null);
  const [planId, setPlanId] = useState<string>('');
  // What the registrant typed into a pay-what-you-want box, in PESOS as typed.
  // Kept as the raw string rather than a number so that a half-typed "1." or an
  // empty box stays exactly what the person sees; it is converted to centavos
  // once, at submit.
  const [amount, setAmount] = useState<string>('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [onBehalf, setOnBehalf] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [medicalAck, setMedicalAck] = useState(false);
  const [consentAck, setConsentAck] = useState(false);
  const [agreementOpen, setAgreementOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [waitlistBusy, setWaitlistBusy] = useState(false);
  const [waitlistJoined, setWaitlistJoined] = useState(false);
  const [waitlistError, setWaitlistError] = useState<string | null>(null);
  const [promoInput, setPromoInput] = useState('');
  const [promo, setPromo] = useState<{
    code: string;
    discountCentavos: number;
    finalAmountCentavos: number;
    currency: string;
  } | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  const load = useCallback(() => {
    if (!eventId) return;
    getEventTicketing(eventId)
      .then((res) => {
        setData(res);
        // Preselect only when there is no choice to make. With two or more
        // plans the decision is the point of the page, and a preselected
        // radio is a decision made on someone's behalf.
        if (res.plans.length === 1) setPlanId(res.plans[0]!.id);
      })
      .catch((err: Error) => setError(err.message));
  }, [eventId]);

  useEffect(() => load(), [load]);

  // Prefill the attendee from the signed-in account, but leave every field
  // editable: booking a retreat for a partner is ordinary, and the attendee is
  // deliberately separable from the payer.
  useEffect(() => {
    if (user && !email) setEmail(user.email);
    if (user && !name) setName([user.givenName, user.familyName].filter(Boolean).join(' '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  if (error && !data) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 640 }}>
          <div className="alert alert-error">{error}</div>
        </div>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="section">
        <SkeletonBoundary label="Loading event" className="container" style={{ maxWidth: 720, display: 'grid', gap: '1.25rem' }}>
          <Skeleton height="2.6em" width="70%" />
          <Skeleton height="1em" width="45%" />
          <SkeletonMedia ratio="21 / 9" />
          <SkeletonText lines={3} />
        </SkeletonBoundary>
      </section>
    );
  }

  const { event, plans, placesRemaining, open } = data;

  if (!user) {
    const showPlans = open && plans.length > 0;
    const noPlaces = placesRemaining <= 0;
    return (
      <>
        <EventHeader event={event} />
        <section className="section" style={{ background: 'var(--cream)' }}>
          <div className="container" style={{ maxWidth: 720, textAlign: 'center' }}>
            <p className="badge">Join Us</p>
            <h2 style={{ marginBottom: showPlans ? '0.5rem' : undefined }}>Ready to reserve your place?</h2>

            {showPlans && (
              <>
                {!noPlaces && (
                  <p className="small" style={{ marginBottom: '1.5rem' }}>
                    <span className="pill pill-warn">
                      {placesRemaining} {placesRemaining === 1 ? 'place' : 'places'} left
                    </span>
                  </p>
                )}
                <div style={{ display: 'grid', gap: 10, textAlign: 'left', marginBottom: '1.75rem' }}>
                  {plans.map((plan) => (
                    <PlanOption key={plan.id} plan={plan} selected={false} onSelect={() => {}} readOnly />
                  ))}
                </div>
              </>
            )}

            <p className="lede" style={{ margin: '0 auto 1.5rem', maxWidth: 480 }}>
              Sign in to reserve your place. You will need an account to manage your payments later.
            </p>
            <button type="button" className="btn btn-accent" onClick={() => void login(`/events/${eventId}/register`)}>
              Continue with your Hilom account
            </button>
          </div>
        </section>
      </>
    );
  }

  if (!open || plans.length === 0) {
    return (
      <>
        <EventHeader event={event} />
        <section className="section" style={{ background: 'var(--cream)' }}>
          <div className="container" style={{ maxWidth: 640, textAlign: 'center' }}>
            <h2>Registration is closed</h2>
            <p>
              Write to us at <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a> if
              you would like to be told about the next one.
            </p>
          </div>
        </section>
      </>
    );
  }

  const soldOut = placesRemaining <= 0;

  const chosenPlan = plans.find((p) => p.id === planId) ?? null;
  const pwyw = chosenPlan?.is_pay_what_you_want === true;
  const promoEligible = !!chosenPlan && !pwyw && chosenPlan.kind === 'full';

  async function onApplyPromo() {
    if (!eventId || !planId) return;
    setPromoChecking(true);
    setPromoError(null);
    try {
      setPromo(await checkEventPromo(eventId, planId, promoInput.trim()));
    } catch (err) {
      setPromo(null);
      setPromoError(err instanceof Error ? err.message : 'That code could not be applied.');
    } finally {
      setPromoChecking(false);
    }
  }
  // Centavos, rounded rather than truncated: 100.999 typed into a peso box is a
  // person meaning ₱101, and Math.trunc would quietly take a centavo off them.
  const amountCentavos = amount.trim() === '' ? null : Math.round(Number(amount) * 100);
  const floorCentavos = Math.max(chosenPlan?.min_centavos ?? 0, 1);
  const amountValid =
    !pwyw ||
    (amountCentavos !== null &&
      Number.isFinite(amountCentavos) &&
      amountCentavos >= floorCentavos);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!eventId || !planId) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await registerForEvent(eventId, {
        planId,
        // Only for a pay-what-you-want plan. The server ignores it otherwise,
        // and re-validates it in either case — this is a convenience, not a
        // source of truth.
        ...(pwyw && amountCentavos !== null ? { amountCentavos } : {}),
        // Only a code that was applied and still fits the chosen plan.
        ...(promoEligible && promo ? { promoCode: promo.code } : {}),
        registrant: {
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim() || undefined,
          // `on_behalf_of` is collected here but not yet a recognised registrant
          // field on the backend, so validateRegistrant currently drops it.
          // Kept in the payload so it flows through once the column lands.
          details: { ...extras, ...(onBehalf.trim() ? { on_behalf_of: onBehalf.trim() } : {}) },
        },
      });
      // Stash before redirecting: PayMongo cannot template the registration id
      // into its return URL, so the processing screen reads it back from here.
      sessionStorage.setItem('hilom.pendingRegistration', result.registrationId);
      window.location.href = result.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Nothing has been charged.');
      setSubmitting(false);
      // A refusal is usually about availability, so refresh the count rather
      // than leaving a stale "3 places left" next to a sold-out message.
      load();
    }
  }

  async function onJoinWaitlist() {
    if (!eventId) return;
    setWaitlistBusy(true);
    setWaitlistError(null);
    try {
      await joinEventWaitlist(eventId, { name: name.trim() || undefined, phone: phone.trim() || undefined });
      setWaitlistJoined(true);
    } catch (err) {
      setWaitlistError(err instanceof Error ? err.message : 'Could not join the waitlist.');
    } finally {
      setWaitlistBusy(false);
    }
  }

  return (
    <>
      <EventHeader event={event} />

      <section className="section" style={{ background: 'var(--cream)' }}>
        <div className="container" style={{ maxWidth: 720 }}>
          <p className="badge">Reserve Your Place</p>
          <h2 style={{ marginBottom: '0.5rem' }}>How would you like to pay?</h2>

          {soldOut ? (
            <div className="panel">
              {waitlistJoined ? (
                <p style={{ margin: 0 }}>
                  You&rsquo;re on the waitlist. We&rsquo;ll email you the moment a place opens — first
                  come, first served, so register as soon as you get that email.
                </p>
              ) : (
                <>
                  <p style={{ margin: 0 }}>
                    Every place has been taken. Join the waitlist and we&rsquo;ll email you the moment
                    one opens up — it isn&rsquo;t held for you, so register quickly once you hear.
                  </p>
                  {waitlistError && (
                    <p className="small" style={{ color: 'var(--danger-fg, #b3261e)', marginTop: '0.75rem' }}>
                      {waitlistError}
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn btn-accent"
                    style={{ marginTop: '1rem' }}
                    disabled={waitlistBusy}
                    onClick={() => void onJoinWaitlist()}
                  >
                    {waitlistBusy ? 'Joining…' : 'Join the waitlist'}
                  </button>
                </>
              )}
            </div>
          ) : (
            <p className="small" style={{ marginBottom: '1.5rem' }}>
              <span className="pill pill-warn">
                {placesRemaining} {placesRemaining === 1 ? 'place' : 'places'} left
              </span>
            </p>
          )}

          {!soldOut && (
            <form className="panel" onSubmit={(e) => void onSubmit(e)} style={{ display: 'grid', gap: 18 }}>
              <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 10 }}>
                <legend style={{ fontWeight: 600, marginBottom: 6 }}>Choose a plan</legend>
                {plans.map((plan) => (
                  <PlanOption
                    key={plan.id}
                    plan={plan}
                    selected={planId === plan.id}
                    onSelect={() => { setPlanId(plan.id); setPromo(null); }}
                  />
                ))}
              </fieldset>

              {pwyw && chosenPlan && (
                <AmountChooser
                  plan={chosenPlan}
                  value={amount}
                  onChange={setAmount}
                  floorCentavos={floorCentavos}
                  valid={amountValid}
                />
              )}

              {/* Promo codes (0062): paying in full on a fixed price only. */}
              {promoEligible && (
                <div className="field">
                  <span>Promo code (optional)</span>
                  <div className="row" style={{ gap: 8 }}>
                    <input
                      value={promoInput}
                      onChange={(e) => {
                        setPromoInput(e.target.value);
                        setPromo(null);
                        setPromoError(null);
                      }}
                      maxLength={40}
                      style={{ textTransform: 'uppercase' }}
                    />
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!promoInput.trim() || promoChecking}
                      onClick={() => void onApplyPromo()}
                    >
                      {promoChecking ? 'Checking…' : 'Apply'}
                    </button>
                  </div>
                  {promo && (
                    <small>
                      {promo.code}: −{money(promo.discountCentavos, promo.currency)}, you pay{' '}
                      <strong>{money(promo.finalAmountCentavos, promo.currency)}</strong>
                    </small>
                  )}
                  {promoError && <small style={{ color: 'var(--danger-fg, #b3261e)' }}>{promoError}</small>}
                </div>
              )}

              <div className="row">
                <label className="field">
                  <span>Full Name</span>
                  <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
                </label>
                <label className="field">
                  <span>Email address</span>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    maxLength={320}
                  />
                </label>
              </div>

              <label className="field">
                <span>Contact number</span>
                <input value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} />
              </label>

              <fieldset style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 14, margin: 0 }}>
                <legend className="small" style={{ fontWeight: 600, padding: '0 6px' }}>
                  Registering on behalf of others (optional)
                </legend>
                <label className="field" style={{ margin: 0 }}>
                  <span className="small muted">
                    If you are signing up other people as well as, or instead of, yourself, list their full
                    names and email addresses here. We will contact them directly with joining details.
                  </span>
                  <textarea
                    rows={3}
                    value={onBehalf}
                    maxLength={1000}
                    onChange={(e) => setOnBehalf(e.target.value)}
                    placeholder="e.g. Jane Dela Cruz — jane@example.com&#10;Mark Santos — mark@example.com"
                  />
                </label>
              </fieldset>

              {event.registrant_fields.map((field) => (
                <label className="field" key={field}>
                  <span>{REGISTRANT_FIELD_LABELS[field] ?? field}</span>
                  <textarea
                    rows={2}
                    value={extras[field] ?? ''}
                    maxLength={500}
                    onChange={(e) => setExtras((prev) => ({ ...prev, [field]: e.target.value }))}
                  />
                </label>
              ))}

              {event.medical_disclaimer_html && (
                <div style={{ display: 'grid', gap: 8 }}>
                  <div className="card" style={{ padding: 12, maxHeight: 220, overflowY: 'auto' }}>
                    <strong className="small">Medical &amp; psychological disclaimer</strong>
                    <div
                      className="small"
                      style={{ marginTop: 6 }}
                      dangerouslySetInnerHTML={{ __html: event.medical_disclaimer_html }}
                    />
                  </div>
                  <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={medicalAck}
                      onChange={(e) => setMedicalAck(e.target.checked)}
                      style={{ width: 'auto', marginTop: 3 }}
                      required
                    />
                    <span>
                      I have read the medical and psychological disclaimer. Any physical, psychological, or
                      psychiatric condition relevant to my participation is disclosed in my medical notes above,
                      and I accept that Hilom Collective and its facilitators are not liable for conditions I
                      have not disclosed.
                    </span>
                  </label>
                </div>
              )}

              {event.liability_consent_html && (
                <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                  <input
                    type="checkbox"
                    checked={consentAck}
                    onChange={(e) => setConsentAck(e.target.checked)}
                    style={{ width: 'auto', marginTop: 3 }}
                    required
                  />
                  <span>
                    I have read and agree to the{' '}
                    <button type="button" className="linklike" onClick={() => setAgreementOpen(true)}>
                      Participant Agreement
                    </button>
                    , and I am taking part in this event voluntarily and at my own risk.
                  </span>
                </label>
              )}

              {event.terms_html && (
                <div className="card" style={{ padding: 12, maxHeight: 200, overflowY: 'auto' }}>
                  <div dangerouslySetInnerHTML={{ __html: event.terms_html }} />
                </div>
              )}

              <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  style={{ width: 'auto', marginTop: 3 }}
                  required
                />
                <span>
                  I understand my place is held for a short time while I pay, and that the amounts and
                  dates above are what I am committing to.
                </span>
              </label>

              {error && <div className="alert alert-error">{error}</div>}

              <button
                type="submit"
                className="btn btn-accent btn-block"
                disabled={
                  submitting ||
                  !planId ||
                  !amountValid ||
                  !agreed ||
                  (!!event.medical_disclaimer_html && !medicalAck) ||
                  (!!event.liability_consent_html && !consentAck)
                }
              >
                {submitting
                  ? 'Reserving your place…'
                  : selectedLabel(plans, planId, pwyw ? amountCentavos : null)}
              </button>

              <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>
                You will be taken to PayMongo to pay by QR Ph. Nothing is charged until you complete it there.
              </p>
            </form>
          )}

          <p className="small muted" style={{ textAlign: 'center', marginTop: '1.5rem' }}>
            <button type="button" className="linklike" onClick={() => navigate('/events')}>
              ← Back to events
            </button>
          </p>
        </div>
      </section>

      {agreementOpen && event.liability_consent_html && (
        <AgreementDialog
          title={`${event.title} — Participant Agreement`}
          html={event.liability_consent_html}
          onClose={() => setAgreementOpen(false)}
        />
      )}
    </>
  );
}

function selectedLabel(
  plans: EventPlan[],
  planId: string,
  chosenCentavos: number | null,
): string {
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return 'Choose how to pay';
  if (plan.is_pay_what_you_want) {
    // Until they have typed something the button cannot name a figure, and
    // inventing one — the minimum, say — would read as a price.
    if (chosenCentavos === null || !Number.isFinite(chosenCentavos)) {
      return 'Enter an amount to continue';
    }
    return `Reserve my place — pay ${money(chosenCentavos, plan.currency)} now`;
  }
  return `Reserve my place — pay ${money(dueNow(plan), plan.currency)} now`;
}

/**
 * One payment option, with its schedule spelled out.
 *
 * The whole schedule renders for an instalment plan rather than a summary
 * line. "₱5,000 now, then 3 payments" is a description; four dated rows are
 * the commitment, and this is the moment to show it.
 */
function PlanOption({
  plan,
  selected,
  onSelect,
  readOnly = false,
}: {
  plan: EventPlan;
  selected: boolean;
  onSelect: () => void;
  readOnly?: boolean;
}) {
  const schedule = [...plan.installments].sort((a, b) => a.seq - b.seq);
  const upfront = dueNow(plan);

  return (
    <label
      className="card"
      style={{
        padding: 14,
        display: 'block',
        cursor: readOnly ? 'default' : 'pointer',
        borderColor: selected ? 'var(--forest)' : 'var(--line)',
        borderWidth: selected ? 2 : 1,
        borderStyle: 'solid',
      }}
    >
      <span style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        {!readOnly && (
          <input
            type="radio"
            name="plan"
            checked={selected}
            onChange={onSelect}
            style={{ width: 'auto', marginTop: 4 }}
          />
        )}
        <span style={{ flex: 1 }}>
          <strong>{plan.name}</strong>
          {/* A pay-what-you-want plan has no price to show. Rendering
              total_centavos here is what made a donation-based class advertise
              itself as costing ₱1.00 — the column is a stored suggestion, not
              a figure anyone is being asked for. */}
          <span style={{ float: 'right' }}>
            {plan.is_pay_what_you_want
              ? 'You choose'
              : money(plan.total_centavos, plan.currency)}
          </span>
          {plan.description && (
            <>
              <br />
              <span className="small muted">{plan.description}</span>
            </>
          )}

          {plan.kind === 'installment' ? (
            <span style={{ display: 'block', marginTop: 10 }}>
              <span className="small">
                <strong>{money(upfront, plan.currency)}</strong> today, then:
              </span>
              <span style={{ display: 'block', marginTop: 6 }}>
                {schedule
                  .filter((i) => !i.is_deposit)
                  .map((inst) => (
                    <span
                      key={inst.seq}
                      className="small"
                      style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}
                    >
                      <span className="muted">
                        {inst.label}
                        {inst.due_at && ` — due ${formatDueDate(inst.due_at)}`}
                      </span>
                      <span>{money(inst.amount_centavos, plan.currency)}</span>
                    </span>
                  ))}
              </span>
              <span className="small muted" style={{ display: 'block', marginTop: 6 }}>
                You pay each one yourself from your account — nothing is charged automatically.
              </span>
            </span>
          ) : (
            <span className="small muted" style={{ display: 'block', marginTop: 6 }}>
              {plan.is_pay_what_you_want
                ? `Donation-based — you decide the amount. Minimum ${money(
                    Math.max(plan.min_centavos ?? 0, 1),
                    plan.currency,
                  )}.`
                : 'Paid in full today.'}
            </span>
          )}

          {plan.available_until && (
            <span className="small" style={{ display: 'block', marginTop: 8 }}>
              <span className="pill pill-warn">Available until {formatDueDate(plan.available_until)}</span>
            </span>
          )}
        </span>
      </span>
    </label>
  );
}

/**
 * The amount box for a pay-what-you-want plan.
 *
 * Presets and a free-entry field together, rather than either alone. The
 * buttons are what most people use and are the only reason an average donation
 * is more than the minimum; the box is what makes the offer honest, since a
 * grid of fixed buttons is just a price list with extra steps.
 *
 * The minimum is stated up front rather than enforced silently on submit.
 * Someone who types ₱20 into a ₱50 event should be told while they are looking
 * at the box, not after they press the button.
 *
 * Nothing here is authoritative. The server validates the amount against the
 * plan's own floor and the database re-checks it inside the row lock; this is
 * for the person's benefit, not the system's.
 */
function AmountChooser({
  plan,
  value,
  onChange,
  floorCentavos,
  valid,
}: {
  plan: EventPlan;
  value: string;
  onChange: (next: string) => void;
  floorCentavos: number;
  valid: boolean;
}) {
  const presets = (plan.suggested_centavos ?? []).filter((c) => c >= floorCentavos);
  // Pesos, as the box wants them. Whole amounts lose the ".00" so a preset
  // click leaves "100" in the field rather than "100.00".
  const toPesoString = (centavos: number) =>
    centavos % 100 === 0 ? String(centavos / 100) : (centavos / 100).toFixed(2);

  const typed = value.trim();
  const touched = typed !== '';
  const showError = touched && !valid;

  return (
    <div className="field" style={{ display: 'grid', gap: 8 }}>
      <span style={{ fontWeight: 600 }}>How much would you like to pay?</span>
      <span className="small muted" style={{ marginTop: -4 }}>
        This class is donation-based — you choose the amount. Minimum{' '}
        {money(floorCentavos, plan.currency)}.
      </span>

      {presets.length > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {presets.map((centavos) => {
            const asString = toPesoString(centavos);
            const active = typed === asString;
            return (
              <button
                key={centavos}
                type="button"
                className={active ? 'btn btn-small' : 'btn btn-secondary btn-small'}
                onClick={() => onChange(asString)}
              >
                {money(centavos, plan.currency)}
              </button>
            );
          })}
        </div>
      )}

      <label style={{ display: 'grid', gap: 4 }}>
        <span className="small muted">Or enter your own amount</span>
        <input
          type="number"
          inputMode="decimal"
          // `min` and `step` make a phone show a numeric keypad and let the
          // browser catch the obvious cases; neither is relied on.
          min={floorCentavos / 100}
          step="0.01"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={toPesoString(floorCentavos)}
          aria-label={`Amount in ${plan.currency}`}
          aria-invalid={showError || undefined}
        />
      </label>

      {showError && (
        <span className="small" style={{ color: 'var(--error, #a33)' }}>
          Please enter at least {money(floorCentavos, plan.currency)}.
        </span>
      )}
    </div>
  );
}
