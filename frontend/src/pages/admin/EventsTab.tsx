/**
 * Managed events — create/edit/delete, structured start/end times, optional
 * image/link/note. Replaces hand-authoring event cards as page blocks: the
 * Events page just drops in one `eventGrid` block that renders whatever is
 * published here, sorted into Upcoming and Past automatically.
 */
import { useEffect, useState } from 'react';
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

/** <input type="datetime-local"> wants "YYYY-MM-DDTHH:mm" in local time, with
 *  no timezone suffix — it is not the same format Date#toISOString produces. */
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
  starts_at: string; // datetime-local value
  ends_at: string; // datetime-local value
  link_url: string;
  link_label: string;
  note: string;
  status: 'draft' | 'published';
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
  };
}

export default function EventsTab({ adminKey }: { adminKey: string }) {
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [openId, setOpenId] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
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
        setNotice('Event created.');
      } else if (openId) {
        await adminUpdateEvent(adminKey, openId, input);
        setNotice('Event saved.');
      }
      setOpenId(null);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(event: AdminEvent) {
    if (!window.confirm(`Delete "${event.title}"? This cannot be undone.`)) return;
    try {
      await adminDeleteEvent(adminKey, event.id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const now = Date.now();

  return (
    <>
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {!openId && (
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <h2 style={{ fontSize: '1.15rem', margin: 0 }}>Events</h2>
            <button className="btn btn-primary small" style={{ marginLeft: 'auto' }} onClick={openNew}>
              + New event
            </button>
          </div>

          {events.length === 0 ? (
            <p className="muted" style={{ marginTop: '1rem' }}>No events yet.</p>
          ) : (
            <div style={{ overflowX: 'auto', marginTop: '1rem' }}>
              <table>
                <thead>
                  <tr>
                    <th>Title</th><th>When</th><th>Status</th><th />
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => {
                    const past = new Date(event.ends_at ?? event.starts_at).getTime() < now;
                    return (
                      <tr key={event.id} style={past ? { opacity: 0.6 } : undefined}>
                        <td>
                          <strong>{event.title}</strong>
                          {event.subtitle && <div className="small muted">{event.subtitle}</div>}
                        </td>
                        <td className="small">
                          {new Date(event.starts_at).toLocaleString()}
                          {past && <div className="small muted">past</div>}
                        </td>
                        <td>
                          <span className={event.status === 'published' ? 'pill pill-ok' : 'pill pill-warn'}>
                            {event.status}
                          </span>
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <button className="btn btn-primary small" onClick={() => openEdit(event)}>
                            Edit
                          </button>
                          <button
                            className="btn btn-ghost small"
                            style={{ marginLeft: '0.35rem' }}
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
      )}

      {openId && (
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '0.8rem' }}>
            <h2 style={{ fontSize: '1.15rem', margin: 0 }}>{openId === 'new' ? 'New event' : 'Edit event'}</h2>
            <button className="btn btn-ghost small" style={{ marginLeft: 'auto' }} onClick={() => setOpenId(null)}>
              Cancel
            </button>
          </div>

          <div className="field">
            <label>Title</label>
            <input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
          </div>
          <div className="field">
            <label>Subtitle</label>
            <input value={draft.subtitle} onChange={(e) => setDraft({ ...draft, subtitle: e.target.value })} />
          </div>
          <div className="field">
            <label>Description</label>
            <RichTextEditor
              value={draft.description}
              onChange={(html) => setDraft({ ...draft, description: html })}
            />
          </div>
          <div className="field">
            <label>Image</label>
            <MediaField adminKey={adminKey} value={draft.image} onChange={(image) => setDraft({ ...draft, image })} />
          </div>
          <div className="field">
            <label>Location</label>
            <input
              placeholder="Via Zoom, or a venue"
              value={draft.location}
              onChange={(e) => setDraft({ ...draft, location: e.target.value })}
            />
          </div>
          <div className="row">
            <div className="field">
              <label>Starts</label>
              <input
                type="datetime-local"
                value={draft.starts_at}
                onChange={(e) => setDraft({ ...draft, starts_at: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Ends (optional)</label>
              <input
                type="datetime-local"
                value={draft.ends_at}
                onChange={(e) => setDraft({ ...draft, ends_at: e.target.value })}
              />
            </div>
          </div>
          <p className="small muted" style={{ marginTop: '-0.6rem' }}>
            An event without an end time is treated as upcoming until its start time, then moves to
            Past Events.
          </p>
          <div className="row">
            <div className="field">
              <label>Link URL (optional)</label>
              <input
                placeholder="https://zoom.us/…"
                value={draft.link_url}
                onChange={(e) => setDraft({ ...draft, link_url: e.target.value })}
              />
            </div>
            <div className="field">
              <label>Button text</label>
              <input
                placeholder="Join on Zoom"
                value={draft.link_label}
                onChange={(e) => setDraft({ ...draft, link_label: e.target.value })}
              />
            </div>
          </div>
          <div className="field">
            <label>Highlighted note (optional)</label>
            <input
              placeholder="Use code: HILOM for 10% off"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Status</label>
            <select
              value={draft.status}
              onChange={(e) => setDraft({ ...draft, status: e.target.value as 'draft' | 'published' })}
            >
              <option value="draft">Draft — not shown on the site</option>
              <option value="published">Published</option>
            </select>
          </div>

          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save event'}
          </button>
        </div>
      )}
    </>
  );
}
