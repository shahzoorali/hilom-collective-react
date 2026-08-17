/**
 * The expanded detail panel for a single order, shown under its row in the
 * admin Orders table.
 *
 * Exists because the table row alone could not answer the questions support is
 * actually asked. Three things were missing:
 *
 *  - The PayMongo payment id, which the list endpoint already returned and the
 *    UI simply dropped. It is the key to everything on PayMongo's side.
 *  - The full `error_detail`. The row truncates it to 160 characters, which
 *    reliably cut off the part of the message that said what went wrong.
 *  - Anything at all about the transaction: our own tables record the amount
 *    and nothing else, so "was this GCash or a card?", "what did we net?" and
 *    "did the refund actually go through?" were unanswerable without opening
 *    the PayMongo dashboard.
 *
 * The transaction block is fetched lazily, once, when the panel first opens —
 * it is a live call out to PayMongo, so doing it for all 100 rows up front
 * would be both slow and pointless.
 */
import { useEffect, useState } from 'react';
import {
  adminGetOrderPayment,
  type AdminOrder,
  type OrderPaymentResult,
} from '../../lib/api';
import { money } from '../../components/Layout';

/**
 * PayMongo's dashboard URL for a single payment. Deep-linking saves support
 * from pasting ids into a search box, which is the whole point of showing the
 * id — but it is PayMongo's URL scheme, not ours, so the id is also rendered
 * as copyable text and the panel stays useful if this ever moves.
 */
const paymongoUrl = (paymentId: string) => `https://dashboard.paymongo.com/payments/${paymentId}`;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ord-copy"
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
    >
      {copied ? '✓ copied' : 'copy'}
    </button>
  );
}

/** One label/value pair. `mono` for ids, which are compared character by character. */
function Detail({
  label,
  children,
  mono,
}: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="ord-detail">
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
    </div>
  );
}

const NONE = <span className="muted">—</span>;

function relativeAge(iso: string) {
  const hours = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m ago`;
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function TransactionBlock({ result }: { result: OrderPaymentResult }) {
  if (!result.available) {
    return (
      <p className="small muted ord-unavailable">
        No transaction detail: {result.reason}
      </p>
    );
  }

  const p = result.payment;
  const currency = p.currency ?? 'PHP';
  const amount = (c: number | null) => (c === null ? NONE : money(c, currency));

  return (
    <>
      <dl className="ord-grid">
        <Detail label="Method">
          {p.method ? <span className="ord-method">{p.method}</span> : NONE}
        </Detail>
        <Detail label="PayMongo status">{p.status ?? NONE}</Detail>
        <Detail label="Paid at">
          {p.paid_at ? new Date(p.paid_at).toLocaleString() : NONE}
        </Detail>
        <Detail label="Gross">{amount(p.amount_centavos)}</Detail>
        <Detail label="PayMongo fee">
          {p.fee_centavos === null ? NONE : <span className="ord-fee">−{money(p.fee_centavos, currency)}</span>}
        </Detail>
        <Detail label="Net to you">
          {p.net_centavos === null ? NONE : <strong>{money(p.net_centavos, currency)}</strong>}
        </Detail>
        <Detail label="Billing name">{p.billing_name ?? NONE}</Detail>
        <Detail label="Billing email" mono>{p.billing_email ?? NONE}</Detail>
        <Detail label="Billing phone" mono>{p.billing_phone ?? NONE}</Detail>
      </dl>

      {/* Only rendered when refunds exist: an empty "Refunds" heading on every
          healthy order would be noise on the 99% of rows that never see one. */}
      {p.refunds.length > 0 && (
        <div className="ord-refunds">
          <h5 className="ord-subhead">
            Refunds — {money(p.refunded_centavos, currency)} total
          </h5>
          <ul>
            {p.refunds.map((r) => (
              <li key={r.id}>
                <span className="mono">{r.id}</span>
                {' · '}
                {r.amount_centavos === null ? '—' : money(r.amount_centavos, currency)}
                {' · '}
                <strong>{r.status ?? 'unknown'}</strong>
                {r.created_at && ` · ${new Date(r.created_at).toLocaleString()}`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

export default function OrderDetail({
  adminKey,
  order,
}: {
  adminKey: string;
  order: AdminOrder;
}) {
  const [payment, setPayment] = useState<OrderPaymentResult | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setPaymentError(null);
    adminGetOrderPayment(adminKey, order.id)
      .then((r) => {
        if (!cancelled) setPayment(r);
      })
      .catch((e: Error) => {
        // A failed PayMongo lookup must not hide the rest of the panel — the
        // internal fields below are exactly what you need when the payment
        // provider is the thing that is broken.
        if (!cancelled) setPaymentError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [adminKey, order.id]);

  return (
    <div className="ord-panel">
      <section className="ord-section">
        <h4 className="ord-head">Order</h4>
        <dl className="ord-grid">
          <Detail label="Product">
            {order.product_name ?? <span className="muted">unknown product</span>}
            {order.product_slug && <span className="ord-slug">/{order.product_slug}</span>}
          </Detail>
          <Detail label="Grants courses">
            {order.moodle_course_ids.length === 0 ? NONE : (
              <span className="ord-chips">
                {order.moodle_course_ids.map((id) => (
                  <span key={id} className="prod-chip">{id}</span>
                ))}
              </span>
            )}
          </Detail>
          <Detail label="Charged">{money(order.amount_centavos, order.currency)}</Detail>
          <Detail label="Placed">
            {new Date(order.created_at).toLocaleString()}
            <span className="ord-age">{relativeAge(order.created_at)}</span>
          </Detail>
          <Detail label="Last changed">
            {new Date(order.updated_at).toLocaleString()}
            <span className="ord-age">{relativeAge(order.updated_at)}</span>
          </Detail>
        </dl>
      </section>

      <section className="ord-section">
        <h4 className="ord-head">Identifiers</h4>
        <dl className="ord-grid">
          <Detail label="Order id" mono>
            {order.id}
            <CopyButton value={order.id} label="order id" />
          </Detail>
          <Detail label="PayMongo payment" mono>
            {order.paymongo_payment_id}
            <CopyButton value={order.paymongo_payment_id} label="payment id" />
            {order.paymongo_payment_id.startsWith('pay_') && (
              <a
                className="ord-link"
                href={paymongoUrl(order.paymongo_payment_id)}
                target="_blank"
                rel="noreferrer"
              >
                dashboard ↗
              </a>
            )}
          </Detail>
          {/* These two are the "paid but can't see the course" diagnosis: a null
              Moodle id means enrolment never ran, a null Cognito sub means they
              have no way to sign in even if the enrolment did. */}
          <Detail label="Moodle user" mono>
            {order.moodle_user_id ?? <span className="ord-missing">not created</span>}
          </Detail>
          <Detail label="Cognito sub" mono>
            {order.cognito_user_sub ?? <span className="ord-missing">not created</span>}
          </Detail>
        </dl>
      </section>

      {order.error_detail && (
        <section className="ord-section">
          <h4 className="ord-head">Failure detail</h4>
          {/* Full text, not the row's 160-character preview. */}
          <pre className="ord-error">{order.error_detail}</pre>
        </section>
      )}

      <section className="ord-section">
        <h4 className="ord-head">
          Transaction <span className="ord-source">live from PayMongo</span>
        </h4>
        {loading ? (
          <p className="small muted">Loading transaction…</p>
        ) : paymentError ? (
          <p className="small ord-unavailable">Could not reach PayMongo: {paymentError}</p>
        ) : payment ? (
          <TransactionBlock result={payment} />
        ) : null}
      </section>
    </div>
  );
}
