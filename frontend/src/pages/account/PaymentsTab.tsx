/**
 * `/account/payments` — everything you have paid Hilom, in one list.
 *
 * Merges two independent money trails that have never shared a screen before:
 * facilitator session payments (one lump sum per booking, no partial
 * payments) and event registration charges (which can be many per
 * registration, on a schedule). Neither system knows about the other, so this
 * is a read-only view built by fetching both and interleaving by date — there
 * is no shared "payments" table to query instead, and inventing one only to
 * back this list would be a lot of migration for what is fundamentally a
 * client-side sort.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { money } from '../../components/Layout';
import { currentUser } from '../../lib/auth';
import { listMyBookings, type Booking } from '../../lib/booking';
import { listMyRegistrations, type MyRegistration } from '../../lib/registrations';

interface PaymentRow {
  key: string;
  when: string;
  label: string;
  amountCentavos: number;
  currency: string;
  receiptHref: string | null;
  receiptLabel: string | null;
}

/** Bookings are one payment each, taken at confirmation — there is no
 *  separate paid_at on a booking, so created_at is the closest real date. */
function bookingRows(bookings: Booking[]): PaymentRow[] {
  return bookings
    .filter((b) => b.price_centavos > 0 && (b.status === 'confirmed' || b.status === 'completed'))
    .map((b) => ({
      key: `booking-${b.id}`,
      when: b.created_at,
      label: b.facilitator_services?.title ?? 'Session',
      amountCentavos: b.price_centavos,
      currency: b.currency,
      receiptHref: null,
      receiptLabel: null,
    }));
}

function registrationRows(registrations: MyRegistration[]): PaymentRow[] {
  return registrations.flatMap((r) =>
    r.charges
      .filter((c) => c.status === 'paid' && c.paid_at)
      .map((c) => ({
        key: `charge-${c.id}`,
        when: c.paid_at!,
        label: `${r.events?.title ?? 'Event'} — ${c.label}`,
        amountCentavos: c.amount_centavos,
        currency: c.currency,
        receiptHref: `/account/registrations/${r.id}/receipts/${c.id}`,
        receiptLabel: c.receipt_no,
      })),
  );
}

export default function PaymentsTab() {
  const user = currentUser();
  const [rows, setRows] = useState<PaymentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    Promise.all([listMyBookings().catch(() => []), listMyRegistrations().catch(() => [])])
      .then(([bookings, registrations]) => {
        const all = [...bookingRows(bookings), ...registrationRows(registrations)];
        all.sort((a, b) => Date.parse(b.when) - Date.parse(a.when));
        setRows(all);
      })
      .catch((err: Error) => setError(err.message));
  }, [user]);

  return (
    <div>
      <h1>Your payments</h1>

      {error && <div className="alert alert-error">{error}</div>}
      {rows === null && !error && <div className="spinner" aria-label="Loading" />}

      {rows?.length === 0 && (
        <div className="panel">
          <p style={{ margin: 0 }}>Nothing paid yet.</p>
        </div>
      )}

      {rows && rows.length > 0 && (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} style={{ borderTop: '1px solid var(--line)' }}>
                <td style={{ padding: '10px 0' }}>
                  <div>{row.label}</div>
                  <div className="small muted">
                    {new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeZone: 'Asia/Manila' }).format(
                      new Date(row.when),
                    )}
                    {row.receiptLabel && ` · ${row.receiptLabel}`}
                  </div>
                </td>
                <td style={{ padding: '10px 0', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {money(row.amountCentavos, row.currency)}
                </td>
                <td style={{ padding: '10px 0 10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {row.receiptHref && (
                    <Link className="linklike small" to={row.receiptHref}>
                      Receipt
                    </Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
