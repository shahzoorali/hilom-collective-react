/**
 * The client's multi-session packages, and booking a session out of one (0035).
 *
 * Sits above the bookings list because it is the thing with something owed on
 * it. A package is a right to schedule that nobody has scheduled yet, and the
 * failure mode it exists to prevent is someone buying six sessions, taking two,
 * and forgetting — so "four sessions left" needs to be the first thing on the
 * page, not a line inside a booking they have to find.
 *
 * Credits are counted server-side from live bookings rather than stored, so
 * cancelling a session simply makes one reappear here.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import SlotPicker from '../../components/SlotPicker';
import {
  createBooking,
  formatDuration,
  formatInZone,
  listMyPackages,
  payPackageCharge,
  viewerTimezone,
  type BookingPackage,
  type PackageCharge,
} from '../../lib/booking';

export default function PackagesPanel({ onBooked }: { onBooked: () => void }) {
  const [packages, setPackages] = useState<BookingPackage[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    listMyPackages()
      .then(setPackages)
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(() => reload(), [reload]);

  // Reminder emails link here with ?package=&pay=: open that checkout straight
  // away. ?paid= is PayMongo sending them back after paying.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const pkgId = q.get('package');
    const pay = q.get('pay');
    if (q.get('paid')) setNotice('Thank you, your payment is being confirmed. It can take a minute to show here.');
    if (pkgId && pay) {
      payPackageCharge(pkgId, pay)
        .then((r) => {
          window.location.href = r.checkoutUrl;
        })
        .catch((err: Error) => setError(err.message));
    }
  }, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  // Silent when there are none: most clients have never bought one, and an
  // empty "your packages" heading is a section about nothing.
  if (!packages || packages.length === 0) return null;

  return (
    <>
      <h2>Your packages</h2>
      {notice && <div className="alert alert-success">{notice}</div>}
      {packages.map((p) => (
        <PackageCard
          key={p.id}
          pkg={p}
          open={openId === p.id}
          onToggle={() => setOpenId(openId === p.id ? null : p.id)}
          onBooked={() => {
            setOpenId(null);
            reload();
            onBooked();
          }}
        />
      ))}
    </>
  );
}

function PackageCard({
  pkg,
  open,
  onToggle,
  onBooked,
}: {
  pkg: BookingPackage;
  open: boolean;
  onToggle: () => void;
  onBooked: () => void;
}) {
  const [slot, setSlot] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zone = viewerTimezone();

  async function book() {
    if (!slot || !pkg.facilitators) return;
    setBusy(true);
    setError(null);
    try {
      await createBooking({
        facilitatorSlug: pkg.facilitators.slug,
        serviceId: pkg.service_id,
        startsAt: slot,
        // Spends a credit rather than opening a checkout — the money was
        // collected when the package was bought.
        packageId: pkg.id,
      });
      setSlot(null);
      onBooked();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not book that time');
    } finally {
      setBusy(false);
    }
  }

  const spent = pkg.remaining === 0;

  return (
    <div className="panel" style={{ marginBottom: '1rem' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <div>
          <strong>{pkg.facilitator_services?.title ?? 'Package'}</strong>
          {pkg.facilitators && (
            <p className="small muted" style={{ margin: '0.2rem 0 0' }}>
              with{' '}
              <Link to={`/facilitators/${pkg.facilitators.slug}`}>
                {pkg.facilitators.display_name}
              </Link>
              {pkg.facilitator_services && (
                <> · {formatDuration(pkg.facilitator_services.duration_minutes)} each</>
              )}
            </p>
          )}
        </div>
        <span className={spent ? 'pill' : 'pill pill-ok'}>
          {spent ? 'All used' : `${pkg.remaining} of ${pkg.sessions_total} left`}
        </span>
      </div>

      {pkg.plan_kind === 'installment' && pkg.charges && pkg.charges.length > 0 && (
        <PaymentSchedule packageId={pkg.id} charges={pkg.charges} zone={zone} />
      )}

      {!spent && pkg.facilitators && (
        <div style={{ marginTop: '0.75rem' }}>
          <button type="button" className="btn btn-accent small" onClick={onToggle}>
            {open ? 'Not now' : 'Book a session'}
          </button>

          {open && (
            <>
              <SlotPicker
                facilitatorSlug={pkg.facilitators.slug}
                serviceId={pkg.service_id}
                facilitatorTimezone={pkg.facilitators.timezone}
                facilitatorName={pkg.facilitators.display_name}
                selected={slot}
                onSelect={setSlot}
              />

              {error && <div className="alert alert-error" style={{ marginTop: '1rem' }}>{error}</div>}

              {slot && (
                <div style={{ marginTop: '1.25rem' }}>
                  <p style={{ margin: '0 0 0.75rem' }}>
                    Book{' '}
                    <strong>
                      {formatInZone(slot, zone, { dateStyle: 'full', timeStyle: 'short' })}
                    </strong>
                    ? Nothing more to pay — this uses one of your {pkg.remaining} remaining
                    sessions.
                  </p>
                  <button
                    type="button"
                    className="btn btn-accent"
                    disabled={busy}
                    onClick={() => void book()}
                  >
                    {busy ? 'Booking…' : 'Confirm this session'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {spent && (
        <p className="small muted" style={{ margin: '0.5rem 0 0' }}>
          You have used all {pkg.sessions_total} sessions in this package.
          {pkg.facilitators && (
            <>
              {' '}
              <Link to={`/facilitators/${pkg.facilitators.slug}`}>Buy another</Link>.
            </>
          )}
        </p>
      )}
    </div>
  );
}

const STATE_PILL: Record<PackageCharge['state'], string> = {
  paid: 'pill pill-ok',
  pending: 'pill pill-warn',
  overdue: 'pill pill-bad',
  waived: 'pill',
  void: 'pill',
};

/** The instalment schedule: paid, pending and overdue, and a button for the next one. */
function PaymentSchedule({ packageId, charges, zone }: { packageId: string; charges: PackageCharge[]; zone: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const money = (c: number, cur: string) =>
    new Intl.NumberFormat('en-PH', { style: 'currency', currency: cur, minimumFractionDigits: 2 }).format(c / 100);
  const next = charges.find((c) => c.state === 'pending' || c.state === 'overdue');
  const outstanding = charges.filter((c) => c.state === 'pending' || c.state === 'overdue').reduce((s, c) => s + c.amount_centavos, 0);

  async function pay(c: PackageCharge) {
    setBusy(true);
    setError(null);
    try {
      const r = await payPackageCharge(packageId, c.id);
      window.location.href = r.checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the payment');
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <strong className="small">Payments</strong>
      <table className="small" style={{ width: '100%', marginTop: '0.3rem' }}>
        <tbody>
          {charges.map((c) => (
            <tr key={c.id}>
              <td>{c.label}</td>
              <td>{money(c.amount_centavos, c.currency)}</td>
              <td className="muted">
                {c.state === 'paid' && c.paid_at
                  ? `Paid ${formatInZone(c.paid_at, zone, { dateStyle: 'medium', timeStyle: undefined })}`
                  : c.due_at
                    ? `Due ${formatInZone(c.due_at, zone, { dateStyle: 'medium', timeStyle: 'short' })} (session ${c.due_session})`
                    : c.seq === 1
                      ? 'At checkout'
                      : `Due before session ${c.due_session}, once it's booked`}
              </td>
              <td>
                <span className={STATE_PILL[c.state]}>{c.state}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {error && <div className="alert alert-error">{error}</div>}
      {next && (
        <button type="button" className="btn btn-accent small" disabled={busy} onClick={() => void pay(next)} style={{ marginTop: '0.4rem' }}>
          {busy ? 'Opening…' : `Pay ${next.label.toLowerCase()} (${money(next.amount_centavos, next.currency)})`}
        </button>
      )}
      {outstanding > 0 && (
        <p className="small muted" style={{ margin: '0.3rem 0 0' }}>
          {money(outstanding, charges[0]!.currency)} still to pay. Your session reminders come separately and don't depend on payments.
        </p>
      )}
    </div>
  );
}
