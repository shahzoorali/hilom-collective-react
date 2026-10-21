/**
 * One person's history as a single timeline, oldest first.
 *
 * Admin → People already lists the records behind a person grouped by kind
 * (orders, registrations, bookings...). That answers "what do they have" but
 * not "what happened, in what order" — the question support actually asks
 * ("they say they paid on the 17th and heard nothing"). This folds the same
 * rows, plus the instalment ledger, reminder sends and PayMongo fee/net, into
 * dated events.
 *
 * Pure: it takes rows already loaded by the handler and returns items, so the
 * ordering and wording are testable without a database. Timestamps that are
 * null are simply not events, which is how a column like `cancelled_at` can be
 * read unconditionally.
 */

export type ActivityTone = 'ok' | 'warn' | 'bad' | 'info';

export interface ActivityItem {
  /** ISO timestamp. */
  at: string;
  kind: 'order' | 'event' | 'payment' | 'reminder' | 'class' | 'booking' | 'enquiry';
  title: string;
  detail?: string;
  amount_centavos?: number | null;
  currency?: string;
  tone: ActivityTone;
}

interface Row extends Record<string, any> {}

export interface ActivityInput {
  email: string;
  orders: Row[];
  registrations: Row[];
  /** registration_id -> its charges. */
  charges: Map<string, Row[]>;
  /** charge_id -> reminder sends. */
  reminders: Map<string, Row[]>;
  /** paymongo_payment_id -> payment_ledger row. */
  ledger: Map<string, Row>;
  bookings: Row[];
  classRegistrations: Row[];
  enquiries: Row[];
}

const label = (value: unknown): string => String(value ?? '').replace(/_/g, ' ');

const peso = (centavos: number, currency = 'PHP'): string =>
  new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(centavos / 100);

export function buildActivity(input: ActivityInput): ActivityItem[] {
  const items: ActivityItem[] = [];
  const add = (item: Omit<ActivityItem, 'at'> & { at: unknown }) => {
    if (typeof item.at !== 'string' || !item.at) return;
    items.push(item as ActivityItem);
  };

  for (const o of input.orders) {
    const name = o.products?.name ?? 'a course';
    add({ at: o.created_at, kind: 'order', title: `Started checkout for ${name}`, tone: 'info',
      amount_centavos: o.amount_centavos, currency: o.currency });
    if (o.status !== 'pending' && o.status !== 'pending_payment' && o.updated_at !== o.created_at) {
      const bad = o.status === 'failed' || o.status === 'expired';
      add({
        at: o.updated_at,
        kind: 'order',
        title: `Course order ${label(o.status)}: ${name}`,
        detail: o.error_detail ?? o.paymongo_payment_id ?? undefined,
        tone: bad ? 'bad' : o.status === 'paid_pending_enrollment' ? 'warn' : 'ok',
        amount_centavos: o.amount_centavos,
        currency: o.currency,
      });
    }
  }

  for (const r of input.registrations) {
    const title = r.events?.title ?? 'an event';
    const role =
      String(r.registrant_email ?? '').toLowerCase() === input.email
        ? String(r.buyer_email ?? '').toLowerCase() === input.email
          ? ''
          : ' (attending, paid by someone else)'
        : ' (paid for someone else)';
    add({
      at: r.created_at,
      kind: 'event',
      title: `Registered for ${title}${role}`,
      detail: `${r.plan_name} · seat ${r.seat_no} · plan total ${peso(r.total_centavos, r.currency)}`,
      tone: 'info',
    });
    add({ at: r.confirmed_at, kind: 'event', title: `Place confirmed: ${title}`, tone: 'ok' });
    add({ at: r.join_details_sent_at, kind: 'reminder', title: `Joining details emailed: ${title}`, tone: 'info' });
    add({ at: r.reminder_sent_at, kind: 'reminder', title: `Event reminder emailed: ${title}`, tone: 'info' });
    add({ at: r.flagged_at, kind: 'event', title: `Flagged: ${label(r.flag_reason) || title}`, tone: 'warn' });
    add({
      at: r.cancellation_requested_at,
      kind: 'event',
      title: `Cancellation requested: ${title}`,
      detail: r.cancellation_reason ?? undefined,
      tone: 'warn',
    });
    add({
      at: r.cancellation_decided_at,
      kind: 'event',
      title: `Cancellation ${label(r.cancellation_decision) || 'decided'}: ${title}`,
      tone: 'warn',
    });
    add({ at: r.cancelled_at, kind: 'event', title: `Registration cancelled: ${title}`, tone: 'bad' });
    add({
      at: r.refunded_at,
      kind: 'event',
      title: `Refund sent: ${title}`,
      detail: r.refund_reference ?? undefined,
      amount_centavos: r.refund_centavos,
      currency: r.currency,
      tone: 'warn',
    });

    for (const c of input.charges.get(r.id) ?? []) {
      if (c.paid_at) {
        const l = c.paymongo_payment_id ? input.ledger.get(c.paymongo_payment_id) : undefined;
        const via = c.paid_method === 'paymongo' ? (l?.method ? String(l.method).toUpperCase() : 'PayMongo') : label(c.paid_method);
        const parts = [`${title}`, `via ${via}`];
        if (l && l.fee_centavos != null && l.net_centavos != null) {
          parts.push(`fee ${peso(l.fee_centavos, c.currency)}, net ${peso(l.net_centavos, c.currency)}`);
        }
        if (c.receipt_no) parts.push(`receipt ${c.receipt_no}`);
        if (c.paymongo_payment_id) parts.push(c.paymongo_payment_id);
        add({
          at: c.paid_at,
          kind: 'payment',
          title: `Paid ${c.label}`,
          detail: parts.join(' · '),
          amount_centavos: c.amount_centavos,
          currency: c.currency,
          tone: 'ok',
        });
      } else if (c.status === 'void' || c.status === 'waived') {
        add({ at: c.voided_at ?? c.updated_at, kind: 'payment', title: `${c.label} ${c.status}`,
          detail: label(c.void_reason) || undefined, tone: 'info' });
      }
      for (const m of input.reminders.get(c.id) ?? []) {
        add({
          at: m.sent_at,
          kind: 'reminder',
          title: `Reminder emailed for ${c.label} (${label(m.tier)})`,
          detail: [m.sent_to, m.delivery_status].filter(Boolean).join(' · ') || undefined,
          tone: 'info',
        });
      }
    }
  }

  for (const c of input.classRegistrations) {
    const cls = c.facilitator_class_sessions?.facilitator_classes?.title ?? 'a class';
    const startsAt = c.facilitator_class_sessions?.starts_at;
    add({
      at: c.created_at,
      kind: 'class',
      title: `Reserved a seat in ${cls}`,
      detail: startsAt ? `class on ${new Date(startsAt).toISOString().slice(0, 10)}` : undefined,
      amount_centavos: c.price_centavos,
      currency: c.currency,
      tone: 'info',
    });
    if (c.status === 'expired') {
      add({ at: c.updated_at, kind: 'class', title: `Seat hold expired unpaid: ${cls}`, tone: 'bad' });
    } else if (c.status === 'confirmed' || c.status === 'attended') {
      add({ at: c.updated_at, kind: 'class', title: `Seat ${label(c.status)}: ${cls}`, tone: 'ok' });
    }
    add({ at: c.cancelled_at, kind: 'class', title: `Seat cancelled: ${cls}`, detail: c.cancellation_reason ?? undefined, tone: 'bad' });
    add({
      at: c.refunded_at,
      kind: 'class',
      title: `Refund sent: ${cls}`,
      amount_centavos: c.refund_centavos,
      currency: c.currency,
      tone: 'warn',
    });
  }

  for (const b of input.bookings) {
    const who = b.facilitators?.display_name ?? 'a facilitator';
    add({
      at: b.created_at,
      kind: 'booking',
      title: `Booked a session with ${who}`,
      detail: b.starts_at ? `session ${new Date(b.starts_at).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${label(b.status)}` : label(b.status),
      amount_centavos: b.price_centavos,
      currency: b.currency,
      tone: 'info',
    });
    add({ at: b.reminder_sent_at, kind: 'reminder', title: `Session reminder emailed (${who})`, tone: 'info' });
    add({ at: b.cancelled_at, kind: 'booking', title: `Booking cancelled (${who})`, detail: b.cancellation_reason ?? undefined, tone: 'bad' });
    add({
      at: b.refunded_at,
      kind: 'booking',
      title: `Refund sent (${who})`,
      amount_centavos: b.refund_centavos,
      currency: b.currency,
      tone: 'warn',
    });
  }

  for (const e of input.enquiries) {
    add({ at: e.created_at, kind: 'enquiry', title: `Submitted ${e.forms?.name ?? 'a form'}`, tone: 'info' });
  }

  // Oldest first; ties keep insertion order (Array.sort is stable), so a
  // registration and its confirmation in the same instant read in cause order.
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
