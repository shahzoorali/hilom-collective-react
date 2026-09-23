/**
 * Managed events — elevated dashboard for event scheduling and publishing.
 *
 * Features overview stat cards, search & filter toolbar, formatted date badges,
 * and an elevated slide-over editor with RichText, Media picker, and live link previews.
 *
 * **Publishing has two doors and one lock.** Status can be flipped from the
 * list in a click or set in the editor's dropdown, but both routes run the same
 * `publishChecks`, because a checklist the quick button walks around is not a
 * checklist. The blocking checks are the three that make a ticketed event
 * unbuyable rather than merely unpolished — no format, no capacity, no live
 * payment plan — and the last of those is the one nothing on the write path
 * could ever catch, since plans live in their own table behind their own save.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  adminCreateEvent,
  adminDeleteEvent,
  adminGetEventPlans,
  adminListEvents,
  adminReplaceEventPlans,
  adminSetEventStatus,
  adminReviewEvent,
  adminUpdateEvent,
  adminListEventSeries,
  adminReviewEventSeries,
  adminCancelEvent,
  adminReviewEventEdit,
  type AdminEvent,
  type AdminEventInput,
  type AdminEventSeries,
} from '../../lib/cms';
import { money } from '../../components/Layout';
import type { MediaRef } from '../../cms/blocks';
import MediaField from './MediaField';
import RichTextEditor from './RichTextEditor';
import EventTicketingEditor, {
  blankTicketing,
  ticketingToDraft,
  ticketingToInput,
  type TicketingDraft,
} from './EventTicketingEditor';
import { adminConfirm, adminToast } from './ui/feedback';

function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

interface Draft {
  title: string;
  subtitle: string;
  description: string;
  excerpt: string;
  image?: MediaRef;
  location: string;
  starts_at: string;
  ends_at: string;
  link_url: string;
  link_label: string;
  note: string;
  status: 'draft' | 'published';
  /** Null until the admin opens the ticketing section, which is what keeps a
   *  save from this form from touching a listing-only event's ticketing at
   *  all — the backend only applies ticketing when the body mentions it. */
  ticketing: TicketingDraft | null;
}

const blankDraft: Draft = {
  title: '',
  subtitle: '',
  description: '',
  excerpt: '',
  location: '',
  starts_at: '',
  ends_at: '',
  link_url: '',
  link_label: '',
  note: '',
  status: 'draft',
  ticketing: null,
};

function toDraft(event: AdminEvent): Draft {
  return {
    title: event.title,
    subtitle: event.subtitle ?? '',
    description: event.description ?? '',
    excerpt: event.excerpt ?? '',
    image: event.image_url ? { id: event.image_id ?? '', url: event.image_url, alt: event.image_alt ?? '' } : undefined,
    location: event.location ?? '',
    starts_at: toLocalInput(event.starts_at),
    ends_at: toLocalInput(event.ends_at),
    link_url: event.link_url ?? '',
    link_label: event.link_label ?? '',
    note: event.note ?? '',
    status: event.status,
    // Only pre-load ticketing for an event that already has it. Leaving this
    // null for a plain listing event means a save cannot disturb it.
    ticketing: event.ticketing_enabled ? ticketingToDraft(event) : null,
  };
}

function toInput(draft: Draft): AdminEventInput {
  return {
    title: draft.title.trim(),
    subtitle: draft.subtitle.trim() || undefined,
    description: draft.description || undefined,
    excerpt: draft.excerpt.trim() || undefined,
    image: draft.image,
    location: draft.location.trim() || undefined,
    starts_at: fromLocalInput(draft.starts_at) ?? '',
    ends_at: fromLocalInput(draft.ends_at),
    link_url: draft.link_url.trim() || undefined,
    link_label: draft.link_label.trim() || undefined,
    note: draft.note.trim() || undefined,
    status: draft.status,
    ...(draft.ticketing ? ticketingToInput(draft.ticketing) : {}),
  };
}

// ---------------------------------------------------------------------------
// Publish readiness
// ---------------------------------------------------------------------------

/**
 * "Ready to publish", reduced to booleans so the same rules can be asked of two
 * different shapes — a saved event on the list, and an unsaved draft in the
 * editor — without either growing its own copy of them.
 */
interface Readiness {
  hasDescription: boolean;
  hasImage: boolean;
  hasLocation: boolean;
  hasCta: boolean;
  ticketed: boolean;
  hasFormat: boolean;
  hasCapacity: boolean;
  activePlans: number;
}

interface Check {
  ok: boolean;
  /** A failing blocking check stops the publish. A failing soft one only says so. */
  blocking: boolean;
  label: string;
  /** How this reads inside a sentence when it fails: "…— no capacity set". */
  missing: string;
  hint: string;
}

/** Rich text with the tags taken off: an "empty" editor still returns `<p></p>`. */
const hasProse = (html: string | null | undefined): boolean =>
  Boolean(html?.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim());

/**
 * Everything worth knowing before an event goes on the site.
 *
 * Only three are blocking, and all three are about a ticketed event being
 * *unbuyable* rather than untidy. A missing cover image is a worse listing; a
 * missing payment plan is a Register button that leads to an empty page, which
 * is the failure people write in about.
 */
function publishChecks(r: Readiness): Check[] {
  const checks: Check[] = [
    {
      ok: r.hasDescription,
      blocking: false,
      label: 'Description written',
      missing: 'no description',
      hint: 'The listing card and the event page both fall back to an empty blurb without one.',
    },
    {
      ok: r.hasImage,
      blocking: false,
      label: 'Cover image set',
      missing: 'no cover image',
      hint: 'Events with no cover show a bare placeholder on the events page.',
    },
    {
      ok: r.hasLocation,
      blocking: false,
      label: 'Location given',
      missing: 'no location',
      hint: 'Even “Online (Zoom)” answers the question people ask first.',
    },
  ];

  if (!r.ticketed) {
    checks.push({
      ok: r.hasCta,
      blocking: false,
      label: 'Somewhere for a reader to go',
      missing: 'no call to action',
      hint: 'A listing-only event with no link leaves a reader nothing to act on.',
    });
    return checks;
  }

  // Format and capacity the backend already refuses on save, so checking them
  // here only moves the refusal somewhere the admin can act on it. The plan
  // count is the one nothing else is in a position to check.
  checks.push(
    {
      ok: r.hasFormat,
      blocking: true,
      label: 'Format chosen',
      missing: 'no format chosen',
      hint: 'Residential, virtual, or day — the registration page reads this.',
    },
    {
      ok: r.hasCapacity,
      blocking: true,
      label: 'Capacity set',
      missing: 'no capacity set',
      hint: 'With no seat count, every registration is refused as capacity_not_configured.',
    },
    {
      ok: r.activePlans > 0,
      blocking: true,
      label: 'At least one payment plan is live',
      missing: 'no payment plan is live',
      hint: 'Otherwise Register opens a page with nothing on it to buy.',
    },
  );
  return checks;
}

const blockersIn = (checks: Check[]): Check[] => checks.filter((c) => c.blocking && !c.ok);

function readinessOfEvent(event: AdminEvent): Readiness {
  return {
    hasDescription: hasProse(event.description),
    hasImage: Boolean(event.image_url),
    hasLocation: Boolean(event.location?.trim()),
    hasCta: Boolean(event.link_url?.trim()),
    ticketed: Boolean(event.ticketing_enabled),
    hasFormat: Boolean(event.format),
    hasCapacity: event.capacity != null,
    activePlans: event.active_plan_count ?? 0,
  };
}

/** The plan count cannot come from the draft — plans are saved separately. */
function readinessOfDraft(draft: Draft, activePlans: number): Readiness {
  return {
    hasDescription: hasProse(draft.description),
    hasImage: Boolean(draft.image?.url),
    hasLocation: Boolean(draft.location.trim()),
    hasCta: Boolean(draft.link_url.trim()),
    ticketed: Boolean(draft.ticketing?.ticketing_enabled),
    hasFormat: Boolean(draft.ticketing?.format),
    hasCapacity: Boolean(draft.ticketing?.capacity.trim()),
    activePlans,
  };
}

/**
 * Where an event actually lives on the site.
 *
 * There is no per-event page: a listing-only event is a card inside /events,
 * and a ticketed one has its own registration page. Linking both to /events
 * would send an admin checking a ticketed event to the wrong screen.
 */
const publicUrl = (event: AdminEvent): string =>
  event.ticketing_enabled ? `/events/${event.id}/register` : '/events';

export default function EventsTab({ adminKey }: { adminKey: string }) {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [openId, setOpenId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [searchQuery, setSearchQuery] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  const [timeFilter, setTimeFilter] = useState<'all' | 'upcoming' | 'past'>('all');
  // `?status=submitted` is how the dashboard hands over: its "event proposals"
  // card links here with the review queue already selected.
  const [searchParams] = useSearchParams();
  const initialStatus = searchParams.get('status');
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft' | 'submitted'>(
    initialStatus === 'submitted' || initialStatus === 'published' || initialStatus === 'draft'
      ? initialStatus
      : 'all',
  );
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Which row has an action in flight, so only that row's buttons go quiet. */
  const [busyRow, setBusyRow] = useState<string | null>(null);
  /**
   * Live plans for the event currently open in the editor. Seeded from the
   * list, then corrected by the ticketing editor once it has loaded or saved
   * its own plans — otherwise the checklist would keep refusing to publish
   * minutes after the plan that unblocks it was written.
   */
  const [openPlans, setOpenPlans] = useState(0);

  const navigate = useNavigate();

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(null), 3500);
  }

  async function reload() {
    try {
      setEvents(await adminListEvents(adminKey));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminKey]);

  function openNew() {
    setDraft(blankDraft);
    setOpenPlans(0);
    setOpenId('new');
    setError(null);
    setNotice(null);
  }

  function openEdit(event: AdminEvent) {
    setDraft(toDraft(event));
    setOpenPlans(event.active_plan_count ?? 0);
    setOpenId(event.id);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!draft.title.trim()) return setError('Title is required.');
    if (!draft.starts_at) return setError('Start date/time is required.');

    // Saving as published is publishing, so it answers to the same checklist
    // the list's one-click button does. Saving as a draft never does — a draft
    // is allowed to be half-finished; that is what a draft is for.
    if (draft.status === 'published' && editorBlockers.length > 0) {
      return setError(
        `Not ready to go live — ${editorBlockers.map((c) => c.missing).join(', ')}. ` +
          'Switch Publish Status back to Draft to save your work, or clear the checklist below.',
      );
    }

    const wasPublished = openEvent?.status === 'published';

    setBusy(true);
    setError(null);
    try {
      const input = toInput(draft);
      if (openId === 'new') {
        await adminCreateEvent(adminKey, input);
        flash(draft.status === 'published' ? 'Event created and published.' : 'Event created as a draft.');
      } else if (openId) {
        await adminUpdateEvent(adminKey, openId, input);
        flash(
          draft.status === 'published' && !wasPublished
            ? 'Saved and published — it is live on the site now.'
            : draft.status === 'draft' && wasPublished
              ? 'Saved and taken back to draft — it is off the site now.'
              : 'Event saved successfully.',
        );
      }
      setOpenId(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * The list's publish/unpublish button.
   *
   * Publishing runs the same blocking checks the editor does, against the row
   * as last loaded. Unpublishing asks first, and asks differently when people
   * are already registered — reverting a sold event to draft is a legitimate
   * thing to need (it is the only way to take a sold event off the site, since
   * it cannot be deleted) but it takes the registration page down for everyone
   * mid-payment, and that deserves saying out loud rather than discovering.
   */
  /**
   * Approve or reject a facilitator's proposal (0048).
   *
   * Approving publishes in the same call. The two are separable at the API
   * level — and deliberately so — but an admin who has just read a proposal
   * and pressed Approve means "put it on the site", and leaving it approved
   * and invisible is the state that generates "why isn't my event showing"
   * every time. Unpublishing afterwards is one click away and does not
   * un-approve it.
   *
   * A rejection without a note is refused by the backend, so the prompt loops
   * rather than sending something that will bounce.
   */
  async function decide(event: AdminEvent, decision: 'approve' | 'reject') {
    let note = '';
    if (decision === 'reject') {
      const typed = window.prompt(
        `What should ${event.title ? `“${event.title}”` : 'this event'} change before Hilom can publish it?

` +
          'The facilitator sees this note exactly as you write it.',
      );
      if (typed === null) return;
      note = typed.trim();
      if (!note) return setError('A rejection needs a note — it is the only explanation they get.');
    } else {
      const blockers = blockersIn(publishChecks(readinessOfEvent(event)));
      if (blockers.length > 0) {
        return setError(
          `“${event.title}” cannot be published yet — ${blockers.map((c) => c.missing).join(', ')}. ` +
            'Open it, set the ticketing and prices, then approve.',
        );
      }
    }

    setBusyRow(event.id);
    setError(null);
    try {
      await adminReviewEvent(adminKey, event.id, decision, {
        note: note || undefined,
        publish: decision === 'approve',
      });
      await reload();
      flash(
        decision === 'approve'
          ? `“${event.title}” is approved and live on the site.`
          : `“${event.title}” went back to its facilitator with your note.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  async function togglePublish(event: AdminEvent) {
    const next = event.status === 'published' ? 'draft' : 'published';

    if (next === 'published') {
      const blockers = blockersIn(publishChecks(readinessOfEvent(event)));
      if (blockers.length > 0) {
        return setError(
          `“${event.title}” is not ready to publish — ${blockers.map((c) => c.missing).join(', ')}. ` +
            'Open it and work through the publish checklist.',
        );
      }
    } else {
      const held = event.seats_taken ?? 0;
      const question =
        held > 0
          ? `${held} ${held === 1 ? 'person is' : 'people are'} registered or mid-payment for “${event.title}”. ` +
            'Reverting to draft takes the registration page down for them too. Their places and payments are ' +
            'untouched, but nobody can reach the page. Continue?'
          : `Take “${event.title}” off the site and back to draft?`;
      if (!(await adminConfirm({ title: 'Take this event down?', body: question, confirmLabel: 'Revert to draft', danger: true }))) return;
    }

    setBusyRow(event.id);
    setError(null);
    try {
      await adminSetEventStatus(adminKey, event.id, next);
      await reload();
      flash(
        next === 'published'
          ? `“${event.title}” is live on the site.`
          : `“${event.title}” is back to draft and off the site.`,
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  /**
   * Copies an event, its ticketing settings, and its payment plans into a new
   * draft — the recurring-event path, where the alternative is retyping a
   * four-instalment schedule from memory.
   *
   * Plans are copied through their own endpoint with every id dropped, so they
   * are written as new rows rather than moved off the original. Dates are kept
   * rather than cleared: `starts_at` is required, and a copy carrying the old
   * date is easier to correct than an empty field is to fill from nothing. The
   * editor opens straight away so that correction is the next thing that
   * happens.
   */
  async function duplicate(event: AdminEvent) {
    setBusyRow(event.id);
    setError(null);
    try {
      const created = await adminCreateEvent(adminKey, {
        ...toInput(toDraft(event)),
        title: `${event.title} (copy)`,
        status: 'draft',
        // Not part of Draft, so they would be lost in the round trip through
        // toDraft — and a retreat's facilitator roster is the last thing
        // anyone wants to rebuild by hand.
        facilitators: event.facilitators ?? [],
        gallery: event.gallery ?? [],
      });

      if (event.ticketing_enabled) {
        const plans = await adminGetEventPlans(adminKey, event.id);
        if (plans.length > 0) {
          await adminReplaceEventPlans(
            adminKey,
            created.id,
            plans.map((p) => ({
              name: p.name,
              description: p.description,
              kind: p.kind,
              total_centavos: p.total_centavos,
              currency: p.currency,
              available_from: p.available_from,
              available_until: p.available_until,
              is_active: p.is_active,
              sort_order: p.sort_order,
              installments: p.installments.map((i) => ({
                seq: i.seq,
                label: i.label,
                amount_centavos: i.amount_centavos,
                due_at: i.due_at,
                due_offset_days: i.due_offset_days,
                is_deposit: i.is_deposit,
              })),
            })),
          );
        }
      }

      await reload();
      openEdit(created);
      flash('Copied as a draft. Check the dates and the plan availability windows before publishing.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyRow(null);
    }
  }

  async function remove(event: AdminEvent) {
    if (
      !(await adminConfirm({
        title: `Delete “${event.title}”?`,
        body: 'The event, its page and its ticket setup are removed. This cannot be undone.',
        confirmLabel: 'Delete event',
        danger: true,
        typeToConfirm: 'DELETE',
      }))
    )
      return;
    try {
      await adminDeleteEvent(adminKey, event.id);
      await reload();
      adminToast.success(`Deleted “${event.title}”`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /**
   * Calls off one date. Unlike Delete, this is offered on an event *with*
   * registrations — that is the case it exists for — and refunds whatever
   * each confirmed registrant paid, in full. See the note on `cancelEventDate`
   * for why that is a different rule from the §III notice-period refund a
   * registrant's own cancellation goes through.
   */
  async function cancelEvent(event: AdminEvent) {
    const reason = window.prompt(
      `Cancel "${event.title}"? Confirmed registrants are emailed and fully refunded whatever they paid. Say why, for that email:`,
    );
    if (reason === null) return;
    if (!reason.trim()) {
      setError('Say why the date is being cancelled — registrants see this.');
      return;
    }
    try {
      const res = await adminCancelEvent(adminKey, event.id, reason.trim());
      await reload();
      flash(
        res.refundsOwed > 0
          ? `Cancelled — ${res.refundsOwed} refund${res.refundsOwed === 1 ? '' : 's'} owed, in the Payouts queue.`
          : 'Cancelled.',
      );
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const now = Date.now();

  // Filter computation
  const filteredEvents = useMemo(() => {
    return events.filter((e) => {
      const isPast = new Date(e.ends_at ?? e.starts_at).getTime() < now;
      const matchesSearch =
        !searchQuery.trim() ||
        e.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (e.location && e.location.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (e.subtitle && e.subtitle.toLowerCase().includes(searchQuery.toLowerCase()));

      const matchesTime =
        timeFilter === 'all' ||
        (timeFilter === 'upcoming' && !isPast) ||
        (timeFilter === 'past' && isPast);

      // 'submitted' filters on the moderation axis, not the publication one —
      // it is the review queue, which is the whole reason the option exists.
      const matchesStatus =
        statusFilter === 'all' ||
        (statusFilter === 'submitted' ? e.review_status === 'submitted' : e.status === statusFilter);

      return matchesSearch && matchesTime && matchesStatus;
    });
  }, [events, searchQuery, timeFilter, statusFilter, now]);

  /** The saved row behind the editor — undefined while creating. */
  const openEvent = openId && openId !== 'new' ? events.find((e) => e.id === openId) : undefined;

  // The open event's readiness. Computed every render rather than memoised:
  // it is a handful of boolean reads, and it has to track every keystroke in
  // the form for the checklist to be worth looking at while typing.
  const editorChecks = publishChecks(readinessOfDraft(draft, openPlans));
  const editorBlockers = blockersIn(editorChecks);

  // Stats
  const upcomingCount = events.filter((e) => new Date(e.ends_at ?? e.starts_at).getTime() >= now).length;
  const pastCount = events.filter((e) => new Date(e.ends_at ?? e.starts_at).getTime() < now).length;
  const publishedCount = events.filter((e) => e.status === 'published').length;
  const submittedCount = events.filter((e) => e.review_status === 'submitted').length;

  return (
    <>
      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}
      {notice && <div className="alert alert-success" style={{ marginBottom: '1rem' }}>{notice}</div>}

      {/* Stats Overview */}
      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Total Events</span>
          <span className="admin-stat-card__value">{events.length}</span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Upcoming</span>
          <span className="admin-stat-card__value" style={{ color: 'var(--forest)' }}>
            {upcomingCount}
          </span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Past Events</span>
          <span className="admin-stat-card__value" style={{ color: 'var(--muted)' }}>
            {pastCount}
          </span>
        </div>
        <div className="admin-stat-card">
          <span className="admin-stat-card__label">Published</span>
          <span className="admin-stat-card__value" style={{ color: 'var(--forest-dark)' }}>
            {publishedCount}
          </span>
        </div>
      </div>

      {/* Multi-date proposals (0054). Its own panel, not a row in the table
          below — a series isn't one event, and squeezing it into that table
          would mean either hiding its dates or inventing a fake event row for
          it. Rendered above the list because a submission waiting on a
          decision is more urgent than browsing everything already live. */}
      {!openId && <SeriesReviewPanel adminKey={adminKey} onError={setError} onDone={flash} />}
      {!openId && (
        <EditReviewPanel
          adminKey={adminKey}
          events={events.filter((e) => e.pending_changes)}
          onError={setError}
          onDone={(message) => {
            flash(message);
            void reload();
          }}
        />
      )}

      {/* Events List View */}
      {!openId ? (
        <div className="panel">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
            <h2 style={{ fontSize: '1.15rem', margin: 0 }}>All Events ({filteredEvents.length})</h2>
            <button className="btn btn-primary" onClick={openNew}>
              + Create Event
            </button>
          </div>

          {/* Search & Filter Bar */}
          <div className="admin-toolbar">
            <input
              type="text"
              className="search-input"
              placeholder="Search events by title, subtitle, or location…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />

            <select
              value={timeFilter}
              onChange={(e) => setTimeFilter(e.target.value as 'all' | 'upcoming' | 'past')}
            >
              <option value="all">All Timeline</option>
              <option value="upcoming">Upcoming Events ({upcomingCount})</option>
              <option value="past">Past Events ({pastCount})</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as 'all' | 'published' | 'draft' | 'submitted')
              }
            >
              <option value="all">All Statuses</option>
              <option value="published">Published</option>
              <option value="draft">Drafts</option>
              <option value="submitted">Awaiting review ({submittedCount})</option>
            </select>

            {(searchQuery || timeFilter !== 'all' || statusFilter !== 'all') && (
              <button
                className="btn btn-ghost small"
                onClick={() => {
                  setSearchQuery('');
                  setTimeFilter('all');
                  setStatusFilter('all');
                }}
              >
                Reset Filters
              </button>
            )}
          </div>

          {filteredEvents.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center' }}>
              <p className="muted">
                {events.length === 0 ? 'No events scheduled yet.' : 'No events match your filter criteria.'}
              </p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: 48 }}>Cover</th>
                    <th>Event Details</th>
                    <th>Schedule</th>
                    <th>Location</th>
                    <th>Registration</th>
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((event) => {
                    const isPast = new Date(event.ends_at ?? event.starts_at).getTime() < now;
                    const rowBusy = busyRow === event.id;
                    const seats = event.seats_taken ?? 0;
                    const blockers = blockersIn(publishChecks(readinessOfEvent(event)));
                    return (
                      <tr key={event.id} style={isPast ? { opacity: 0.7 } : undefined}>
                        <td>
                          {event.image_url ? (
                            <img
                              src={event.image_url}
                              alt=""
                              style={{ width: 44, height: 32, borderRadius: 4, objectFit: 'cover', display: 'block' }}
                            />
                          ) : (
                            <div
                              style={{
                                width: 44,
                                height: 32,
                                borderRadius: 4,
                                background: 'var(--cream)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '0.7rem',
                                color: 'var(--muted)',
                              }}
                            >
                              📅
                            </div>
                          )}
                        </td>
                        <td>
                          <strong style={{ fontSize: '0.95rem', display: 'block' }}>{event.title}</strong>
                          {event.subtitle && <span className="small muted">{event.subtitle}</span>}
                        </td>
                        <td className="small">
                          <div>{new Date(event.starts_at).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                          <div className="muted">{new Date(event.starts_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
                          {isPast && <span className="pill" style={{ fontSize: '0.7rem', padding: '0.1rem 0.4rem', background: '#e0e0e0', marginTop: '0.2rem' }}>Past</span>}
                        </td>
                        <td className="small">
                          {event.location ? <span>📍 {event.location}</span> : <span className="muted">—</span>}
                        </td>
                        <td className="small">
                          {event.ticketing_enabled ? (
                            <>
                              <button
                                type="button"
                                className="btn btn-ghost small"
                                style={{ padding: '0.1rem 0.35rem', marginLeft: '-0.35rem' }}
                                onClick={() => navigate(`/admin/registrations?event=${event.id}`)}
                                title="Open this event's roster"
                              >
                                {seats} registered ↗
                              </button>
                              <div className="muted">
                                {event.capacity == null ? 'no capacity set' : `of ${event.capacity} places`}
                              </div>
                            </>
                          ) : (
                            <span className="muted">listing only</span>
                          )}
                        </td>
                        <td>
                          <span className={event.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                            {event.status}
                          </span>
                          {event.cancelled_at && (
                            <span
                              className="pill pill-bad"
                              style={{ marginLeft: '0.3rem' }}
                              title={event.cancel_reason ?? undefined}
                            >
                              cancelled
                            </span>
                          )}
                          {event.pending_changes && (
                            <span className="pill pill-warn" style={{ marginLeft: '0.3rem' }}>
                              edit pending
                            </span>
                          )}
                          {/* Moderation is a second axis, not a second value
                              of `status` — an approved event can still be
                              unpublished, and that must not read as
                              un-approving it (0048). Only shown when it says
                              something: `approved` is the default for every
                              admin-authored row and would be noise on all of
                              them. */}
                          {event.review_status !== 'approved' && (
                            <span
                              className={event.review_status === 'submitted' ? 'pill pill-warn' : 'pill'}
                              style={{ marginLeft: '0.3rem', fontSize: '0.7rem' }}
                              title={event.review_note ?? undefined}
                            >
                              {event.review_status === 'submitted'
                                ? 'awaiting review'
                                : event.review_status === 'rejected'
                                  ? 'changes requested'
                                  : 'facilitator draft'}
                            </span>
                          )}
                          {/* A published event that fails a blocking check is
                              already live and already broken — the one state
                              on this screen worth flagging without being
                              asked. */}
                          {event.status === 'published' && blockers.length > 0 && (
                            <span
                              className="pill pill-bad"
                              style={{ marginLeft: '0.3rem', fontSize: '0.7rem' }}
                              title={blockers.map((c) => c.hint).join('\n')}
                            >
                              ⚠ {blockers[0]!.missing}
                            </span>
                          )}
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          {event.status === 'published' && (
                            <a
                              href={publicUrl(event)}
                              target="_blank"
                              rel="noreferrer"
                              className="btn btn-ghost small"
                              style={{ marginRight: '0.35rem', textDecoration: 'none' }}
                              title="View this event on the site"
                            >
                              View ↗
                            </a>
                          )}
                          {/* A submission is reviewed, not published. Publish
                              is hidden rather than disabled while it waits,
                              because 0048's constraint would reject it anyway
                              and a disabled button invites a support question
                              about why. */}
                          {event.review_status === 'submitted' ? (
                            <>
                              <button
                                className="btn btn-primary small"
                                style={{ marginRight: '0.35rem' }}
                                onClick={() => void decide(event, 'approve')}
                                disabled={rowBusy}
                                title="Approve this proposal and put it on the site"
                              >
                                {rowBusy ? '…' : 'Approve'}
                              </button>
                              <button
                                className="btn btn-ghost small"
                                style={{ marginRight: '0.35rem' }}
                                onClick={() => void decide(event, 'reject')}
                                disabled={rowBusy}
                                title="Send this back to the facilitator with a note"
                              >
                                Request changes
                              </button>
                            </>
                          ) : (
                            <button
                              className="btn btn-ghost small"
                              style={{ marginRight: '0.35rem' }}
                              onClick={() => void togglePublish(event)}
                              disabled={rowBusy}
                              title={
                                event.status === 'published'
                                  ? 'Take this event off the site'
                                  : blockers.length > 0
                                    ? `Not ready: ${blockers.map((c) => c.missing).join(', ')}`
                                    : 'Put this event on the site'
                              }
                            >
                              {rowBusy ? '…' : event.status === 'published' ? 'Unpublish' : 'Publish'}
                            </button>
                          )}
                          <button className="btn btn-primary small" onClick={() => openEdit(event)}>
                            Edit
                          </button>
                          <button
                            className="btn btn-ghost small"
                            style={{ marginLeft: '0.35rem' }}
                            onClick={() => void duplicate(event)}
                            disabled={rowBusy}
                            title="Copy this event, its ticketing and its plans into a new draft"
                          >
                            Duplicate
                          </button>
                          {event.ticketing_enabled && !event.cancelled_at ? (
                            <button
                              className="btn btn-ghost small"
                              style={{ marginLeft: '0.35rem', color: 'var(--danger-fg)' }}
                              onClick={() => void cancelEvent(event)}
                              title="Take this date off sale and refund anyone who already paid"
                            >
                              Cancel date
                            </button>
                          ) : (
                            <button
                              className="btn btn-ghost small"
                              style={{ marginLeft: '0.35rem', color: 'var(--danger-fg)' }}
                              onClick={() => remove(event)}
                            >
                              Delete
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        /* Event Edit / Create Form */
        <div className="panel" style={{ maxWidth: 860, margin: '0 auto' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
            <h2 style={{ fontSize: '1.2rem', margin: 0 }}>
              {openId === 'new' ? 'Create New Event' : `Edit "${draft.title || 'Event'}"`}
            </h2>
            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
              {openEvent?.status === 'published' && (
                <a
                  href={publicUrl(openEvent)}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost small"
                  style={{ textDecoration: 'none' }}
                  title="View this event on the site"
                >
                  View ↗
                </a>
              )}
              <button className="btn btn-ghost small" onClick={() => setOpenId(null)}>
                ← Back to list
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1.25rem' }}>
            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Event Title *</label>
              <input
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                placeholder="e.g. Sound Bath & Community Circle"
              />
            </div>

            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Subtitle / Tagline</label>
              <input
                value={draft.subtitle}
                onChange={(e) => setDraft((d) => ({ ...d, subtitle: e.target.value }))}
                placeholder="Short one-line descriptor"
              />
            </div>

            <div className="field">
              <label>Starts At *</label>
              <input
                type="datetime-local"
                value={draft.starts_at}
                onChange={(e) => setDraft((d) => ({ ...d, starts_at: e.target.value }))}
              />
            </div>

            <div className="field">
              <label>Ends At (Optional)</label>
              <input
                type="datetime-local"
                value={draft.ends_at}
                onChange={(e) => setDraft((d) => ({ ...d, ends_at: e.target.value }))}
              />
            </div>

            <div className="field">
              <label>Location</label>
              <input
                value={draft.location}
                onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))}
                placeholder="e.g. Hilom Sanctuary, Makati or Online (Zoom)"
              />
            </div>

            <div className="field">
              <label>Publish Status</label>
              <select
                value={draft.status}
                onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value as 'draft' | 'published' }))}
              >
                <option value="draft">Draft (Private)</option>
                <option value="published">Published (Live on site)</option>
              </select>
            </div>

            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Registration &amp; payment</label>
              {draft.ticketing === null ? (
                <div className="panel" style={{ padding: 12 }}>
                  <p className="small muted" style={{ margin: '0 0 10px' }}>
                    This event is a listing only — people read about it and follow the link below. Turn on
                    registration to sell places, take payment, and track who has paid.
                  </p>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      setDraft((d) => ({ ...d, ticketing: { ...blankTicketing, ticketing_enabled: true } }))
                    }
                  >
                    Set up registration
                  </button>
                </div>
              ) : (
                <EventTicketingEditor
                  adminKey={adminKey}
                  eventId={openId === 'new' ? null : openId}
                  value={draft.ticketing}
                  onChange={(next) => setDraft((d) => ({ ...d, ticketing: next }))}
                  onActivePlanCount={setOpenPlans}
                />
              )}
            </div>

            <div className="field">
              <label>Call to Action / Registration URL</label>
              <input
                value={draft.link_url}
                onChange={(e) => setDraft((d) => ({ ...d, link_url: e.target.value }))}
                placeholder="https://… or /services"
              />
            </div>

            <div className="field">
              <label>Button Label</label>
              <input
                value={draft.link_label}
                onChange={(e) => setDraft((d) => ({ ...d, link_label: e.target.value }))}
                placeholder="Register Now (default)"
              />
            </div>

            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Badge / Highlighted Note (e.g. 'Early Bird', 'Free Admission')</label>
              <input
                value={draft.note}
                onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
                placeholder="Short badge text"
              />
            </div>

            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Cover Image</label>
              <MediaField
                adminKey={adminKey}
                value={draft.image}
                onChange={(img) => setDraft((d) => ({ ...d, image: img }))}
              />
            </div>

            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Card Excerpt</label>
              <textarea
                rows={2}
                maxLength={500}
                value={draft.excerpt}
                onChange={(e) => setDraft((d) => ({ ...d, excerpt: e.target.value }))}
                placeholder="Short blurb shown on the events listing card. Leave blank to use the description's first paragraph."
              />
            </div>

            <div className="field" style={{ gridColumn: 'span 2' }}>
              <label>Full Event Description</label>
              <RichTextEditor
                value={draft.description}
                onChange={(html) => setDraft((d) => ({ ...d, description: html }))}
              />
            </div>
          </div>

          <div className="panel" style={{ marginBottom: '1rem' }}>
            <strong style={{ fontSize: '0.95rem' }}>Publish checklist</strong>
            <p className="small muted" style={{ margin: '0.25rem 0 0.75rem' }}>
              {editorBlockers.length > 0
                ? 'The items marked ✗ have to be settled before this event can go on the site.'
                : 'Nothing is standing in the way. The unticked items below are worth doing, but will not stop you.'}
            </p>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: '0.4rem' }}>
              {editorChecks.map((check) => (
                <li key={check.label} style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline' }}>
                  <span
                    aria-hidden
                    style={{
                      color: check.ok
                        ? 'var(--forest)'
                        : check.blocking
                          ? 'var(--danger-fg)'
                          : 'var(--muted)',
                    }}
                  >
                    {check.ok ? '✓' : check.blocking ? '✗' : '•'}
                  </span>
                  <span className="small">
                    <span style={{ fontWeight: check.ok ? 400 : 600 }}>{check.label}</span>
                    {!check.ok && <span className="muted"> — {check.hint}</span>}
                  </span>
                </li>
              ))}
            </ul>
            {openId === 'new' && draft.ticketing?.ticketing_enabled && (
              <p className="small muted" style={{ margin: '0.75rem 0 0' }}>
                Payment plans need an event to belong to, so save this as a draft first — the plan builder
                opens once it exists, and this checklist will clear.
              </p>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', paddingTop: '1rem', borderTop: '1px solid var(--line)' }}>
            <button className="btn btn-ghost" onClick={() => setOpenId(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save} disabled={busy || !draft.title.trim()}>
              {busy ? 'Saving…' : openId === 'new' ? 'Create Event' : 'Save Changes'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------

/** How each `pending_changes` key is labelled for an admin comparing old vs new. */
const CHANGE_LABELS: Record<string, string> = {
  title: 'Title',
  starts_at: 'Starts',
  ends_at: 'Ends',
  location: 'Where',
  format: 'Format',
};

function formatChangeValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (field === 'starts_at' || field === 'ends_at') {
    return new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(String(value)));
  }
  return String(value);
}

/**
 * Edits to already-approved events, waiting on a decision (0058).
 *
 * Fed from the events already loaded by the parent rather than a second
 * fetch — `adminListEvents` already carries `pending_changes` on every row,
 * so filtering client-side is one array pass instead of a round trip.
 * Renders nothing when empty, the same rule every review queue on this
 * screen follows.
 */
function EditReviewPanel({
  adminKey,
  events,
  onError,
  onDone,
}: {
  adminKey: string;
  events: AdminEvent[];
  onError: (message: string | null) => void;
  onDone: (message: string) => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);

  if (events.length === 0) return null;

  async function decide(event: AdminEvent, decision: 'approve' | 'reject') {
    let note: string | undefined;
    if (decision === 'reject') {
      const entered = window.prompt(`Why isn't "${event.title}"'s change being made? The facilitator sees this.`);
      if (entered === null) return;
      if (!entered.trim()) {
        onError('Say why — the facilitator sees this note.');
        return;
      }
      note = entered.trim();
    }
    setBusyId(event.id);
    onError(null);
    try {
      await adminReviewEventEdit(adminKey, event.id, decision, note);
      onDone(decision === 'approve' ? `Change to "${event.title}" is live.` : `Change to "${event.title}" declined.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="panel" style={{ marginBottom: '1.25rem', borderLeft: '3px solid var(--ochre-dark)' }}>
      <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>Edits awaiting review — {events.length}</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        A facilitator wants to change the title, date, location or format of an event already on the
        site. Nothing here has changed publicly yet.
      </p>

      {events.map((event) => (
        <div key={event.id} className="card" style={{ marginBottom: '0.6rem' }}>
          <strong>{event.title}</strong>
          <table className="small" style={{ margin: '0.5rem 0', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}></th>
                <th style={{ textAlign: 'left' }}>Now</th>
                <th style={{ textAlign: 'left' }}>Proposed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(event.pending_changes ?? {}).map(([field, value]) => (
                <tr key={field}>
                  <td className="muted">{CHANGE_LABELS[field] ?? field}</td>
                  <td>{formatChangeValue(field, (event as unknown as Record<string, unknown>)[field])}</td>
                  <td>
                    <strong>{formatChangeValue(field, value)}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ gap: '0.4rem' }}>
            <button
              className="btn btn-ghost small"
              disabled={busyId === event.id}
              onClick={() => void decide(event, 'reject')}
            >
              Decline
            </button>
            <button
              className="btn btn-primary small"
              disabled={busyId === event.id}
              onClick={() => void decide(event, 'approve')}
            >
              {busyId === event.id ? '…' : 'Approve'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Multi-date proposals awaiting a decision (0054).
 *
 * Renders nothing when the queue is empty, the same call PayoutsTab's
 * `ClassRefundsPanel` makes: a permanently visible "nothing to review" panel
 * is a thing people stop reading, and this one needs to be noticed on the day
 * it is not empty.
 *
 * Approving is the one step that also prices the series — see the note on
 * `adminReviewEventSeries`. The drawer below is where an admin sets that.
 */
function SeriesReviewPanel({
  adminKey,
  onError,
  onDone,
}: {
  adminKey: string;
  onError: (message: string | null) => void;
  onDone: (message: string) => void;
}) {
  const [series, setSeries] = useState<AdminEventSeries[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [reviewing, setReviewing] = useState<AdminEventSeries | null>(null);

  const reload = () => {
    adminListEventSeries(adminKey)
      .then((rows) => setSeries(rows.filter((s) => s.review_status === 'submitted' || s.review_status === 'rejected')))
      .catch((e: Error) => onError(e.message))
      .finally(() => setLoaded(true));
  };

  useEffect(reload, [adminKey]);

  if (!loaded || series.length === 0) return null;

  return (
    <div className="panel" style={{ marginBottom: '1.25rem', borderLeft: '3px solid var(--ochre-dark)' }}>
      <h3 style={{ marginTop: 0, fontSize: '1.05rem' }}>Series awaiting review — {series.length}</h3>
      <p className="small muted" style={{ marginTop: 0 }}>
        A multi-date programme a facilitator proposed. Approving sets the price, capacity and
        Hilom's commission for every date at once.
      </p>

      {series.map((s) => (
        <div key={s.id} className="card" style={{ marginBottom: '0.6rem' }}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
            <div>
              <strong>{s.title}</strong>{' '}
              <span className="small muted">by {s.facilitators?.display_name ?? 'Unknown'}</span>
              {s.review_status === 'rejected' && (
                <span className="pill pill-warn" style={{ marginLeft: '0.4rem', fontSize: '0.7rem' }}>
                  resubmitted
                </span>
              )}
              {s.proposed_price_centavos !== null && (
                <p className="small muted" style={{ margin: '0.2rem 0 0' }}>
                  Asked {money(s.proposed_price_centavos)}/date
                  {s.proposed_capacity !== null && ` · ${s.proposed_capacity} seats`}
                </p>
              )}
            </div>
            <button type="button" className="btn btn-primary small" onClick={() => setReviewing(s)}>
              Review
            </button>
          </div>
        </div>
      ))}

      {reviewing && (
        <SeriesReviewDrawer
          adminKey={adminKey}
          series={reviewing}
          onClose={() => setReviewing(null)}
          onDecided={(message) => {
            setReviewing(null);
            onDone(message);
            reload();
          }}
          onError={onError}
        />
      )}
    </div>
  );
}

/**
 * The decision: approve with a price, capacity and commission, or reject with
 * a note. Price and capacity default to the facilitator's ask, editable —
 * changed fields are what the facilitator's decision email cannot show them
 * until they open their dashboard, so this is the one place to get them right.
 */
function SeriesReviewDrawer({
  adminKey,
  series,
  onClose,
  onDecided,
  onError,
}: {
  adminKey: string;
  series: AdminEventSeries;
  onClose: () => void;
  onDecided: (message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [priceInput, setPriceInput] = useState(
    series.proposed_price_centavos !== null ? (series.proposed_price_centavos / 100).toFixed(2) : '',
  );
  const [capacityInput, setCapacityInput] = useState(
    series.proposed_capacity !== null ? String(series.proposed_capacity) : '',
  );
  const [commissionInput, setCommissionInput] = useState('20');
  const [note, setNote] = useState('');
  const [publish, setPublish] = useState(true);
  const [busy, setBusy] = useState(false);

  const price = priceInput.trim() ? Math.round(Number(priceInput) * 100) : null;
  const commissionBps = commissionInput.trim() ? Math.round(Number(commissionInput) * 100) : null;
  const hilomCut = price !== null && commissionBps !== null ? Math.floor((price * commissionBps) / 10_000) : null;

  async function approve() {
    if (price === null || price < 0) return onError('Set a price before approving.');
    if (!capacityInput.trim() || Number(capacityInput) < 1) return onError('Set a capacity before approving.');
    if (commissionBps === null || commissionBps < 0 || commissionBps > 10_000) {
      return onError('Set a commission between 0% and 100%.');
    }
    setBusy(true);
    onError(null);
    try {
      const res = await adminReviewEventSeries(adminKey, series.id, 'approve', {
        note: note.trim() || undefined,
        publish,
        platformFeeBps: commissionBps,
        priceCentavos: price,
        capacity: Number(capacityInput),
      });
      onDecided(`Approved — ${res.dateCount} date${res.dateCount === 1 ? '' : 's'}${publish ? ', published' : ''}.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    if (!note.trim()) return onError('Say why it was rejected — the facilitator sees this note.');
    setBusy(true);
    onError(null);
    try {
      await adminReviewEventSeries(adminKey, series.id, 'reject', { note: note.trim() });
      onDecided('Sent back for changes.');
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel" style={{ marginTop: '0.75rem', background: 'var(--surface-2, #f7f5ee)' }}>
      <h4 style={{ marginTop: 0 }}>Review "{series.title}"</h4>

      <div className="two-col">
        <label className="field">
          <span>Price per date (₱)</span>
          <input type="number" min={0} step="0.01" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} />
        </label>
        <label className="field">
          <span>Capacity per date</span>
          <input type="number" min={1} value={capacityInput} onChange={(e) => setCapacityInput(e.target.value)} />
        </label>
      </div>

      <label className="field">
        <span>Hilom's commission (%)</span>
        <input type="number" min={0} max={100} step="0.1" value={commissionInput} onChange={(e) => setCommissionInput(e.target.value)} />
        {hilomCut !== null && (
          <small className="muted">Per ticket: Hilom {money(hilomCut)} · facilitator {money((price ?? 0) - hilomCut)}</small>
        )}
      </label>

      <label className="field">
        <span>Note (required to reject, optional to approve)</span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs to change, or a note for the facilitator" />
      </label>

      <label className="row" style={{ gap: '0.4rem', alignItems: 'center' }}>
        <input type="checkbox" checked={publish} onChange={(e) => setPublish(e.target.checked)} />
        <span className="small">Publish immediately on approval</span>
      </label>

      <div className="row" style={{ gap: '0.5rem', marginTop: '0.5rem' }}>
        <button type="button" className="btn btn-ghost small" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="btn btn-secondary small" onClick={() => void reject()} disabled={busy}>
          Request changes
        </button>
        <button type="button" className="btn btn-accent small" onClick={() => void approve()} disabled={busy}>
          Approve{publish ? ' & publish' : ''}
        </button>
      </div>
    </div>
  );
}
