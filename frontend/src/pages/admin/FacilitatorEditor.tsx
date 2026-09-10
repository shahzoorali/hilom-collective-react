/**
 * Admin → Facilitators → Edit profile.
 *
 * Everything on a facilitator's public profile, editable by an admin, beside a
 * live preview that *is* the public profile: the pane on the right renders
 * `FacilitatorProfileView`, the same component `/facilitators/:slug` renders,
 * from the unsaved draft. So "what will this look like" is never a question
 * the editor answers approximately.
 *
 * Why an admin needs this at all: profile copy is the facilitator's to write,
 * but Hilom routinely writes it for them — someone recruited directly, a
 * launch, a facilitator who sent their bio over email and will never open a
 * dashboard. Until now that meant an admin could set a preferred name and
 * nothing else, and the profile stayed empty until its owner filled it in.
 *
 * The private half (legal name, phone, payout details, admin notes) is on the
 * same screen but under its own heading, and the preview ignores it — none of
 * it is ever public.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import FacilitatorProfileView from '../../components/FacilitatorProfileView';
import {
  adminGetFacilitator,
  adminPatchFacilitator,
  type AdminFacilitator,
  type DeliveryMode,
  type Facilitator,
  type FacilitatorService,
} from '../../lib/booking';
import { YEARS_EXPERIENCE, type YearsExperience } from '../../lib/facilitator-intake';
import { shortName } from '../../lib/names';

type Draft = ReturnType<typeof draftFrom>;

/** The editable shape: every value a string, so no input is ever uncontrolled. */
function draftFrom(f: AdminFacilitator) {
  const payout = (f.payout_details ?? {}) as Record<string, unknown>;
  return {
    display_name: f.display_name,
    short_name: f.short_name ?? '',
    slug: f.slug,
    headline: f.headline ?? '',
    bio: f.bio ?? '',
    photo_url: f.photo_url ?? '',
    credentials: f.credentials.join('\n'),
    specialties: f.specialties.join('\n'),
    languages: f.languages.join(', '),
    location: f.location ?? '',
    delivery_mode: f.delivery_mode,
    scope_note: f.scope_note ?? '',
    website_url: f.website_url ?? '',
    years_experience: (f.years_experience ?? '') as YearsExperience | '',
    // The application form writes the handle under the `social` key; any other
    // key already in social_links is carried through the save untouched.
    social_handle: String(f.social_links?.social ?? ''),
    timezone: f.timezone,
    vacation_until: f.vacation_until ? f.vacation_until.slice(0, 10) : '',
    legal_name: f.legal_name ?? '',
    phone: f.phone ?? '',
    payout_bank: String(payout.bank ?? ''),
    payout_account: String(payout.account ?? ''),
    admin_notes: f.admin_notes ?? '',
  };
}

const lines = (value: string) =>
  value.split('\n').map((s) => s.trim()).filter(Boolean);

export default function FacilitatorEditor({ adminKey }: { adminKey: string }) {
  const { facilitatorId = '' } = useParams();
  const navigate = useNavigate();

  const [saved, setSaved] = useState<AdminFacilitator | null>(null);
  const [services, setServices] = useState<FacilitatorService[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    adminGetFacilitator(adminKey, facilitatorId)
      .then((d) => {
        if (!live) return;
        setSaved(d.facilitator);
        setServices(d.services);
        setDraft(draftFrom(d.facilitator));
      })
      .catch((err: Error) => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [adminKey, facilitatorId]);

  const set = useCallback(
    <K extends keyof Draft>(key: K, value: Draft[K]) =>
      setDraft((d) => (d ? { ...d, [key]: value } : d)),
    [],
  );

  /**
   * The draft as a public profile row.
   *
   * Assembled here rather than inside the preview so the preview keeps taking
   * exactly what the public page hands it — the moment it accepts a "draft"
   * shape of its own, the two renders can diverge.
   */
  const previewFacilitator = useMemo<Facilitator | null>(() => {
    if (!draft || !saved) return null;
    return {
      id: saved.id,
      slug: draft.slug,
      display_name: draft.display_name,
      short_name: draft.short_name.trim() || null,
      headline: draft.headline.trim() || null,
      bio: draft.bio.trim() || null,
      photo_url: draft.photo_url.trim() || null,
      credentials: lines(draft.credentials),
      specialties: lines(draft.specialties),
      languages: draft.languages.split(',').map((s) => s.trim()).filter(Boolean),
      location: draft.location.trim() || null,
      delivery_mode: draft.delivery_mode,
      scope_note: draft.scope_note.trim() || null,
      social_links: { ...saved.social_links, social: draft.social_handle },
      website_url: draft.website_url.trim() || null,
      years_experience: draft.years_experience || null,
      timezone: draft.timezone,
      status: saved.status,
    };
  }, [draft, saved]);

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const updated = await adminPatchFacilitator(adminKey, facilitatorId, {
        display_name: draft.display_name,
        short_name: draft.short_name.trim() || null,
        slug: draft.slug,
        headline: draft.headline,
        bio: draft.bio,
        photo_url: draft.photo_url,
        credentials: lines(draft.credentials),
        specialties: lines(draft.specialties),
        languages: draft.languages.split(',').map((s) => s.trim()).filter(Boolean),
        location: draft.location,
        delivery_mode: draft.delivery_mode,
        scope_note: draft.scope_note,
        // Merged rather than replaced: saving from here must not drop a key the
        // application form or the facilitator's own dashboard put in here.
        social_links: { ...saved?.social_links, social: draft.social_handle },
        website_url: draft.website_url,
        years_experience: draft.years_experience || null,
        timezone: draft.timezone,
        // Date-only input, read as end of day so "away until the 20th" includes
        // the 20th rather than reopening at midnight on it.
        vacation_until: draft.vacation_until ? `${draft.vacation_until}T23:59:59` : null,
        legal_name: draft.legal_name,
        phone: draft.phone,
        payout_details: { bank: draft.payout_bank, account: draft.payout_account },
        admin_notes: draft.admin_notes,
      });
      setSaved(updated);
      setDraft(draftFrom(updated));
      setNotice('Profile saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  if (error && !draft) {
    return (
      <>
        <div className="alert alert-error">{error}</div>
        <Link to="/admin/facilitators" className="linklike">← Back to facilitators</Link>
      </>
    );
  }

  if (!draft || !saved || !previewFacilitator) return <div className="spinner" aria-label="Loading" />;

  const firstNameGuess = shortName(draft.display_name);

  return (
    <>
      <div className="admin-toolbar">
        <button
          type="button"
          className="btn btn-ghost small"
          onClick={() => navigate('/admin/facilitators')}
        >
          ← Facilitators
        </button>
        <h2 style={{ margin: 0, fontSize: '1.15rem' }}>{saved.display_name}</h2>
        <span className="pill">{saved.status}</span>
        <button
          type="button"
          className="btn btn-accent small"
          style={{ marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      <p className="small muted">
        You are editing someone else's profile. They can change any of this themselves from their
        own dashboard, and the last save wins — so tell them what you changed.
      </p>

      <div className="admin-split">
        <div className="admin-split__form">
          <label className="field">
            <span>Name shown to clients</span>
            <input value={draft.display_name} onChange={(e) => set('display_name', e.target.value)} />
          </label>

          <label className="field">
            <span>Preferred name</span>
            <input
              value={draft.short_name}
              onChange={(e) => set('short_name', e.target.value)}
              placeholder={firstNameGuess}
            />
            <small className="muted">
              How they're addressed mid-sentence — "About {draft.short_name.trim() || firstNameGuess}".
              Blank takes it from the name above.
            </small>
          </label>

          <label className="field">
            <span>Profile URL</span>
            <input
              value={draft.slug}
              onChange={(e) => set('slug', e.target.value)}
              className="mono"
            />
            <small className="muted">
              /facilitators/{draft.slug || '…'} — changing this breaks every existing link to the
              profile, including any the facilitator has shared. Admin-only for that reason.
            </small>
          </label>

          <label className="field">
            <span>Headline</span>
            <input
              value={draft.headline}
              onChange={(e) => set('headline', e.target.value)}
              placeholder="Somatic coach for people in career transitions"
            />
          </label>

          <label className="field">
            <span>Photo URL</span>
            <input value={draft.photo_url} onChange={(e) => set('photo_url', e.target.value)} />
            <small className="muted">
              Upload in Media, then paste the URL. Blank shows their initial instead.
            </small>
          </label>

          <label className="field">
            <span>My approach</span>
            <textarea rows={10} value={draft.bio} onChange={(e) => set('bio', e.target.value)} />
            <small className="muted">
              Basic formatting is kept; anything else is stripped when saved.
            </small>
          </label>

          <label className="field">
            <span>What they help with — one per line</span>
            <textarea
              rows={5}
              value={draft.specialties}
              onChange={(e) => set('specialties', e.target.value)}
            />
          </label>

          <label className="field">
            <span>Credentials — one per line</span>
            <textarea
              rows={4}
              value={draft.credentials}
              onChange={(e) => set('credentials', e.target.value)}
            />
          </label>

          <label className="field">
            <span>Scope of practice</span>
            <textarea
              rows={4}
              value={draft.scope_note}
              onChange={(e) => set('scope_note', e.target.value)}
              placeholder="I'm a wellness coach, not a licensed therapist…"
            />
            <small className="muted">
              What they do and don't offer. Shown prominently, and it is what lets a client tell
              what kind of practitioner they are booking.
            </small>
          </label>

          <div className="two-col">
            <label className="field">
              <span>Location</span>
              <input value={draft.location} onChange={(e) => set('location', e.target.value)} />
            </label>
            <label className="field">
              <span>Languages (comma separated)</span>
              <input value={draft.languages} onChange={(e) => set('languages', e.target.value)} />
            </label>
          </div>

          <div className="two-col">
            <label className="field">
              <span>Website</span>
              <input
                value={draft.website_url}
                onChange={(e) => set('website_url', e.target.value)}
                placeholder="theirsite.com"
              />
            </label>
            <label className="field">
              <span>Social handle or link</span>
              <input
                value={draft.social_handle}
                onChange={(e) => set('social_handle', e.target.value)}
                placeholder="@handle or instagram.com/handle"
              />
            </label>
          </div>

          <div className="two-col">
            <label className="field">
              <span>Sessions are</span>
              <select
                value={draft.delivery_mode}
                onChange={(e) => set('delivery_mode', e.target.value as DeliveryMode)}
              >
                <option value="online">Online</option>
                <option value="in_person">In person</option>
                <option value="both">Either</option>
              </select>
            </label>
            <label className="field">
              <span>How long they've been doing this work</span>
              <select
                value={draft.years_experience}
                onChange={(e) => set('years_experience', e.target.value as YearsExperience | '')}
              >
                <option value="">Prefer not to say</option>
                {YEARS_EXPERIENCE.map((y) => (
                  <option key={y.value} value={y.value}>{y.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="two-col">
            <label className="field">
              <span>Timezone</span>
              <input value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} />
              <small className="muted">Their availability is stored against this.</small>
            </label>
            <label className="field">
              <span>Away until (optional)</span>
              <input
                type="date"
                value={draft.vacation_until}
                onChange={(e) => set('vacation_until', e.target.value)}
              />
              <small className="muted">
                Pauses new bookings without touching their weekly hours. Sessions already booked in
                that window stay put.
              </small>
            </label>
          </div>

          <h3>Private — never shown publicly</h3>
          <div className="two-col">
            <label className="field">
              <span>Legal name</span>
              <input value={draft.legal_name} onChange={(e) => set('legal_name', e.target.value)} />
            </label>
            <label className="field">
              <span>Phone</span>
              <input value={draft.phone} onChange={(e) => set('phone', e.target.value)} />
            </label>
          </div>

          <div className="two-col">
            <label className="field">
              <span>Bank</span>
              <input value={draft.payout_bank} onChange={(e) => set('payout_bank', e.target.value)} />
            </label>
            <label className="field">
              <span>Account</span>
              <input
                value={draft.payout_account}
                onChange={(e) => set('payout_account', e.target.value)}
              />
            </label>
          </div>

          <label className="field">
            <span>Admin notes</span>
            <textarea
              rows={3}
              value={draft.admin_notes}
              onChange={(e) => set('admin_notes', e.target.value)}
            />
          </label>

          <p className="small muted">
            Status, platform fee and email are set from the{' '}
            <Link to="/admin/facilitators" className="linklike">facilitator list</Link> — they are
            decisions about the relationship rather than profile copy.
          </p>
        </div>

        {/* The live profile. Same component `/facilitators/:slug` renders, so
            this is the page itself rather than a rendering of it. */}
        <div className="admin-split__preview">
          <p className="small muted admin-split__preview-label">
            Live preview · <span className="mono">/facilitators/{draft.slug}</span>
            {saved.status !== 'published' && ' · not published yet, so nobody can see this'}
          </p>
          <div className="admin-preview-frame">
            <FacilitatorProfileView
              facilitator={previewFacilitator}
              services={services.filter((s) => s.is_active)}
              rating={{ average: null, count: 0 }}
              reviews={[]}
              preview
            />
          </div>
        </div>
      </div>
    </>
  );
}
