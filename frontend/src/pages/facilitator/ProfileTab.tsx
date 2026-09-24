/**
 * Facilitator → Profile.
 *
 * What the public sees, plus vacation mode and payout details.
 *
 * Four fields are conspicuously read-only: status, fee rate, profile URL and
 * email. They are shown because a facilitator should be able to see their own
 * terms without asking, and they are not editable because publishing yourself
 * or renegotiating your own commission is not a self-service operation. The
 * backend does not accept them from this screen either — the check is there,
 * not here.
 */
import { useState } from 'react';
import {
  formatInZone,
  updateMyFacilitatorProfile,
  uploadFacilitatorFile,
  type OwnProfile,
  type VacationConflict,
} from '../../lib/booking';
import { Link } from 'react-router-dom';
import { YEARS_EXPERIENCE } from '../../lib/facilitator-intake';
import { shortName } from '../../lib/names';

export default function ProfileTab({
  profile,
  onSaved,
}: {
  profile: OwnProfile;
  onSaved: (p: OwnProfile) => void;
}) {
  const [initialDraft, setInitialDraft] = useState(() => ({
    display_name: profile.display_name,
    short_name: profile.short_name ?? '',
    headline: profile.headline ?? '',
    bio: profile.bio ?? '',
    photo_url: profile.photo_url ?? '',
    credentials: profile.credentials.join('\n'),
    specialties: profile.specialties.join('\n'),
    languages: profile.languages.join(', '),
    location: profile.location ?? '',
    delivery_mode: profile.delivery_mode,
    scope_note: profile.scope_note ?? '',
    website_url: profile.website_url ?? '',
    years_experience: profile.years_experience ?? '',
    // The application form writes this under the `social` key; anything else
    // an admin has put in social_links is left untouched by the save below.
    social_handle: String(profile.social_links?.social ?? ''),
    timezone: profile.timezone,
    legal_name: profile.legal_name ?? '',
    phone: profile.phone ?? '',
    vacation_until: profile.vacation_until ? profile.vacation_until.slice(0, 10) : '',
    payout_bank: String((profile.payout_details as Record<string, unknown>)?.bank ?? ''),
    payout_account: String((profile.payout_details as Record<string, unknown>)?.account ?? ''),
  }));
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<VacationConflict[]>([]);

  // What the name-above would resolve to on its own, shown as the placeholder
  // and in the preview text so "leave blank" has something concrete to mean.
  const firstNameGuess = shortName(draft.display_name);

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const lines = (value: string) =>
    value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  // Read from the live draft rather than the saved profile, so the banner
  // clears as they type instead of only after a save — the point is to tell
  // them what is outstanding, not to grade what they last submitted.
  const missingForPublish = [
    lines(draft.credentials).length === 0 && 'Add your credentials',
    !draft.scope_note.trim() && 'Write your scope of practice',
    !draft.bio.trim() && 'Describe your approach',
  ].filter((item): item is string => typeof item === 'string');

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await updateMyFacilitatorProfile({
        display_name: draft.display_name,
        short_name: draft.short_name.trim() || null,
        headline: draft.headline,
        bio: draft.bio,
        photo_url: draft.photo_url,
        credentials: lines(draft.credentials),
        specialties: lines(draft.specialties),
        languages: draft.languages.split(',').map((s) => s.trim()).filter(Boolean),
        location: draft.location,
        delivery_mode: draft.delivery_mode,
        scope_note: draft.scope_note,
        website_url: draft.website_url,
        years_experience: draft.years_experience || null,
        // Merged rather than replaced, so saving the profile cannot drop a key
        // the application form or an admin put in social_links.
        social_links: { ...profile.social_links, social: draft.social_handle },
        timezone: draft.timezone,
        legal_name: draft.legal_name,
        phone: draft.phone,
        // Date-only input, read as end-of-day so "away until the 20th" includes
        // the 20th rather than reopening at midnight on it.
        vacation_until: draft.vacation_until ? `${draft.vacation_until}T23:59:59` : null,
        payout_details: { bank: draft.payout_bank, account: draft.payout_account },
      });
      onSaved(saved.facilitator);
      setInitialDraft(draft);
      setNotice('Profile saved');
      // Setting an away date does not move the sessions already inside it —
      // see vacationConflicts in facilitator-portal.ts for why this reports
      // rather than cancels. Told here because this is the moment they can act.
      setConflicts(saved.vacationConflicts ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(initialDraft);
  const previewSpecialties = lines(draft.specialties).slice(0, 4);
  const deliveryLabel = { online: 'Online', in_person: 'In person', both: 'Online & in person' }[draft.delivery_mode];
  const feePct = (profile.platform_fee_bps / 100).toFixed(profile.platform_fee_bps % 100 ? 2 : 0);

  return (
    <div className="fs-page">
      <header className="fs-pagehead">
        <div>
          <h1>Profile</h1>
          <p>How clients meet you on Hilom — plus the private details we need to pay you.</p>
        </div>
        {profile.status === 'published' && (
          <Link className="btn btn-ghost small" to={`/facilitators/${profile.slug}`}>
            View public profile ↗
          </Link>
        )}
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {conflicts.length > 0 && (
        <div className="alert alert-warning">
          <strong>
            You have {conflicts.length} confirmed{' '}
            {conflicts.length === 1 ? 'session' : 'sessions'} during your time off.
          </strong>{' '}
          New bookings are paused, but these were already in your diary — cancel or move each
          one from <Link to="/facilitator/bookings">your bookings</Link>.
          <ul className="small" style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem' }}>
            {conflicts.map((c) => (
              <li key={c.id}>
                {formatInZone(c.starts_at, profile.timezone, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}{' '}
                — {c.title} with {c.client_name || c.client_email}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The application form does not collect credentials or scope of
          practice — it is a triage form about what someone wants to build, not
          a profile draft. This screen is where that copy actually gets
          written, and this banner is the only thing telling an approved
          facilitator that Hilom is waiting on them for it. Without it the
          handover is silent and everyone waits for the other side. */}
      {profile.status !== 'published' && missingForPublish.length > 0 && (
        <div className="alert alert-info">
          <strong>Before Hilom can list you</strong>
          <ul style={{ margin: '0.4rem 0 0' }}>
            {missingForPublish.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      )}

      <div className="fs-profile">
        <div className="fs-profile-main">
          <Section title="Identity" hint="Your name and face, as clients see them.">
            <PhotoField
              value={draft.photo_url}
              onChange={(url) => set('photo_url', url)}
              onError={setError}
            />
            <div className="two-col">
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
              </label>
            </div>
            <small className="muted fs-field-note">
              Preferred name is how you're addressed in a sentence — "About {draft.short_name.trim() || firstNameGuess}",
              "{draft.short_name.trim() || firstNameGuess} would like to know a few things". Leave blank
              and we take it from your name.
            </small>
            <label className="field">
              <span>Headline</span>
              <input
                value={draft.headline}
                onChange={(e) => set('headline', e.target.value)}
                placeholder="Somatic coach for people in career transitions"
              />
            </label>
          </Section>

          <Section title="Your story" hint="The words that help a client decide you're the right person.">
            <label className="field">
              <span>My approach</span>
              <textarea rows={8} value={draft.bio} onChange={(e) => set('bio', e.target.value)} />
              <small className="muted">Basic formatting is kept; anything else is stripped when saved.</small>
            </label>
            <label className="field">
              <span>What I help with — one per line</span>
              <textarea
                rows={5}
                value={draft.specialties}
                onChange={(e) => set('specialties', e.target.value)}
                placeholder={'Emotional wellbeing\nCareer transitions\nStress management'}
              />
              <small className="muted">Shown on your directory card and profile. The first few appear on the card.</small>
            </label>
          </Section>

          <Section title="Credentials & scope" hint="Read together, so clients know what kind of practitioner they're booking.">
            <label className="field">
              <span>Credentials — one per line</span>
              <textarea rows={4} value={draft.credentials} onChange={(e) => set('credentials', e.target.value)} />
            </label>
            {/* Sits next to credentials on purpose: the two are read together, and
                the whole point is that a client can tell what kind of practitioner
                they are booking before they book. */}
            <label className="field">
              <span>Scope of practice</span>
              <textarea
                rows={3}
                value={draft.scope_note}
                onChange={(e) => set('scope_note', e.target.value)}
                placeholder="I'm a wellness coach, not a licensed therapist. I don't diagnose or treat mental health conditions, and I'll refer on where that's what's needed."
              />
              <small className="muted">
                Shown prominently on your profile. Be specific about what you do and don't offer — it
                protects you as much as your clients.
              </small>
            </label>
            <label className="field">
              <span>How long you've been doing this work</span>
              <select
                value={draft.years_experience}
                onChange={(e) => set('years_experience', e.target.value as typeof draft.years_experience)}
              >
                <option value="">Prefer not to say</option>
                {YEARS_EXPERIENCE.map((y) => (
                  <option key={y.value} value={y.value}>{y.label}</option>
                ))}
              </select>
              <small className="muted">Shown on your public profile.</small>
            </label>
          </Section>

          <Section title="Practice details" hint="Where, how and in which languages you work.">
            <div className="two-col">
              <label className="field">
                <span>Sessions are</span>
                <select
                  value={draft.delivery_mode}
                  onChange={(e) => set('delivery_mode', e.target.value as typeof draft.delivery_mode)}
                >
                  <option value="online">Online</option>
                  <option value="in_person">In person</option>
                  <option value="both">Either</option>
                </select>
              </label>
              <label className="field">
                <span>Your timezone</span>
                <input value={draft.timezone} onChange={(e) => set('timezone', e.target.value)} />
                <small className="muted">Your availability is stored against this.</small>
              </label>
            </div>
            <div className="two-col">
              <label className="field">
                <span>Location</span>
                <input value={draft.location} onChange={(e) => set('location', e.target.value)} placeholder="Manila" />
              </label>
              <label className="field">
                <span>Languages (comma separated)</span>
                <input value={draft.languages} onChange={(e) => set('languages', e.target.value)} />
              </label>
            </div>
            {/* Both come from the application form. They are editable here
                because otherwise they are write-once: a facilitator who changes
                their site or handle would have to ask an admin to fix it. */}
            <div className="two-col">
              <label className="field">
                <span>Website</span>
                <input
                  value={draft.website_url}
                  onChange={(e) => set('website_url', e.target.value)}
                  placeholder="yoursite.com"
                />
              </label>
              <label className="field">
                <span>Social handle or link</span>
                <input
                  value={draft.social_handle}
                  onChange={(e) => set('social_handle', e.target.value)}
                  placeholder="@yourhandle or instagram.com/yourhandle"
                />
              </label>
            </div>
          </Section>

          <Section title="Time off" hint="Pause new bookings without touching your weekly hours.">
            <label className="field">
              <span>Away until (optional)</span>
              <input
                type="date"
                value={draft.vacation_until}
                onChange={(e) => set('vacation_until', e.target.value)}
              />
              <small className="muted">
                Clear it to come back. Sessions already booked in that window stay put — we'll list
                them when you save.
              </small>
            </label>
          </Section>

          <Section title="Private & payouts" hint="🔒 Used for your payouts. Never shown publicly." locked>
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
                <input value={draft.payout_account} onChange={(e) => set('payout_account', e.target.value)} />
              </label>
            </div>
          </Section>
        </div>

        <aside className="fs-profile-aside">
          <div className="fs-card fs-preview">
            <span className="fs-eyebrow fs-preview-label">Live preview</span>
            <div className="fs-preview-cover" />
            {draft.photo_url ? (
              <img className="fs-preview-photo" src={draft.photo_url} alt="" />
            ) : (
              <span className="fs-preview-photo fs-preview-photo--empty">
                {(draft.display_name.trim()[0] ?? '•').toUpperCase()}
              </span>
            )}
            <strong className="fs-preview-name">{draft.display_name || 'Your name'}</strong>
            <span className="fs-preview-headline">{draft.headline || 'Add a headline that says who you help'}</span>
            {previewSpecialties.length > 0 && (
              <div className="fs-chips">
                {previewSpecialties.map((sp) => <span key={sp} className="fs-chip">{sp}</span>)}
              </div>
            )}
            <div className="fs-preview-meta">
              <span>💻 {deliveryLabel}</span>
              {draft.location && <span>📍 {draft.location}</span>}
              {draft.languages && <span>🗣️ {draft.languages}</span>}
            </div>
          </div>

          <div className="fs-card">
            <header className="fs-card-head">
              <h2>Your terms</h2>
            </header>
            <p className="small muted" style={{ marginTop: '-0.5rem' }}>
              Set by Hilom. Get in touch if something here looks wrong.
            </p>
            <dl className="fs-terms">
              <div><dt>Status</dt><dd><span className={`fs-pill fs-pill--${profile.status === 'published' ? 'confirmed' : 'pending_payment'}`}>{profile.status}</span></dd></div>
              <div><dt>Platform fee</dt><dd>{feePct}%</dd></div>
              <div><dt>Profile URL</dt><dd className="mono">/facilitators/{profile.slug}</dd></div>
              <div><dt>Email</dt><dd className="mono">{profile.email}</dd></div>
            </dl>
          </div>
        </aside>
      </div>

      <div className={`fs-savebar${dirty ? ' is-dirty' : ''}`}>
        <span>{dirty ? '● You have unsaved changes' : 'All changes saved'}</span>
        <button type="button" className="btn btn-accent" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  );
}

function Section({
  title,
  hint,
  locked,
  children,
}: {
  title: string;
  hint?: string;
  locked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={`fs-card fs-section${locked ? ' fs-section--locked' : ''}`}>
      <header className="fs-section-head">
        <h2>{title}</h2>
        {hint && <p>{hint}</p>}
      </header>
      {children}
    </section>
  );
}

/**
 * The profile photo: a preview, a file picker, and the URL box that used to be
 * the only thing here.
 *
 * The text input stays deliberately. `photo_url` is a plain column, not a
 * foreign key to `media_assets`, and some facilitators arrive with a headshot
 * already hosted somewhere — a personal site, a previous directory. Replacing
 * the field with a picker would have taken that away to add convenience.
 *
 * The preview is round and small because that is how the photo is actually
 * used — the directory card, the booking confirmation, the message thread. A
 * full-bleed rectangular preview would show a composition nobody ever sees and
 * hide the one problem worth catching here, which is a face cropped out of its
 * own circle.
 *
 * Validation is client-side *as well as* server-side: `facilitator-uploads.ts`
 * enforces the same 5 MB and the same type set, and is the check that counts.
 * Doing it here too turns a failed round-trip on a 12 MB phone photo into an
 * instant, specific message.
 */
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif';

function PhotoField({
  value,
  onChange,
  onError,
}: {
  value: string;
  onChange: (url: string) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    onError(null);

    if (!PHOTO_ACCEPT.split(',').includes(file.type)) {
      onError('That needs to be a JPEG, PNG, WebP or AVIF image.');
      return;
    }
    if (file.size > PHOTO_MAX_BYTES) {
      const mb = (file.size / 1024 / 1024).toFixed(1);
      onError(`That photo is ${mb} MB. The limit is 5 MB — most phones can export a smaller copy.`);
      return;
    }

    setBusy(true);
    try {
      const { url } = await uploadFacilitatorFile('photo', file);
      // The confirm step returns null only if the media row could not be
      // written, in which case the object exists but nothing can reach it.
      if (!url) throw new Error('That photo uploaded but could not be saved. Please try again.');
      onChange(url);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'That photo could not be uploaded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <span>Photo</span>
      <div className="fs-photo-row">
        {value ? (
          <img
            src={value}
            alt=""
            width={72}
            height={72}
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              objectFit: 'cover',
              border: '1px solid var(--line)',
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            aria-hidden="true"
            style={{
              width: 72,
              height: 72,
              borderRadius: '50%',
              background: 'var(--surface)',
              border: '1px dashed var(--line)',
              flexShrink: 0,
            }}
          />
        )}
        <div>
          <input
            type="file"
            accept={PHOTO_ACCEPT}
            disabled={busy}
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              // Cleared so that picking the same file again after an error
              // still fires a change event.
              e.target.value = '';
            }}
          />
          <small className="muted" style={{ display: 'block' }}>
            {busy ? 'Uploading…' : 'JPEG, PNG or WebP, up to 5 MB. Shown as a circle, so centre your face.'}
          </small>
        </div>
      </div>

      <label className="field" style={{ marginBottom: 0 }}>
        <span className="small muted">Or paste an image URL</span>
        <input value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  );
}
