/**
 * Registering for a ticketed event.
 *
 * Two decisions shape this page.
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
 * The event's own marketing content — image, subtitle, description, location
 * and dates — shown identically whether or not someone is signed in.
 *
 * Split out because it renders in three places (signed-out, closed/sold-out,
 * and the registration form itself): whoever lands on this page from the
 * events listing or a shared link should see what they are registering for
 * before being asked to sign in, not after.
 */
function EventHeader({ event }: { event: TicketedEvent }) {
  return (
    <>
      {event.image_url && (
        <img
          src={event.image_url}
          alt={event.image_alt ?? ''}
          style={{ width: '100%', borderRadius: 'var(--radius)', marginBottom: 18, aspectRatio: '16/9', objectFit: 'cover' }}
        />
      )}
      <h1 style={{ marginBottom: event.subtitle ? 2 : 4 }}>{event.title}</h1>
      {event.subtitle && (
        <p className="muted" style={{ marginTop: 0, fontSize: '1.05em' }}>
          {event.subtitle}
        </p>
      )}
      <p className="small" style={{ fontWeight: 600, color: 'var(--forest)' }}>
        {formatEventDates(event.starts_at, event.ends_at)}
        {event.location && ` · ${event.location}`}
      </p>
      {event.description && <div dangerouslySetInnerHTML={{ __html: event.description }} />}
      {event.venue_details && <p className="muted">{event.venue_details}</p>}

      {event.gallery.length > 0 && (
        <div
          className="grid"
          style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 8, margin: '18px 0' }}
        >
          {event.gallery.map((img, i) => (
            <img
              key={i}
              src={img.url}
              alt={img.alt}
              style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 8 }}
            />
          ))}
        </div>
      )}

      {event.facilitators.length > 0 && (
        <div style={{ margin: '18px 0' }}>
          <h3 style={{ marginBottom: 12 }}>Facilitated by</h3>
          <div style={{ display: 'grid', gap: 16 }}>
            {event.facilitators.map((f, i) => (
              <div key={i} style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
                {f.photo_url && (
                  <img
                    src={f.photo_url}
                    alt={f.photo_alt ?? f.name}
                    style={{ width: 72, height: 72, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
                  />
                )}
                <div>
                  <strong>{f.name}</strong>
                  {f.title && (
                    <>
                      <br />
                      <span className="small muted">{f.title}</span>
                    </>
                  )}
                  {f.bio && <p className="small" style={{ marginTop: 6 }}>{f.bio}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
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
  const [agreed, setAgreed] = useState(false);
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
      <section className="section">
        <div className="container" style={{ maxWidth: 560 }}>
          <EventHeader event={event} />
          <div className="panel">
            <p style={{ marginTop: 0 }}>
              Sign in to reserve your place. You will need an account to manage your payments later.
            </p>
            <button
              type="button"
              className="btn btn-accent btn-block"
              onClick={() => void login(`/events/${eventId}/register`)}
            >
              Continue with your Hilom account
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (!open || plans.length === 0) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 640 }}>
          <EventHeader event={event} />
          <div className="panel">
            <p style={{ margin: 0 }}>
              Registration for this event is closed. Write to us at{' '}
              <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a> if you would
              like to be told about the next one.
            </p>
          </div>
        </div>
      </section>
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
        registrant: { name: name.trim(), email: email.trim(), phone: phone.trim() || undefined, details: extras },
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
    <section className="section">
      <div className="container" style={{ maxWidth: 720 }}>
        <EventHeader event={event} />

        {soldOut ? (
          <div className="panel">
            <p style={{ margin: 0 }}>
              Every place has been taken. Write to us at{' '}
              <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a> — we keep a
              list in case one frees up.
            </p>
          </div>
        ) : (
          <p className="small">
            <span className="pill pill-warn">
              {placesRemaining} {placesRemaining === 1 ? 'place' : 'places'} left
            </span>
          </p>
        )}

        {!soldOut && (
          <form className="panel" onSubmit={(e) => void onSubmit(e)} style={{ display: 'grid', gap: 18 }}>
            <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 10 }}>
              <legend style={{ fontWeight: 600, marginBottom: 6 }}>How would you like to pay?</legend>
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
                <span>Who is attending?</span>
                <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
              </label>
              <label className="field">
                <span>Their email</span>
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
                I understand my place is held for a short time while I pay, and that the amounts and dates
                above are what I am committing to.
              </span>
            </label>

            {error && <div className="alert alert-error">{error}</div>}

            <button type="submit" className="btn btn-accent btn-block" disabled={submitting || !planId || !agreed}>
              {submitting ? 'Reserving your place…' : selectedLabel(plans, planId)}
            </button>

            <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>
              You will be taken to PayMongo to pay by QR Ph. Nothing is charged until you complete it there.
            </p>
          </form>
        )}

        <p className="small muted">
          <button type="button" className="linklike" onClick={() => navigate('/events')}>
            ← Back to events
          </button>
        </p>
      </div>
    </section>
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
