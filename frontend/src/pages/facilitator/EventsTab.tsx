/**
 * Facilitator → Events.
 *
 * Two things a host needs and, until now, had to ask an admin for: who has
 * actually registered, and control of the link people join on.
 *
 * The roster shown here is the admin roster — the same backend function
 * (lib/event-roster.ts), the same derived money figures. That is deliberate: a
 * host who emails an attendee about a missed instalment must be reading the
 * same number the admin is, or the two will contradict each other in front of
 * the person who paid.
 *
 * The joining link is saved and sent in two separate actions. Saving a
 * corrected dial-in note should not email forty people, and emailing forty
 * people should be something someone chose to do.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { money } from '../../components/Layout';
import {
  listMyHostedEvents,
  getMyHostedRoster,
  saveMyHostedJoinLink,
  sendMyHostedJoinDetails,
  createMyHostedEvent,
  saveMyHostedEvent,
  submitMyHostedEvent,
  listMyEventSeries,
  getMyEventSeries,
  createMyEventSeries,
  saveMyEventSeries,
  replaceMyEventSeriesDates,
  submitMyEventSeries,
  cancelMyHostedEvent,
  type EventReviewStatus,
  type MyHostedEvent,
  type MyEventSeries,
  type EventSeriesInput,
} from '../../lib/booking';
import type { AdminRegistration, RosterMoney } from '../../lib/cms';
import { ActionBar, PageHeader, Section, StatusPill, type Tone } from './ui';

/** Review states in which the whole proposal is still the facilitator's to change. */
const EDITABLE = new Set<EventReviewStatus>(['draft', 'rejected']);

/**
 * Whether Edit should be offered at all. Adds 'approved' to `EDITABLE`
 * (0058) — the form behaves differently there (see `EventProposalForm`), but
 * an approved event is not frozen any more, only its material fields are.
 */
function canEdit(event: MyHostedEvent): boolean {
  return EDITABLE.has(event.review_status) || event.review_status === 'approved';
}

/**
 * Where a proposal stands, in the facilitator's own terms.
 *
 * Deliberately not the raw enum. "submitted" is a database word; "With Hilom"
 * tells a host that the ball is not in their court, which is the only thing
 * they need from this badge. The approved-but-unpublished case gets its own
 * wording because it is the one people otherwise write in about — approved is
 * not the same as live, and a badge saying only "Approved" invites the
 * question of why the event is not on the site.
 */
function ReviewBadge({ event }: { event: MyHostedEvent }) {
  const [label, tone]: [string, Tone] =
    event.review_status === 'draft'
      ? ['Draft', 'neutral']
      : event.review_status === 'submitted'
        ? ['In review', 'info']
        : event.review_status === 'rejected'
          ? ['Changes requested', 'warn']
          : event.status === 'published'
            ? ['Live', 'ok']
            : ['Approved · not published', 'info'];

  return (
    <>
      <StatusPill tone={tone}>{label}</StatusPill>
      {event.pending_changes && <StatusPill tone="info">Change awaiting review</StatusPill>}
    </>
  );
}

function SeriesBadge({ series }: { series: MyEventSeries }) {
  const [label, tone]: [string, Tone] =
    series.review_status === 'draft'
      ? ['Draft', 'neutral']
      : series.review_status === 'submitted'
        ? ['In review', 'info']
        : series.review_status === 'rejected'
          ? ['Changes requested', 'warn']
          : ['Approved', 'ok'];

  return <StatusPill tone={tone}>{label}</StatusPill>;
}

/** Month + day tile, in Manila time like every other date on this screen. */
function EventDateTile({ iso }: { iso: string }) {
  const d = new Date(iso);
  const part = (o: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', ...o }).format(d);
  return (
    <div className="fs-datetile" aria-hidden="true">
      <span className="fs-datetile-month">{part({ month: 'short' })}</span>
      <span className="fs-datetile-day">{part({ day: 'numeric' })}</span>
    </div>
  );
}

/**
 * The public listing card, drawn from the live draft — so the facilitator
 * sees what a visitor to the events page will see while they type.
 */
function ListingPreview({
  title,
  subtitle,
  excerpt,
  imageUrl,
  imageAlt,
  location,
  format,
  dateLabel,
}: {
  title: string;
  subtitle: string;
  excerpt: string;
  imageUrl: string;
  imageAlt: string;
  location: string;
  format: string;
  dateLabel: string;
}) {
  return (
    <div className="fs-card fs-listing">
      <span className="fs-eyebrow fs-listing-label">Listing preview</span>
      <div className="fs-listing-img">
        {imageUrl ? <img src={imageUrl} alt={imageAlt} /> : <span aria-hidden="true">🖼️</span>}
      </div>
      <div className="fs-listing-body">
        <span className="fs-listing-date">{dateLabel || 'Pick a date'}</span>
        <strong>{title || 'Your event title'}</strong>
        {subtitle && <span className="fs-listing-sub">{subtitle}</span>}
        <p>{excerpt || 'Your short summary appears here, on the events listing card.'}</p>
        <div className="fs-preview-meta" style={{ justifyContent: 'flex-start' }}>
          {location && <span>📍 {location}</span>}
          {format && <span>✨ {format}</span>}
        </div>
      </div>
    </div>
  );
}

function ReviewSteps({ series }: { series?: boolean }) {
  return (
    <div className="fs-card">
      <header className="fs-card-head">
        <h2>How review works</h2>
      </header>
      <ol className="fs-steps">
        <li><strong>Save a draft</strong><span>Only you can see it. Come back any time.</span></li>
        <li><strong>Send to Hilom</strong><span>We read every {series ? 'series' : 'event'}, usually within a few days.</span></li>
        <li><strong>Approved & priced</strong><span>Hilom sets the ticket price and capacity{series ? ', using your ask as a guide' : ''}.</span></li>
        <li><strong>Live</strong><span>It appears on the public calendar and people can register.</span></li>
      </ol>
    </div>
  );
}

function localDateLabel(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-PH', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

const STATUS_LABEL: Record<string, string> = {
  pending_payment: 'Holding a place',
  confirmed: 'Confirmed',
  completed: 'Attended',
  cancelled: 'Cancelled',
  expired: 'Lapsed',
};

/** A date range, collapsed when start and end fall on the same day. */
function when(startsAt: string, endsAt: string | null): string {
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-PH', {
      timeZone: 'Asia/Manila',
      dateStyle: 'medium',
    }).format(new Date(iso));
  const start = fmt(startsAt);
  const end = endsAt ? fmt(endsAt) : null;
  return !end || end === start ? start : `${start} — ${end}`;
}

export default function EventsTab() {
  const { eventId } = useParams();
  const navigate = useNavigate();
  const [events, setEvents] = useState<MyHostedEvent[] | null>(null);
  const [series, setSeries] = useState<MyEventSeries[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** null = list, 'new' = a blank proposal, otherwise the id being edited. */
  const [composing, setComposing] = useState<string | null>(null);
  /** null = list, 'new' = a blank series, otherwise the series id being edited. */
  const [composingSeries, setComposingSeries] = useState<string | null>(null);
  // Set by the form on its way out, shown on the list. The form cannot say
  // "sent" itself: succeeding is what closes it.
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    listMyHostedEvents()
      .then(setEvents)
      .catch((err: Error) => setError(err.message));
    listMyEventSeries()
      .then(setSeries)
      .catch((err: Error) => setError(err.message));
  }, []);

  if (error) return <div className="alert alert-error">{error}</div>;
  if (events === null || series === null) return <div className="spinner" aria-label="Loading" />;

  if (eventId) {
    const hosted = events.find((e) => e.id === eventId);
    return (
      <EventDetail
        eventId={eventId}
        fallbackTitle={hosted?.title ?? 'Event'}
        onBack={() => navigate('/facilitator/events')}
      />
    );
  }

  if (composing) {
    return (
      <EventProposalForm
        existing={composing === 'new' ? null : events.find((e) => e.id === composing) ?? null}
        onDone={(saved, message) => {
          setEvents((list) =>
            list === null
              ? [saved]
              : list.some((e) => e.id === saved.id)
                ? list.map((e) => (e.id === saved.id ? saved : e))
                : [saved, ...list],
          );
          setNotice(message ?? null);
          setComposing(null);
        }}
        onCancel={() => setComposing(null)}
      />
    );
  }

  if (composingSeries) {
    return (
      <SeriesProposalForm
        seriesId={composingSeries === 'new' ? null : composingSeries}
        existing={composingSeries === 'new' ? null : series.find((s) => s.id === composingSeries) ?? null}
        onDone={(saved, message) => {
          setSeries((list) =>
            list === null
              ? [saved]
              : list.some((s) => s.id === saved.id)
                ? list.map((s) => (s.id === saved.id ? saved : s))
                : [saved, ...list],
          );
          setNotice(message ?? null);
          setComposingSeries(null);
        }}
        onCancel={() => setComposingSeries(null)}
      />
    );
  }

  const live = events.filter((e) => e.review_status === 'approved' && e.status === 'published').length;
  const inReview = events.filter((e) => e.review_status === 'submitted').length + series.filter((x) => x.review_status === 'submitted').length;
  const sold = events.reduce((sum, e) => sum + e.registrations.confirmed, 0);

  return (
    <div className="fs-page">
      <PageHeader
        title="Events"
        subtitle="Workshops, retreats and multi-date programmes you host. Hilom reviews each one before it goes public."
        actions={
          <>
            <button type="button" className="fs-btn" onClick={() => setComposingSeries('new')}>
              ＋ Propose a series
            </button>
            <button type="button" className="fs-btn fs-btn--primary" onClick={() => setComposing('new')}>
              ＋ Propose an event
            </button>
          </>
        }
      />

      {notice && <div className="alert alert-success">{notice}</div>}

      {(events.length > 0 || series.length > 0) && (
        <div className="fs-minis">
          <div className="fs-mini"><span>Live events</span><strong>{live}</strong></div>
          <div className="fs-mini"><span>In review</span><strong>{inReview}</strong></div>
          <div className="fs-mini"><span>Confirmed registrations</span><strong>{sold}</strong></div>
        </div>
      )}

      {events.length === 0 && series.length === 0 && (
        <div className="fs-card fs-hero-empty">
          <span aria-hidden="true">🎟️</span>
          <h2>Host your first event</h2>
          <p>
            Propose a one-off workshop or a multi-date series. Hilom reviews it, sets the ticketing,
            and puts it on the public events calendar — nothing appears until it's approved.
          </p>
          <div className="fs-integration-foot" style={{ justifyContent: 'center' }}>
            <button type="button" className="fs-btn" onClick={() => setComposingSeries('new')}>Propose a series</button>
            <button type="button" className="fs-btn fs-btn--primary" onClick={() => setComposing('new')}>Propose an event</button>
          </div>
        </div>
      )}

      {series.length > 0 && (
        <section className="fs-card">
          <header className="fs-card-head">
            <div>
              <h2>Series</h2>
              <p className="small muted" style={{ margin: '0.2rem 0 0' }}>
                A multi-date programme, reviewed once. Each date gets its own roster and joining link
                once approved.
              </p>
            </div>
          </header>
          <ul className="fs-rows">
            {series.map((s) => {
              const first = (s.dates ?? [])[0];
              return (
                <li key={s.id}>
                  {first ? <EventDateTile iso={first.starts_at} /> : <div className="fs-datetile fs-datetile--empty" aria-hidden="true">—</div>}
                  <div className="fs-row-main">
                    <div className="fs-row-title">
                      <strong>{s.title}</strong> <SeriesBadge series={s} />
                    </div>
                    <span className="small muted">
                      {(s.dates ?? []).length} date{(s.dates ?? []).length === 1 ? '' : 's'}
                      {s.proposed_price_centavos !== null && ` · asked ₱${(s.proposed_price_centavos / 100).toFixed(2)}/date`}
                    </span>
                    {s.review_status === 'rejected' && s.review_note && (
                      <div className="alert alert-warning" style={{ margin: '0.6rem 0 0' }}>
                        <strong>Hilom asked for changes:</strong> {s.review_note}
                      </div>
                    )}
                  </div>
                  <div className="fs-row-actions">
                    {(s.review_status === 'draft' || s.review_status === 'rejected') && (
                      <button type="button" className="fs-btn" onClick={() => setComposingSeries(s.id)}>
                        Edit
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {events.length > 0 && (
        <section className="fs-card">
          <header className="fs-card-head">
            <h2>Single dates</h2>
          </header>
          <ul className="fs-rows">
            {events.map((e) => (
              <li key={e.id}>
                <EventDateTile iso={e.starts_at} />
                <div className="fs-row-main">
                  <div className="fs-row-title">
                    <strong>{e.title}</strong> <ReviewBadge event={e} />
                  </div>
                  <span className="small muted">
                    {when(e.starts_at, e.ends_at)}
                    {e.location ? ` · ${e.location}` : ''}
                  </span>

                  {/* The rejection note is the only explanation they get, so it is
                      shown on the card rather than behind the edit screen. */}
                  {e.review_status === 'rejected' && e.review_note && (
                    <div className="alert alert-warning" style={{ margin: '0.6rem 0 0' }}>
                      <strong>Hilom asked for changes:</strong> {e.review_note}
                    </div>
                  )}

                  {/* A declined edit (0058) leaves the event itself untouched, so this
                      is informational rather than a call to fix a broken listing. */}
                  {!e.pending_changes && e.edit_review_note && (
                    <div className="alert alert-warning" style={{ margin: '0.6rem 0 0' }}>
                      <strong>Your last edit wasn't made:</strong> {e.edit_review_note}
                    </div>
                  )}

                  <div className="fs-row-stats">
                    <span><strong>{e.registrations.confirmed}</strong> confirmed</span>
                    {e.registrations.pending > 0 && <span>{e.registrations.pending} still paying</span>}
                    {!e.join_url && e.ticketing_enabled && <span className="fs-row-warn">No joining link set</span>}
                    {/* The funnel (0063). Only shown once there is something to show —
                        a proposal nobody could see yet has nothing to report. */}
                    {e.ticketing_enabled && (e.view_count > 0 || e.registrations.checkouts > 0) && (
                      <span>
                        {e.view_count} view{e.view_count === 1 ? '' : 's'} → {e.registrations.checkouts} checkout
                        {e.registrations.checkouts === 1 ? '' : 's'} → {e.registrations.confirmed} sale
                        {e.registrations.confirmed === 1 ? '' : 's'}
                      </span>
                    )}
                  </div>
                </div>
                <div className="fs-row-actions">
                  {canEdit(e) && (
                    <button type="button" className="fs-btn fs-btn--quiet" onClick={() => setComposing(e.id)}>
                      Edit
                    </button>
                  )}
                  <button type="button" className="fs-btn" onClick={() => navigate(`/facilitator/events/${e.id}`)}>
                    Registrations
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function EventDetail({
  eventId,
  fallbackTitle,
  onBack,
}: {
  eventId: string;
  fallbackTitle: string;
  onBack: () => void;
}) {
  const [roster, setRoster] = useState<{
    title: string;
    registrations: AdminRegistration[];
    money: RosterMoney;
    waitlistCount: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The link as it is on the server, and the link as it is in the box. Kept
  // apart so the Send button can be disabled while there are unsaved edits —
  // the send reads the link from the server, so offering it while the box says
  // something else would email a link nobody saved.
  const [savedUrl, setSavedUrl] = useState('');
  const [url, setUrl] = useState('');
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    let live = true;
    getMyHostedRoster(eventId)
      .then((res) => {
        if (!live) return;
        setRoster({ title: res.event.title, registrations: res.registrations, money: res.money, waitlistCount: res.waitlistCount });
        setSavedUrl(res.joinLink.join_url ?? '');
        setUrl(res.joinLink.join_url ?? '');
        setInstructions(res.joinLink.join_instructions ?? '');
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [eventId]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await saveMyHostedJoinLink(eventId, url.trim(), instructions.trim());
      setSavedUrl(res.joinLink.join_url ?? '');
      setUrl(res.joinLink.join_url ?? '');
      setInstructions(res.joinLink.join_instructions ?? '');
      setNotice(
        res.changed
          ? 'Saved. Everyone who registers from now on gets this link in their confirmation — use Send below to tell the people who already registered.'
          : 'Saved.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const who = confirmedCount;
    if (
      !window.confirm(
        `Email the joining details to ${who} confirmed ${who === 1 ? 'registrant' : 'registrants'}?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await sendMyHostedJoinDetails(eventId);
      // Reported split, because the two groups got materially different emails
      // and the sender should know that rather than infer it.
      const parts = [
        res.firstTime > 0 && `${res.firstTime} told for the first time`,
        res.resent > 0 && `${res.resent} told the link changed`,
      ].filter(Boolean);
      setNotice(
        res.sent === 0
          ? 'Nobody to send to — no confirmed registrations yet.'
          : `Sent to ${res.sent} ${res.sent === 1 ? 'person' : 'people'}${
              parts.length > 0 ? ` — ${parts.join(', ')}.` : '.'
            }`,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const registrations = roster?.registrations ?? [];
  const confirmedCount = registrations.filter(
    (r) => r.status === 'confirmed' || r.status === 'completed',
  ).length;
  // Unsaved edits must not be sendable: the send reads the link from the
  // server, so offering it while the box says something else would email a
  // link nobody typed.
  const dirty = url.trim() !== savedUrl;

  async function cancelDate() {
    const reason = window.prompt(
      confirmedCount > 0
        ? `Cancel this date? ${confirmedCount} confirmed ${confirmedCount === 1 ? 'registrant' : 'registrants'} will be emailed and fully refunded whatever they paid. Say why, for the email:`
        : 'Cancel this date? Say why, for the record:',
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError('Say why this date is being cancelled — it goes in the email.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await cancelMyHostedEvent(eventId, reason.trim());
      setCancelled(true);
      setNotice(
        res.refundsOwed > 0
          ? `Cancelled. ${res.refundsOwed} ${res.refundsOwed === 1 ? 'person is' : 'people are'} owed a refund — Hilom sends those.`
          : 'Cancelled.',
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <button type="button" className="linklike small" onClick={onBack}>
          ← All events
        </button>
        {!cancelled && (
          <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => void cancelDate()}>
            Cancel this date
          </button>
        )}
      </div>
      <h2>{roster?.title ?? fallbackTitle}</h2>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {cancelled && (
        <div className="alert alert-warning">
          This date is cancelled and off the public calendar. Anyone who had a confirmed place was
          emailed; refunds owed show up in Hilom's payouts screen.
        </div>
      )}

      {!cancelled && <div className="card" style={{ marginBottom: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Joining link</h3>
        <p className="small muted" style={{ marginTop: 0 }}>
          Sent in the confirmation email to everyone who registers, and shown on their own
          registration page once their place is paid for. Never shown publicly.
        </p>

        <label className="field">
          <span>Link</span>
          <input
            type="url"
            value={url}
            placeholder="https://us05web.zoom.us/j/..."
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>

        <label className="field">
          <span>Anything else they need to know</span>
          <textarea
            rows={2}
            value={instructions}
            placeholder="Waiting room opens 15 minutes early. Passcode is in the link."
            onChange={(e) => setInstructions(e.target.value)}
          />
        </label>

        <div className="row" style={{ gap: '0.5rem' }}>
          <button type="button" className="btn" disabled={busy} onClick={() => void save()}>
            Save
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            disabled={busy || dirty || !savedUrl || confirmedCount === 0}
            onClick={() => void send()}
          >
            Send to {confirmedCount} confirmed
          </button>
        </div>
        {dirty && (
          <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
            Save your change before sending it out.
          </p>
        )}
      </div>}

      {roster === null ? (
        <div className="spinner" aria-label="Loading" />
      ) : (
        <>
          <p className="small muted">
            {roster.money.placesTaken} of {roster.money.capacity || '—'} places ·{' '}
            {money(roster.money.collectedCentavos, roster.money.currency)} collected
            {roster.money.outstandingCentavos > 0 && (
              <> · {money(roster.money.outstandingCentavos, roster.money.currency)} still owed</>
            )}
            {roster.waitlistCount > 0 && (
              <> · {roster.waitlistCount} on the waitlist</>
            )}
          </p>

          {registrations.length === 0 && <p className="muted">Nobody has registered yet.</p>}

          {registrations.map((r) => (
            <div key={r.id} className="card" style={{ marginBottom: '0.5rem' }}>
              <div
                className="row"
                style={{ justifyContent: 'space-between', alignItems: 'baseline' }}
              >
                <div>
                  <strong>
                    #{r.seat_no} {r.registrant_name}
                  </strong>
                  <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                    <a href={`mailto:${r.registrant_email}`}>{r.registrant_email}</a>
                    {r.registrant_phone ? ` · ${r.registrant_phone}` : ''}
                  </p>
                </div>
                <span className="small">{STATUS_LABEL[r.status] ?? r.status}</span>
              </div>

              <p className="small" style={{ margin: '0.4rem 0 0' }}>
                {r.plan_name} · {money(r.paidCentavos, r.currency)} paid
                {r.outstandingCentavos > 0 && (
                  <span className="muted">
                    {' '}
                    · {money(r.outstandingCentavos, r.currency)} outstanding
                    {r.overdueCount > 0 && ` (${r.overdueCount} overdue)`}
                  </span>
                )}
              </p>

              {/* The per-event extras an admin configured on the event —
                  dietary needs, emergency contact, room preference. These are
                  precisely what a host reads the roster for, and they are why
                  this screen shows the whole registration rather than a name
                  and an email. */}
              {Object.entries(r.registrant_details ?? {}).length > 0 && (
                <dl className="small" style={{ margin: '0.4rem 0 0' }}>
                  {Object.entries(r.registrant_details).map(([k, v]) => (
                    <div key={k}>
                      <dt className="muted" style={{ display: 'inline' }}>
                        {k.replace(/_/g, ' ')}:{' '}
                      </dt>
                      <dd style={{ display: 'inline', margin: 0 }}>{v}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {r.cancellation_requested_at && !r.cancellation_decided_at && (
                <p className="small" style={{ margin: '0.4rem 0 0' }}>
                  <strong>Asked to cancel.</strong>{' '}
                  <span className="muted">
                    {r.cancellation_reason || 'No reason given.'} An admin decides this one.
                  </span>
                </p>
              )}
            </div>
          ))}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * The proposal form.
 *
 * Save and Submit are two buttons on purpose. A half-written event should be
 * keepable without putting it in front of an admin, and submitting should be a
 * thing someone chose rather than a side effect of typing — the same split the
 * joining link already makes between saving a Zoom URL and emailing it to
 * forty people.
 *
 * What is conspicuously absent: capacity, ticket prices, payment plans and the
 * publish switch. Those are the money and the publication decision, they belong
 * to Hilom, and the backend drops them from this payload rather than trusting
 * the form not to send them.
 */
function EventProposalForm({
  existing,
  onDone,
  onCancel,
}: {
  existing: MyHostedEvent | null;
  onDone: (saved: MyHostedEvent, message?: string) => void;
  onCancel: () => void;
}) {
  // `datetime-local` wants 'YYYY-MM-DDTHH:mm' with no zone, and the stored
  // value is UTC ISO. Sliced rather than reformatted: every event on this site
  // is in Asia/Manila and the admin editor makes the same trade.
  const local = (iso: string | null) => (iso ? iso.slice(0, 16) : '');

  const [draft, setDraft] = useState({
    title: existing?.title ?? '',
    subtitle: existing?.subtitle ?? '',
    excerpt: existing?.excerpt ?? '',
    description: existing?.description ?? '',
    location: existing?.location ?? '',
    starts_at: local(existing?.starts_at ?? null),
    ends_at: local(existing?.ends_at ?? null),
    venue_details: existing?.venue_details ?? '',
    format: existing?.format ?? '',
    image_url: existing?.image_url ?? '',
    image_alt: existing?.image_alt ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const payload = () => ({
    title: draft.title,
    subtitle: draft.subtitle,
    excerpt: draft.excerpt,
    description: draft.description,
    location: draft.location,
    // Back to an ISO instant. `new Date()` on a zoneless string reads it in the
    // browser's zone, which is what someone typing "7pm" means.
    starts_at: draft.starts_at ? new Date(draft.starts_at).toISOString() : '',
    ends_at: draft.ends_at ? new Date(draft.ends_at).toISOString() : null,
    venue_details: draft.venue_details,
    format: draft.format,
    image: draft.image_url ? { id: null, url: draft.image_url, alt: draft.image_alt } : null,
  });

  /**
   * `keepOpen` exists because `onDone` unmounts this form.
   *
   * The parent renders the form only while `composing` is set, and `onDone`
   * clears it. That is right for a plain save -- the work is done, go back to
   * the list -- and wrong in the middle of saveAndSubmit, where the submit has
   * not happened yet. Calling it there tore the form down mid-flow, so the
   * error from a failed submit was set on a component that no longer existed
   * and was never rendered. The facilitator saw the list come back with no
   * message, which is indistinguishable from nothing having happened.
   */
  /** True once the event has been approved — material edits go through review instead of writing straight through. See 0058. */
  const isApprovedEdit = existing?.review_status === 'approved';

  async function save(keepOpen = false): Promise<MyHostedEvent | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = existing
        ? await saveMyHostedEvent(existing.id, payload())
        : await createMyHostedEvent(payload());
      if (!keepOpen) {
        // A material change (title/date/location/format) on an approved
        // event does not go live — it opens a review, and the event on the
        // site is unaffected until Hilom decides. Cosmetic-only changes (or
        // any edit to a draft/rejected proposal) are just saved.
        const message =
          isApprovedEdit && saved.pending_changes
            ? 'Saved. The change to the title, date, location or format needs Hilom’s okay — the ' +
              'live event is unaffected until then. Anything else you changed is already live.'
            : isApprovedEdit
              ? 'Saved and live.'
              : undefined;
        onDone(saved, message);
      }
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      return null;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Saves first, then submits. Two round-trips rather than one endpoint that
   * does both, so that a submission which fails validation still leaves the
   * typing safely on the server.
   */
  async function saveAndSubmit() {
    // Saved without unmounting, so that a refused submit still has a screen to
    // report itself on -- and the typing is already safely on the server
    // either way, which is why this is two round-trips rather than one.
    const saved = await save(true);
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await submitMyHostedEvent(saved.id);
      // Only now: the submit worked, so leaving the form is the right move.
      // The message travels with it, because this screen is about to unmount.
      onDone(submitted, 'Sent to Hilom for review.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit');
    } finally {
      setBusy(false);
    }
  }

  const heading = isApprovedEdit ? 'Edit event' : existing ? 'Edit proposal' : 'Propose an event';

  return (
    <div className="fs-page">
      <PageHeader
        title={heading}
        back={{ label: 'All events', onClick: onCancel }}
        subtitle={
          isApprovedEdit
            ? 'This event is live. Most edits show immediately; title, date, location and format changes get a quick check first.'
            : 'Tell us about a one-off event. Hilom reviews it, sets ticketing and puts it on the public calendar.'
        }
      />

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {isApprovedEdit && existing?.pending_changes && (
        <div className="alert alert-warning">
          A change to this event is already waiting on Hilom. You can still edit the description,
          image and other cosmetic details below — those save immediately — but another change to
          the title, date, location or format will be refused until that one is decided.
        </div>
      )}

      <div className="fs-profile">
        <div className="fs-profile-main">
          <Section step={1} title="The basics" hint="What it's called, in a line or two.">
            <label className="field">
              <span>Title</span>
              <input value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="Rest as Resistance" />
            </label>
            <label className="field">
              <span>Subtitle</span>
              <input
                value={draft.subtitle}
                onChange={(e) => set('subtitle', e.target.value)}
                placeholder="A half-day workshop on rest"
              />
            </label>
          </Section>

          <Section step={2} title="When & where" hint="Times are in your own timezone.">
            <div className="two-col">
              <label className="field">
                <span>Starts</span>
                <input type="datetime-local" value={draft.starts_at} onChange={(e) => set('starts_at', e.target.value)} />
              </label>
              <label className="field">
                <span>Ends (optional)</span>
                <input type="datetime-local" value={draft.ends_at} onChange={(e) => set('ends_at', e.target.value)} />
              </label>
            </div>
            <div className="two-col">
              <label className="field">
                <span>Where</span>
                <input
                  value={draft.location}
                  onChange={(e) => set('location', e.target.value)}
                  placeholder="Via Zoom, or Quezon City"
                />
              </label>
              <label className="field">
                <span>Format</span>
                <input
                  value={draft.format}
                  onChange={(e) => set('format', e.target.value)}
                  placeholder="Online, in person, hybrid"
                  list="fs-format-options"
                />
                <FormatOptions />
              </label>
            </div>
          </Section>

          <Section step={3} title="Tell people about it" hint="What it is, who it's for, and what to bring.">
            <label className="field">
              <span>Short summary</span>
              <textarea rows={2} value={draft.excerpt} onChange={(e) => set('excerpt', e.target.value)} />
              <small className="muted">One or two lines, shown on the events listing card.</small>
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                rows={10}
                value={draft.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="What the session is, who it is for, what people should bring."
              />
              <small className="muted">Basic formatting is kept; anything else is stripped when saved.</small>
            </label>
            <label className="field">
              <span>Practical details</span>
              <textarea
                rows={3}
                value={draft.venue_details}
                onChange={(e) => set('venue_details', e.target.value)}
                placeholder="Parking, what to wear, whether lunch is included."
              />
            </label>
          </Section>

          <Section step={4} title="Poster" hint="A landscape image works best on the listing card.">
            <div className="two-col">
              <label className="field">
                <span>Poster image URL</span>
                <input value={draft.image_url} onChange={(e) => set('image_url', e.target.value)} placeholder="https://…" />
              </label>
              <label className="field">
                <span>Image description</span>
                <input value={draft.image_alt} onChange={(e) => set('image_alt', e.target.value)} placeholder="For screen readers" />
              </label>
            </div>
          </Section>
        </div>

        <aside className="fs-profile-aside">
          <ListingPreview
            title={draft.title}
            subtitle={draft.subtitle}
            excerpt={draft.excerpt}
            imageUrl={draft.image_url}
            imageAlt={draft.image_alt}
            location={draft.location}
            format={draft.format}
            dateLabel={localDateLabel(draft.starts_at)}
          />
          {!isApprovedEdit && <ReviewSteps />}
        </aside>
      </div>

      <ActionBar
        status={
          isApprovedEdit
            ? 'Cosmetic changes go live on save'
            : 'Ticket price and capacity are set by Hilom on approval'
        }
      >
        <button type="button" className="fs-btn fs-btn--quiet" onClick={onCancel}>
          Cancel
        </button>
        {isApprovedEdit ? (
          <button type="button" className="fs-btn fs-btn--primary" disabled={busy} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save changes'}
          </button>
        ) : (
          <>
            <button type="button" className="fs-btn" disabled={busy} onClick={() => void save()}>
              {busy ? 'Saving…' : 'Save draft'}
            </button>
            <button type="button" className="fs-btn fs-btn--primary" disabled={busy} onClick={() => void saveAndSubmit()}>
              Send to Hilom →
            </button>
          </>
        )}
      </ActionBar>
    </div>
  );
}

/** Suggestions, not a fixed list — the field stays free text. */
function FormatOptions() {
  return (
    <datalist id="fs-format-options">
      <option value="Online" />
      <option value="In person" />
      <option value="Hybrid" />
    </datalist>
  );
}

// ---------------------------------------------------------------------------

/**
 * The multi-date proposal form.
 *
 * Everything `EventProposalForm` says about what is conspicuously absent
 * applies here too, plus one field that form doesn't have: the price and
 * capacity are still not Hilom's numbers, they are what the facilitator is
 * *asking* for — the admin sets the real ones at approval (see the note on
 * `event_series.proposed_price_centavos`).
 *
 * Dates are edited separately from content, mirroring the two-write split the
 * backend makes (`saveMyEventSeries` for content, `replaceMyEventSeriesDates`
 * for the list) — but from here both go out together on Save, since asking a
 * facilitator to remember two save buttons for one form would be its own bug.
 */
function SeriesProposalForm({
  seriesId,
  existing,
  onDone,
  onCancel,
}: {
  seriesId: string | null;
  existing: MyEventSeries | null;
  onDone: (saved: MyEventSeries, message?: string) => void;
  onCancel: () => void;
}) {
  const local = (iso: string | null) => (iso ? iso.slice(0, 16) : '');
  const existingDates = existing?.dates ?? [];

  const [draft, setDraft] = useState({
    title: existing?.title ?? '',
    subtitle: '',
    excerpt: '',
    description: '',
    location: '',
    venue_details: '',
    format: '',
    image_url: '',
    image_alt: '',
    proposed_price: existing?.proposed_price_centavos != null ? (existing.proposed_price_centavos / 100).toFixed(2) : '',
    proposed_capacity: existing?.proposed_capacity != null ? String(existing.proposed_capacity) : '',
  });
  const [dates, setDates] = useState<{ starts_at: string; ends_at: string }[]>(
    existingDates.length > 0
      ? existingDates.map((d) => ({ starts_at: local(d.starts_at), ends_at: local(d.ends_at) }))
      : [{ starts_at: '', ends_at: '' }],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The series list carries no content fields, so an edit loads them from a
  // date first. Saving before that lands would write blanks onto every date.
  const [loaded, setLoaded] = useState(!seriesId);

  useEffect(() => {
    if (!seriesId) return;
    let live = true;
    getMyEventSeries(seriesId)
      .then(({ dates: rows }) => {
        if (!live) return;
        const first = rows[0];
        if (first) {
          setDraft((d) => ({
            ...d,
            subtitle: first.subtitle ?? '',
            excerpt: first.excerpt ?? '',
            description: first.description ?? '',
            location: first.location ?? '',
            venue_details: first.venue_details ?? '',
            format: first.format ?? '',
            image_url: first.image_url ?? '',
            image_alt: first.image_alt ?? '',
          }));
        }
        setLoaded(true);
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [seriesId]);

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const setDate = (i: number, field: 'starts_at' | 'ends_at', value: string) =>
    setDates((list) => list.map((d, idx) => (idx === i ? { ...d, [field]: value } : d)));

  const content = () => ({
    title: draft.title,
    subtitle: draft.subtitle,
    excerpt: draft.excerpt,
    description: draft.description,
    location: draft.location,
    venue_details: draft.venue_details,
    format: draft.format,
    image: draft.image_url ? { id: null, url: draft.image_url, alt: draft.image_alt } : null,
    proposed_price_centavos: draft.proposed_price.trim() ? Math.round(Number(draft.proposed_price) * 100) : null,
    proposed_capacity: draft.proposed_capacity.trim() ? Number(draft.proposed_capacity) : null,
  });

  const dateList = () =>
    dates
      .filter((d) => d.starts_at)
      .map((d) => ({
        starts_at: new Date(d.starts_at).toISOString(),
        ends_at: d.ends_at ? new Date(d.ends_at).toISOString() : null,
      }));

  async function save(keepOpen = false): Promise<MyEventSeries | null> {
    setBusy(true);
    setError(null);
    try {
      const builtDates = dateList();
      if (builtDates.length === 0) throw new Error('Add at least one date.');

      let saved: MyEventSeries;
      if (!seriesId) {
        const input: EventSeriesInput = { ...content(), dates: builtDates };
        const res = await createMyEventSeries(input);
        saved = res.series;
      } else {
        const res = await saveMyEventSeries(seriesId, content());
        const res2 = await replaceMyEventSeriesDates(seriesId, builtDates);
        saved = res2.series ?? res.series;
      }
      if (!keepOpen) onDone(saved);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveAndSubmit() {
    const saved = await save(true);
    if (!saved) return;
    setBusy(true);
    setError(null);
    try {
      const submitted = await submitMyEventSeries(saved.id);
      onDone(submitted, 'Sent to Hilom for review.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit');
    } finally {
      setBusy(false);
    }
  }

  const filledDates = dates.filter((d) => d.starts_at);
  const firstDate = [...filledDates].sort((x, y) => x.starts_at.localeCompare(y.starts_at))[0];

  return (
    <div className="fs-page">
      <PageHeader
        title={seriesId ? 'Edit series' : 'Propose a series'}
        back={{ label: 'All events', onClick: onCancel }}
        subtitle="A multi-date programme, reviewed once. Your price and capacity are an ask — Hilom sets the final numbers and commission when approving."
      />

      {error && <div className="alert alert-error">{error}</div>}
      {!loaded && <div className="spinner" aria-label="Loading" />}

      <div className="fs-profile">
        <div className="fs-profile-main">
          <Section step={1} title="The basics" hint="Shown to Hilom in the review queue. Each date can have its own title once approved.">
            <label className="field">
              <span>Title</span>
              <input value={draft.title} onChange={(e) => set('title', e.target.value)} placeholder="Six Weeks of Stillness" />
            </label>
            <label className="field">
              <span>Subtitle</span>
              <input value={draft.subtitle} onChange={(e) => set('subtitle', e.target.value)} />
            </label>
          </Section>

          <Section
            step={2}
            title="Dates"
            hint={`${filledDates.length} ${filledDates.length === 1 ? 'date' : 'dates'} · times in your own timezone`}
          >
            <ol className="fs-dates">
              {dates.map((d, i) => (
                <li key={i}>
                  <span className="fs-dates-n">{i + 1}</span>
                  <input
                    type="datetime-local"
                    value={d.starts_at}
                    onChange={(e) => setDate(i, 'starts_at', e.target.value)}
                    aria-label={`Date ${i + 1} starts`}
                  />
                  <span className="fs-block-dash">→</span>
                  <input
                    type="datetime-local"
                    value={d.ends_at}
                    onChange={(e) => setDate(i, 'ends_at', e.target.value)}
                    aria-label={`Date ${i + 1} ends (optional)`}
                  />
                  <button
                    type="button"
                    className="fs-icon-btn"
                    disabled={dates.length === 1}
                    onClick={() => setDates((list) => list.filter((_, idx) => idx !== i))}
                    aria-label={`Remove date ${i + 1}`}
                    title="Remove"
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
            <div className="fs-dates-actions">
              <button
                type="button"
                className="fs-btn"
                onClick={() => setDates((list) => [...list, { starts_at: '', ends_at: '' }])}
              >
                ＋ Add a date
              </button>
              {/* The common case for a series is "same time, next week" — so
                  offer it from the last filled date rather than a blank row. */}
              {filledDates.length > 0 && (
                <button
                  type="button"
                  className="fs-btn fs-btn--quiet"
                  onClick={() =>
                    setDates((list) => {
                      const last = [...list].reverse().find((d) => d.starts_at);
                      if (!last) return list;
                      const shift = (v: string) => {
                        if (!v) return '';
                        const t = new Date(v);
                        t.setDate(t.getDate() + 7);
                        const pad = (n: number) => String(n).padStart(2, '0');
                        return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}`;
                      };
                      const next = { starts_at: shift(last.starts_at), ends_at: shift(last.ends_at) };
                      const blanks = list.filter((d) => !d.starts_at);
                      return blanks.length > 0
                        ? list.map((d) => (d === blanks[0] ? next : d))
                        : [...list, next];
                    })
                  }
                >
                  ＋ Same time next week
                </button>
              )}
            </div>
          </Section>

          <Section step={3} title="Where & format">
            <div className="two-col">
              <label className="field">
                <span>Where</span>
                <input value={draft.location} onChange={(e) => set('location', e.target.value)} placeholder="Via Zoom, or Quezon City" />
              </label>
              <label className="field">
                <span>Format</span>
                <input
                  value={draft.format}
                  onChange={(e) => set('format', e.target.value)}
                  placeholder="Online, in person, hybrid"
                  list="fs-format-options"
                />
                <FormatOptions />
              </label>
            </div>
          </Section>

          <Section step={4} title="Tell people about it" hint="What each session covers, who it's for, what to bring.">
            <label className="field">
              <span>Short summary</span>
              <textarea rows={2} value={draft.excerpt} onChange={(e) => set('excerpt', e.target.value)} />
            </label>
            <label className="field">
              <span>Description</span>
              <textarea
                rows={10}
                value={draft.description}
                onChange={(e) => set('description', e.target.value)}
                placeholder="What each session covers, who it is for, what people should bring."
              />
            </label>
            <label className="field">
              <span>Practical details</span>
              <textarea rows={3} value={draft.venue_details} onChange={(e) => set('venue_details', e.target.value)} />
            </label>
            <div className="two-col">
              <label className="field">
                <span>Poster image URL</span>
                <input value={draft.image_url} onChange={(e) => set('image_url', e.target.value)} placeholder="https://…" />
              </label>
              <label className="field">
                <span>Image description</span>
                <input value={draft.image_alt} onChange={(e) => set('image_alt', e.target.value)} />
              </label>
            </div>
          </Section>

          <Section step={5} title="Your ask" hint="A starting point for Hilom — the final price, capacity and commission are confirmed at approval.">
            <div className="two-col">
              <label className="field">
                <span>Price per date (₱)</span>
                <div className="fs-affix">
                  <span>₱</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={draft.proposed_price}
                    onChange={(e) => set('proposed_price', e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </label>
              <label className="field">
                <span>Capacity per date</span>
                <div className="fs-affix">
                  <input
                    type="number"
                    min={1}
                    value={draft.proposed_capacity}
                    onChange={(e) => set('proposed_capacity', e.target.value)}
                    placeholder="20"
                  />
                  <span>people</span>
                </div>
              </label>
            </div>
          </Section>
        </div>

        <aside className="fs-profile-aside">
          <ListingPreview
            title={draft.title}
            subtitle={draft.subtitle}
            excerpt={draft.excerpt}
            imageUrl={draft.image_url}
            imageAlt={draft.image_alt}
            location={draft.location}
            format={draft.format}
            dateLabel={
              firstDate
                ? `${localDateLabel(firstDate.starts_at)}${filledDates.length > 1 ? ` · +${filledDates.length - 1} more` : ''}`
                : ''
            }
          />
          <ReviewSteps series />
        </aside>
      </div>

      <ActionBar status={`${filledDates.length} ${filledDates.length === 1 ? 'date' : 'dates'} in this series`}>
        <button type="button" className="fs-btn fs-btn--quiet" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="fs-btn" disabled={busy || !loaded} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save draft'}
        </button>
        <button type="button" className="fs-btn fs-btn--primary" disabled={busy || !loaded} onClick={() => void saveAndSubmit()}>
          Send to Hilom →
        </button>
      </ActionBar>
    </div>
  );
}
