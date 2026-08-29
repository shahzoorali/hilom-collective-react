/**
 * Admin → People: every person the platform knows, in one list.
 *
 * The screen exists because answering "have we dealt with this person before?"
 * previously meant opening four tabs — Commerce, Registrations, Bookings,
 * Forms — and matching email addresses by eye. Everything here is a read of
 * `people_directory` (db/migrations/0022), which does that merge in the one
 * place that can see all four tables at the same instant.
 *
 * **Read-only, deliberately.** There is no users table to edit, so the only
 * writes available would reach into orders, bookings or registrations — each
 * of which has a screen that already knows its own rules about refunds, seats
 * and audit trails. Rows link out to those screens instead of duplicating a
 * fraction of their behaviour here.
 *
 * **The scope notice is not boilerplate.** This list is derived from
 * transactions, so somebody who made a Cognito account and never bought,
 * booked or enquired is genuinely absent. An operator who mistook this for
 * "all accounts" would draw the wrong conclusion from an empty search, so the
 * limit is stated on the screen rather than left in a comment.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { money } from '../../components/Layout';
import { API_BASE } from '../../config';
import {
  adminListPeople,
  adminGetPerson,
  adminActor,
  type Person,
  type PersonDetail,
  type PersonSource,
  type PersonCharge,
  type PeopleSort,
} from '../../lib/cms';

const SOURCE_LABELS: Record<PersonSource, string> = {
  course_order: 'Course buyer',
  event_registration: 'Event payer',
  event_attendee: 'Event attendee',
  booking: 'Booking client',
  enquiry: 'Enquiry',
};

const SOURCE_FILTERS: { key: '' | PersonSource; label: string }[] = [
  { key: '', label: 'Everyone' },
  { key: 'course_order', label: 'Course buyers' },
  { key: 'event_registration', label: 'Event payers' },
  { key: 'event_attendee', label: 'Event attendees' },
  { key: 'booking', label: 'Booking clients' },
  { key: 'enquiry', label: 'Enquiries only' },
];

const SORTS: { key: PeopleSort; label: string }[] = [
  { key: 'recent', label: 'Most recent' },
  { key: 'value', label: 'Highest value' },
  { key: 'oldest', label: 'Longest known' },
  { key: 'name', label: 'Name (A–Z)' },
  { key: 'email', label: 'Email (A–Z)' },
];

/**
 * How each instalment state reads on screen.
 *
 * `waived` and `void` are deliberately not collapsed into "paid": one is money
 * forgiven and the other a charge superseded by an early payoff, and an
 * operator reconciling a plan needs to tell those apart from money received.
 */
const CHARGE_LABELS: Record<PersonCharge['status'], { text: string; pill: string }> = {
  paid: { text: 'Paid', pill: 'pill-ok' },
  scheduled: { text: 'Due', pill: 'pill-warn' },
  awaiting_payment: { text: 'Link open', pill: 'pill-warn' },
  waived: { text: 'Waived', pill: 'pill-ok' },
  void: { text: 'Superseded', pill: 'pill-warn' },
  refunded: { text: 'Refunded', pill: 'pill-bad' },
};

const manilaDate = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));

export default function PeopleTab({ adminKey }: { adminKey: string }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');
  // Debounced separately from `q` so typing does not fire a request per
  // keystroke; `q` stays instant so the input never feels laggy.
  const [term, setTerm] = useState('');
  const [source, setSource] = useState<'' | PersonSource>('');
  const [sort, setSort] = useState<PeopleSort>('recent');
  const [openEmail, setOpenEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await adminListPeople(adminKey, { q: term, source, sort });
      setPeople(res.people);
      setTruncated(res.truncated);
      setScope(res.scope);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [adminKey, term, source, sort]);

  useEffect(() => void load(), [load]);

  const rows = people ?? [];
  const withAccounts = rows.filter((p) => p.cognito_sub).length;
  const lifetime = rows.reduce((acc, p) => acc + Number(p.lifetime_centavos ?? 0), 0);

  return (
    <div>
      <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>People</h2>
      <p className="small muted" style={{ marginTop: '-0.25rem', marginBottom: '1.25rem' }}>
        {scope || 'Everyone with an order, registration, booking or enquiry.'}
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or email…"
          aria-label="Search people"
          style={{ maxWidth: 260 }}
        />
        <select
          value={source}
          onChange={(e) => setSource(e.target.value as '' | PersonSource)}
          aria-label="Filter by source"
          style={{ maxWidth: 200 }}
        >
          {SOURCE_FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <select
          value={sort}
          onChange={(e) => setSort(e.target.value as PeopleSort)}
          aria-label="Sort people"
          style={{ maxWidth: 180 }}
        >
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              {s.label}
            </option>
          ))}
        </select>

        <a
          className="btn btn-ghost"
          style={{ padding: '6px 12px' }}
          href={`${API_BASE}/admin/people.csv`}
          onClick={(e) => {
            // Needs the admin key, which a plain <a> cannot send.
            e.preventDefault();
            void downloadCsv(adminKey, { q: term, source }).catch((err: Error) => setError(err.message));
          }}
        >
          Export CSV
        </a>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {people !== null && (
        <div className="admin-stats-grid">
          <Stat label="People" value={String(rows.length)} hint={truncated ? 'first 500' : undefined} />
          <Stat label="With accounts" value={String(withAccounts)} hint="have signed in" />
          <Stat label="Lifetime paid" value={money(lifetime)} hint="shown rows only" />
        </div>
      )}

      {truncated && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          More than 500 people match. Narrow the search — the totals above cover only what is shown.
        </div>
      )}

      {people === null && !error && <div className="spinner" aria-label="Loading" />}

      {people !== null && rows.length === 0 && (
        <div className="panel">
          <p style={{ margin: 0 }}>
            {term || source
              ? 'Nobody matches that. Remember this lists people who have transacted or enquired — an account on its own does not appear here.'
              : 'Nobody yet. People appear here after their first order, registration, booking or enquiry.'}
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {rows.map((p) => (
          <PersonRow
            key={p.email}
            adminKey={adminKey}
            person={p}
            open={openEmail === p.email}
            onToggle={() => setOpenEmail(openEmail === p.email ? null : p.email)}
          />
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="admin-stat-card">
      <span className="admin-stat-card__label">{label}</span>
      <span className="admin-stat-card__value">{value}</span>
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}

/** Fetches the CSV with the admin header, then hands the browser a blob. */
async function downloadCsv(
  adminKey: string,
  params: { q?: string; source?: string },
): Promise<void> {
  const qs = new URLSearchParams(
    Object.entries(params).filter(([, v]) => v) as [string, string][],
  ).toString();
  const res = await fetch(`${API_BASE}/admin/people.csv${qs ? `?${qs}` : ''}`, {
    headers: { 'x-admin-key': adminKey, ...(adminActor() ? { 'x-admin-actor': adminActor() } : {}) },
  });
  if (!res.ok) throw new Error('Could not export the directory.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'people.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function PersonRow({
  adminKey,
  person,
  open,
  onToggle,
}: {
  adminKey: string;
  person: Person;
  open: boolean;
  onToggle: () => void;
}) {
  const [detail, setDetail] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetched on expand, not with the list: the detail is four more queries per
  // person, and on a 500-row directory that is 2,000 queries to render a page
  // where all but one row is collapsed.
  useEffect(() => {
    if (!open || detail) return;
    adminGetPerson(adminKey, person.email)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [open, detail, adminKey, person.email]);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%',
          background: 'none',
          border: 0,
          padding: '0.9rem 1.1rem',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ flex: '1 1 240px', minWidth: 0 }}>
          <strong style={{ display: 'block' }}>{person.full_name ?? person.email}</strong>
          {person.full_name && (
            <span className="small muted" style={{ wordBreak: 'break-all' }}>
              {person.email}
            </span>
          )}
        </span>

        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {person.cognito_sub && <span className="pill pill-ok">Account</span>}
          {person.sources.map((s) => (
            <span key={s} className="pill pill-warn">
              {SOURCE_LABELS[s] ?? s}
            </span>
          ))}
        </span>

        <span style={{ textAlign: 'right', minWidth: 110 }}>
          <strong>{money(person.lifetime_centavos)}</strong>
          <span className="small muted" style={{ display: 'block' }}>
            since {manilaDate(person.first_seen_at)}
          </span>
        </span>

        <span aria-hidden style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 1.1rem 1.1rem', borderTop: '1px solid var(--line)' }}>
          {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
          {!detail && !error && <div className="spinner" aria-label="Loading" />}
          {detail && <PersonHistory detail={detail} />}
        </div>
      )}
    </div>
  );
}

function PersonHistory({ detail }: { detail: PersonDetail }) {
  const { person, orders, registrations, bookings, enquiries, money: totals } = detail;
  const nothing =
    orders.length === 0 && registrations.length === 0 && bookings.length === 0 && enquiries.length === 0;

  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 14 }}>
      {person.cognito_sub ? (
        <p className="small muted" style={{ margin: 0 }}>
          Signed in before. Cognito subject <code>{person.cognito_sub}</code> — look them up in the
          user pool for account details this directory does not hold.
        </p>
      ) : (
        <p className="small muted" style={{ margin: 0 }}>
          No sign-in on record. They have only ever reached us through the records below.
        </p>
      )}

      {/* The money questions, above the records that answer them in detail.
          Only rendered when a plan or a refund is actually in play — a row of
          zeroes over one paid course order is noise. */}
      {(totals.registrations_outstanding_centavos > 0 ||
        totals.registrations_overdue_centavos > 0 ||
        totals.refunds_owed_centavos > 0) && (
        <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
          <Figure label="Paid on plans" value={money(totals.registrations_paid_centavos)} />
          <Figure label="Still owed" value={money(totals.registrations_outstanding_centavos)} />
          {totals.registrations_overdue_centavos > 0 && (
            <Figure label="Overdue" value={money(totals.registrations_overdue_centavos)} bad />
          )}
          {totals.refunds_owed_centavos > 0 && (
            <Figure label="Refund owed" value={money(totals.refunds_owed_centavos)} bad />
          )}
        </div>
      )}

      {nothing && <p className="small muted" style={{ margin: 0 }}>No records to show.</p>}

      <Section title="Course orders" count={orders.length}>
        {orders.map((o) => (
          <Line
            key={o.id}
            left={o.products?.name ?? 'Course order'}
            sub={
              `${manilaDate(o.created_at)} · ${o.status.replace(/_/g, ' ')}` +
              (o.paymongo_payment_id ? ` · ${o.paymongo_payment_id}` : '')
            }
            note={o.error_detail ?? undefined}
            right={money(o.amount_centavos, o.currency)}
          />
        ))}
      </Section>

      <Section title="Event registrations" count={registrations.length}>
        {registrations.map((r) => (
          <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--line)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ minWidth: 0 }}>
                <span style={{ display: 'block' }}>{r.events?.title ?? 'Event'}</span>
                <span className="small muted">
                  {`Seat ${r.seat_no} · ${r.plan_name} · ${r.status.replace(/_/g, ' ')}` +
                    // The same email can be the payer on one row and the
                    // attendee on another, and the distinction changes who to
                    // contact about money versus who to contact about the retreat.
                    (r.registrant_email.toLowerCase() === person.email
                      ? r.buyer_email.toLowerCase() === person.email
                        ? ''
                        : ' · attending, paid by someone else'
                      : ' · paid for someone else')}
                </span>
              </span>
              <span style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                <span style={{ display: 'block' }}>{money(r.total_centavos, r.currency)}</span>
                {r.outstanding_centavos > 0 && (
                  <span className="small muted">
                    {money(r.paid_centavos, r.currency)} paid ·{' '}
                    {money(r.outstanding_centavos, r.currency)} left
                  </span>
                )}
              </span>
            </div>

            {/* The schedule itself, shown even when fully paid: "which of the
                four cleared, and when" is the question a single total can
                never answer. */}
            {r.charges.length > 1 && (
              <div style={{ display: 'grid', gap: 2, margin: '8px 0 0', paddingLeft: 12 }}>
                {r.charges.map((c) => (
                  <ChargeLine key={c.id} charge={c} />
                ))}
              </div>
            )}

            {r.overdue_count > 0 ? (
              <p className="small" style={{ margin: '6px 0 0', color: 'var(--danger-fg)' }}>
                {r.overdue_count} payment{r.overdue_count === 1 ? '' : 's'} overdue —{' '}
                {money(r.overdue_centavos, r.currency)}.
              </p>
            ) : r.next_due ? (
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Next: {r.next_due.label} · {money(r.next_due.amount_centavos, r.currency)} due{' '}
                {manilaDate(r.next_due.due_at)}.
              </p>
            ) : null}

            {r.refund_centavos != null && r.refund_centavos > 0 && (
              <p className="small" style={{ margin: '6px 0 0' }}>
                Refund {money(r.refund_centavos, r.currency)}{' '}
                {r.refunded_at
                  ? `sent ${manilaDate(r.refunded_at)}${r.refund_reference ? ` · ${r.refund_reference}` : ''}`
                  : '— owed, not yet sent'}
              </p>
            )}
          </div>
        ))}
      </Section>

      <Section title="Bookings" count={bookings.length}>
        {bookings.map((b) => (
          <Line
            key={b.id}
            left={b.facilitators?.display_name ?? 'Session'}
            sub={
              `${manilaDate(b.starts_at)} · ${b.status.replace(/_/g, ' ')}` +
              (b.paymongo_payment_id ? ` · ${b.paymongo_payment_id}` : '')
            }
            note={
              b.refund_centavos != null && b.refund_centavos > 0
                ? `Refund ${money(b.refund_centavos, b.currency)} ` +
                  (b.refunded_at
                    ? `sent ${manilaDate(b.refunded_at)}${b.refund_reference ? ` · ${b.refund_reference}` : ''}`
                    : '— owed, not yet sent')
                : undefined
            }
            right={money(b.price_centavos, b.currency)}
          />
        ))}
      </Section>

      <Section title="Enquiries" count={enquiries.length}>
        {enquiries.map((e) => (
          <Line key={e.id} left={e.forms?.name ?? 'Form'} sub={manilaDate(e.created_at)} right="" />
        ))}
      </Section>
    </div>
  );
}

function Figure({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <span>
      <span className="small muted" style={{ display: 'block' }}>
        {label}
      </span>
      <strong style={bad ? { color: 'var(--danger-fg)' } : undefined}>{value}</strong>
    </span>
  );
}

/**
 * One instalment: what it is, when it was due, and what actually happened.
 *
 * Overdue is derived here rather than trusted from `flagged_at`, which is only
 * set once the nightly sweep has run — a payment that fell due this morning is
 * late on the screen the moment it is late in fact.
 */
function ChargeLine({ charge }: { charge: PersonCharge }) {
  const badge = CHARGE_LABELS[charge.status];
  const overdue =
    (charge.status === 'scheduled' || charge.status === 'awaiting_payment') &&
    Date.parse(charge.due_at) < Date.now();

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
      <span className="small" style={{ minWidth: 0 }}>
        <span className={`pill ${overdue ? 'pill-bad' : badge.pill}`} style={{ marginRight: 6 }}>
          {overdue ? 'Overdue' : badge.text}
        </span>
        {charge.seq}. {charge.label}
        {charge.is_deposit && ' (deposit)'}
      </span>
      <span className="small muted" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
        {money(charge.amount_centavos, charge.currency)} ·{' '}
        {charge.status === 'paid' && charge.paid_at
          ? `paid ${manilaDate(charge.paid_at)}` +
            (charge.paid_method ? ` (${charge.paid_method.replace(/_/g, ' ')})` : '') +
            (charge.receipt_no ? ` · ${charge.receipt_no}` : '')
          : charge.status === 'void'
            ? charge.void_reason ?? 'superseded'
            : `due ${manilaDate(charge.due_at)}`}
      </span>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  if (count === 0) return null;
  return (
    <div>
      <p className="small" style={{ fontWeight: 700, margin: '0 0 6px' }}>
        {title} ({count})
      </p>
      <div style={{ display: 'grid', gap: 4 }}>{children}</div>
    </div>
  );
}

function Line({
  left,
  sub,
  right,
  note,
}: {
  left: string;
  sub: string;
  right: string;
  note?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 0',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block' }}>{left}</span>
        <span className="small muted">{sub}</span>
        {note && (
          <span className="small" style={{ display: 'block' }}>
            {note}
          </span>
        )}
      </span>
      {right && <span style={{ whiteSpace: 'nowrap' }}>{right}</span>}
    </div>
  );
}
