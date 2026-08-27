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
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { currentUser, login } from '../lib/auth';
import { money } from '../components/Layout';
import { REGISTRANT_FIELD_LABELS } from '../lib/cms';
import {
  getEventTicketing,
  registerForEvent,
  formatDueDate,
  formatEventDates,
  dueNow,
  type EventPlan,
  type TicketingResponse,
  type TicketedEvent,
} from '../lib/registrations';

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
          <img
            src={event.image_url}
            alt={event.image_alt ?? ''}
            style={{
              width: '100%',
              aspectRatio: '21 / 9',
              objectFit: 'cover',
              borderRadius: 'var(--radius)',
              margin: '2rem 0',
              display: 'block',
            }}
          />
        </div>
      )}

      {(event.description || event.venue_details) && (
        <section className="section">
          <div className="container" style={{ maxWidth: 760 }}>
            {event.description && <div dangerouslySetInnerHTML={{ __html: event.description }} />}
            {event.venue_details && (
              <p className="muted" style={{ marginTop: event.description ? '1.5rem' : 0 }}>
                {event.venue_details}
              </p>
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
                <img
                  key={i}
                  src={img.url}
                  alt={img.alt}
                  loading="lazy"
                  style={{ width: '100%', aspectRatio: '4 / 3', objectFit: 'cover', borderRadius: 'var(--radius)' }}
                />
              ))}
            </div>
          </div>
        </section>
      )}

      {event.facilitators.length > 0 && (
        <section className="section">
          <div className="container">
            <p className="badge">Facilitated By</p>
            <h2>Who's holding the space</h2>
            <div
              className="grid"
              style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', marginTop: '1.5rem' }}
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
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [onBehalf, setOnBehalf] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [medicalAck, setMedicalAck] = useState(false);
  const [consentAck, setConsentAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

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
        <div className="container">
          <div className="spinner" aria-label="Loading" />
        </div>
      </section>
    );
  }

  const { event, plans, placesRemaining, open } = data;

  if (!user) {
    return (
      <>
        <EventHeader event={event} />
        <section className="section" style={{ background: 'var(--cream)' }}>
          <div className="container" style={{ maxWidth: 560, textAlign: 'center' }}>
            <p className="badge">Join Us</p>
            <h2>Ready to reserve your place?</h2>
            <p className="lede" style={{ margin: '0 auto 1.5rem' }}>
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

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!eventId || !planId) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await registerForEvent(eventId, {
        planId,
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

  return (
    <>
      <EventHeader event={event} />

      <section className="section" style={{ background: 'var(--cream)' }}>
        <div className="container" style={{ maxWidth: 720 }}>
          <p className="badge">Reserve Your Place</p>
          <h2 style={{ marginBottom: '0.5rem' }}>How would you like to pay?</h2>

          {soldOut ? (
            <div className="panel">
              <p style={{ margin: 0 }}>
                Every place has been taken. Write to us at{' '}
                <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a> — we keep a
                list in case one frees up.
              </p>
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
                    onSelect={() => setPlanId(plan.id)}
                  />
                ))}
              </fieldset>

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
                <div style={{ display: 'grid', gap: 8 }}>
                  <div className="card" style={{ padding: 12, maxHeight: 220, overflowY: 'auto' }}>
                    <strong className="small">Liability &amp; participation consent</strong>
                    <div
                      className="small"
                      style={{ marginTop: 6 }}
                      dangerouslySetInnerHTML={{ __html: event.liability_consent_html }}
                    />
                  </div>
                  <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={consentAck}
                      onChange={(e) => setConsentAck(e.target.checked)}
                      style={{ width: 'auto', marginTop: 3 }}
                      required
                    />
                    <span>
                      I have read and agree to the liability and participation consent above, and I am taking
                      part in this event voluntarily and at my own risk.
                    </span>
                  </label>
                </div>
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
                  !agreed ||
                  (!!event.medical_disclaimer_html && !medicalAck) ||
                  (!!event.liability_consent_html && !consentAck)
                }
              >
                {submitting ? 'Reserving your place…' : selectedLabel(plans, planId)}
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
    </>
  );
}

function selectedLabel(plans: EventPlan[], planId: string): string {
  const plan = plans.find((p) => p.id === planId);
  if (!plan) return 'Choose how to pay';
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
}: {
  plan: EventPlan;
  selected: boolean;
  onSelect: () => void;
}) {
  const schedule = [...plan.installments].sort((a, b) => a.seq - b.seq);
  const upfront = dueNow(plan);

  return (
    <label
      className="card"
      style={{
        padding: 14,
        display: 'block',
        cursor: 'pointer',
        borderColor: selected ? 'var(--forest)' : 'var(--line)',
        borderWidth: selected ? 2 : 1,
        borderStyle: 'solid',
      }}
    >
      <span style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <input
          type="radio"
          name="plan"
          checked={selected}
          onChange={onSelect}
          style={{ width: 'auto', marginTop: 4 }}
        />
        <span style={{ flex: 1 }}>
          <strong>{plan.name}</strong>
          <span style={{ float: 'right' }}>{money(plan.total_centavos, plan.currency)}</span>
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
              Paid in full today.
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
