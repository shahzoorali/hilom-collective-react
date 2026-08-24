/**
 * Managed events — elevated dashboard for event scheduling and publishing.
 *
 * Features overview stat cards, search & filter toolbar, formatted date badges,
 * and an elevated slide-over editor with RichText, Media picker, and live link previews.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  adminCreateEvent,
  adminDeleteEvent,
  adminListEvents,
  adminUpdateEvent,
  type AdminEvent,
  type AdminEventInput,
} from '../../lib/cms';
import type { MediaRef } from '../../cms/blocks';
import MediaField from './MediaField';
import RichTextEditor from './RichTextEditor';
import EventTicketingEditor, {
  blankTicketing,
  ticketingToDraft,
  ticketingToInput,
  type TicketingDraft,
} from './EventTicketingEditor';

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

export default function EventsTab({ adminKey }: { adminKey: string }) {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [openId, setOpenId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [searchQuery, setSearchQuery] = useState('');
  const [timeFilter, setTimeFilter] = useState<'all' | 'upcoming' | 'past'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'published' | 'draft'>('all');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    setOpenId('new');
    setError(null);
    setNotice(null);
  }

  function openEdit(event: AdminEvent) {
    setDraft(toDraft(event));
    setOpenId(event.id);
    setError(null);
    setNotice(null);
  }

  async function save() {
    if (!draft.title.trim()) return setError('Title is required.');
    if (!draft.starts_at) return setError('Start date/time is required.');

    setBusy(true);
    setError(null);
    try {
      const input = toInput(draft);
      if (openId === 'new') {
        await adminCreateEvent(adminKey, input);
        setNotice('Event created successfully.');
      } else if (openId) {
        await adminUpdateEvent(adminKey, openId, input);
        setNotice('Event saved successfully.');
      }
      setOpenId(null);
      await reload();
      setTimeout(() => setNotice(null), 3500);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(event: AdminEvent) {
    if (!window.confirm(`Delete event "${event.title}"? This cannot be undone.`)) return;
    try {
      await adminDeleteEvent(adminKey, event.id);
      await reload();
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

      const matchesStatus = statusFilter === 'all' || e.status === statusFilter;

      return matchesSearch && matchesTime && matchesStatus;
    });
  }, [events, searchQuery, timeFilter, statusFilter, now]);

  // Stats
  const upcomingCount = events.filter((e) => new Date(e.ends_at ?? e.starts_at).getTime() >= now).length;
  const pastCount = events.filter((e) => new Date(e.ends_at ?? e.starts_at).getTime() < now).length;
  const publishedCount = events.filter((e) => e.status === 'published').length;

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
              onChange={(e) => setStatusFilter(e.target.value as 'all' | 'published' | 'draft')}
            >
              <option value="all">All Statuses</option>
              <option value="published">Published</option>
              <option value="draft">Drafts</option>
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
                    <th>Status</th>
                    <th style={{ textAlign: 'right' }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEvents.map((event) => {
                    const isPast = new Date(event.ends_at ?? event.starts_at).getTime() < now;
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
                        <td>
                          <span className={event.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                            {event.status}
                          </span>
                        </td>
                        <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <button className="btn btn-primary small" onClick={() => openEdit(event)}>
                            Edit
                          </button>
                          <button
                            className="btn btn-ghost small"
                            style={{ marginLeft: '0.35rem', color: 'var(--danger-fg)' }}
                            onClick={() => remove(event)}
                          >
                            Delete
                          </button>
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
            <button className="btn btn-ghost small" onClick={() => setOpenId(null)}>
              ← Back to list
            </button>
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
              <label>Full Event Description</label>
              <RichTextEditor
                value={draft.description}
                onChange={(html) => setDraft((d) => ({ ...d, description: html }))}
              />
            </div>
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
