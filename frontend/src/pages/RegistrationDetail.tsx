/**
 * `/account/registrations/:registrationId` — one registration and its payments.
 *
 * This is where every confirmation and reminder email points, so it has to
 * answer the three questions someone opens it with, in order: is my place
 * confirmed, what have I paid, and what do I still owe and when.
 *
 * **The whole schedule stays visible, paid rows included.** A schedule that
 * shrinks as it is paid is harder to reconcile against a bank statement than
 * one that stays put and gains ticks — and someone on their third reminder
 * wants to see the two that landed, not only the one that has not.
 *
 * **Only one charge is ever payable.** The server enforces that instalments
 * are settled in order and returns the id it will accept; this page offers
 * exactly that one, so a disabled-looking button never hides a refusal the
 * user cannot see the reason for.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { currentUser, login } from '../lib/auth';
import { money } from '../components/Layout';
import {
  getMyRegistration,
  payCharge,
  payBalance,
  formatDueDate,
  formatEventDates,
  isOutstanding,
  type MyRegistration,
  type RegistrationCharge,
} from '../lib/registrations';

const PENDING_KEY = 'hilom.pendingRegistration';

export default function RegistrationDetail() {
  const { registrationId } = useParams<{ registrationId: string }>();
  const user = currentUser();

  const [registration, setRegistration] = useState<MyRegistration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    // Not merely an optimization: fetching while signed out is what surfaced
    // the uncaught-throw bug above, and there is nothing to fetch anyway.
    if (!registrationId || !user) return;
    getMyRegistration(registrationId)
      .then(setRegistration)
      .catch((err: Error) => setError(err.message));
  }, [registrationId, user]);

  useEffect(() => load(), [load]);

  if (!user) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 520 }}>
          <div className="panel">
            <p style={{ marginTop: 0 }}>Sign in to see your registration and payments.</p>
            <button
              type="button"
              className="btn btn-accent btn-block"
              onClick={() => void login(`/account/registrations/${registrationId}`)}
            >
              Continue with your Hilom account
            </button>
          </div>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="section">
        <div className="container" style={{ maxWidth: 640 }}>
          <div className="alert alert-error">{error}</div>
          <p className="small">
            <Link to="/account/registrations">← All your registrations</Link>
          </p>
        </div>
      </section>
    );
  }

  if (!registration) {
    return (
      <section className="section">
        <div className="container">
          <div className="spinner" aria-label="Loading" />
        </div>
      </section>
    );
  }

  const { events: ev, charges, outstandingCentavos, paidCentavos, currency } = registration;

  /** Sends the buyer to PayMongo for one charge, or for the whole balance. */
  async function startPayment(kind: 'next' | 'balance', chargeId?: string) {
    if (!registrationId) return;
    setBusy(true);
    setError(null);
    try {
      const result =
        kind === 'balance'
          ? await payBalance(registrationId)
          : await payCharge(registrationId, chargeId!);
      // The processing screen reads this back — PayMongo cannot template the
      // registration id into its return URL.
      sessionStorage.setItem(PENDING_KEY, registrationId);
      window.location.href = result.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Nothing has been charged.');
      setBusy(false);
      // A refusal usually means the schedule moved underneath this page.
      load();
    }
  }

  const nextCharge = charges.find((c) => c.id === registration.nextChargeId) ?? null;
  const canPayBalance =
    registration.status === 'confirmed' &&
    charges.filter((c) => isOutstanding(c.status)).length > 1;

  return (
    <section className="section">
      <div className="container" style={{ maxWidth: 720 }}>
        <p className="small">
          <Link to="/account/registrations">← All your registrations</Link>
        </p>

        <h1 style={{ marginBottom: 4 }}>{ev?.title ?? 'Your registration'}</h1>
        {ev && (
          <p className="muted" style={{ marginTop: 0 }}>
            {formatEventDates(ev.starts_at, ev.ends_at)}
            {ev.location && ` · ${ev.location}`}
          </p>
        )}

        <StatusBanner registration={registration} />

        {error && <div className="alert alert-error">{error}</div>}

        <div className="panel" style={{ display: 'grid', gap: 14 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
            <div>
              <div className="small muted">Plan</div>
              <strong>{registration.plan_name}</strong>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="small muted">Paid</div>
              <strong>
                {money(paidCentavos, currency)}{' '}
                <span className="muted small">of {money(registration.total_centavos, currency)}</span>
              </strong>
            </div>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {[...charges]
                .sort((a, b) => a.seq - b.seq)
                .map((charge) => (
                  <ChargeRow
                    key={charge.id}
                    charge={charge}
                    isNext={charge.id === registration.nextChargeId}
                    busy={busy}
                    onPay={() => void startPayment('next', charge.id)}
                  />
                ))}
            </tbody>
          </table>

          {outstandingCentavos > 0 ? (
            <div style={{ display: 'grid', gap: 8 }}>
              {nextCharge && registration.status === 'confirmed' && (
                <button
                  type="button"
                  className="btn btn-accent btn-block"
                  disabled={busy}
                  onClick={() => void startPayment('next', nextCharge.id)}
                >
                  {busy
                    ? 'Opening payment…'
                    : `Pay ${money(nextCharge.amount_centavos, currency)} — ${nextCharge.label}`}
                </button>
              )}
              {canPayBalance && (
                <button
                  type="button"
                  className="btn btn-ghost btn-block"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Settle everything now — ${money(outstandingCentavos, currency)}?\n\n` +
                          'Your remaining payments will be replaced by this one. Nothing changes until the ' +
                          'payment goes through.',
                      )
                    ) {
                      void startPayment('balance');
                    }
                  }}
                >
                  Pay the remaining {money(outstandingCentavos, currency)} now
                </button>
              )}
              <p className="small muted" style={{ margin: 0, textAlign: 'center' }}>
                Paid by QR Ph through PayMongo. Nothing is charged until you complete it there.
              </p>
            </div>
          ) : (
            <p className="small" style={{ margin: 0 }}>
              <span className="pill pill-ok">Paid in full</span> Nothing further is due.
            </p>
          )}
        </div>

        <AttendeePanel registration={registration} />
      </div>
    </section>
  );
}

/** Where this registration stands, in one sentence. */
function StatusBanner({ registration }: { registration: MyRegistration }) {
  if (registration.status === 'pending_payment') {
    return (
      <div className="alert alert-info">
        Your place is held while your first payment goes through. If it lapses, the place goes back on sale
        — nothing is charged either way.
      </div>
    );
  }
  if (registration.status === 'cancelled') {
    return <div className="alert alert-error">This registration was cancelled.</div>;
  }
  if (registration.cancellation_requested_at && !registration.cancellation_decided_at) {
    return (
      <div className="alert alert-info">
        You have asked to cancel. Someone will be in touch — nothing has changed yet, and your place is
        still held.
      </div>
    );
  }
  if (registration.status === 'completed') {
    return <div className="alert alert-success">This event has taken place.</div>;
  }
  return (
    <div className="alert alert-success">
      Your place is confirmed. A missed payment never cancels it automatically — we would talk to you first.
    </div>
  );
}

function ChargeRow({
  charge,
  isNext,
  busy,
  onPay,
}: {
  charge: RegistrationCharge;
  isNext: boolean;
  busy: boolean;
  onPay: () => void;
}) {
  const overdue = isOutstanding(charge.status) && Date.parse(charge.due_at) < Date.now();

  return (
    <tr style={{ borderTop: '1px solid var(--line)' }}>
      <td style={{ padding: '10px 0' }}>
        <div>{charge.label}</div>
        <div className="small muted">
          {charge.status === 'paid' && charge.paid_at
            ? `Paid ${formatDueDate(charge.paid_at)}${charge.receipt_no ? ` · ${charge.receipt_no}` : ''}`
            : charge.is_deposit
              ? 'Due at registration'
              : `Due ${formatDueDate(charge.due_at)}`}
        </div>
      </td>
      <td style={{ padding: '10px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
        {money(charge.amount_centavos, charge.currency)}
      </td>
      <td style={{ padding: '10px 0 10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
        <ChargePill charge={charge} overdue={overdue} />
        {isNext && !busy && (
          <button type="button" className="linklike small" onClick={onPay} style={{ marginLeft: 8 }}>
            Pay
          </button>
        )}
      </td>
    </tr>
  );
}

function ChargePill({ charge, overdue }: { charge: RegistrationCharge; overdue: boolean }) {
  if (charge.status === 'paid') return <span className="pill pill-ok">Paid</span>;
  if (charge.status === 'waived') return <span className="pill">Waived</span>;
  // "No longer due" rather than "void": the word matters to someone who paid
  // their balance early and is looking at three rows they never paid.
  if (charge.status === 'void') return <span className="pill">No longer due</span>;
  if (charge.status === 'refunded') return <span className="pill">Refunded</span>;
  if (overdue) return <span className="pill pill-bad">Overdue</span>;
  return <span className="pill pill-warn">Due</span>;
}

/** Who is attending, and whatever the event asked them for. */
function AttendeePanel({ registration }: { registration: MyRegistration }) {
  const details = Object.entries(registration.registrant_details ?? {});
  return (
    <div className="panel">
      <strong>Who is attending</strong>
      <p style={{ margin: '6px 0 0' }}>
        {registration.registrant_name}
        <br />
        <span className="small muted">{registration.registrant_email}</span>
        {registration.registrant_phone && (
          <>
            <br />
            <span className="small muted">{registration.registrant_phone}</span>
          </>
        )}
      </p>
      {details.length > 0 && (
        <dl style={{ marginTop: 12, marginBottom: 0 }}>
          {details.map(([key, value]) => (
            <div key={key} style={{ marginBottom: 6 }}>
              <dt className="small muted" style={{ textTransform: 'capitalize' }}>
                {key.replace(/_/g, ' ')}
              </dt>
              <dd className="small" style={{ margin: 0 }}>
                {value}
              </dd>
            </div>
          ))}
        </dl>
      )}
      <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
        Need to change any of this, or send someone in your place? Write to{' '}
        <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a>.
      </p>
    </div>
  );
}
