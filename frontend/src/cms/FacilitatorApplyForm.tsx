/**
 * The facilitator application form, extracted from FacilitatorApply.tsx so
 * both the hardcoded fallback page and the CMS `facilitatorApplyForm` block
 * render exactly the same thing — same split as CommunityForm.tsx.
 *
 * Its fields are fixed in code, same reasoning as CommunityForm: it posts to
 * /facilitators/apply, which writes a specific row shape. Making the fields
 * editable would mean rebuilding a working application pipeline on top of the
 * generic /forms engine for no gain.
 *
 * Signing in first, before the form, for the same reason Checkout and
 * BookingFlow do it: an unannounced bounce to auth.hilomcollective.com after
 * someone has already started filling in their story reads as a surprise
 * mid-task, and the application is keyed to the account's email either way.
 *
 * ## What this form is, and is not
 *
 * It is a *triage* form. It asks what someone wants to build and how involved
 * they want Hilom to be — the answers that decide which service track they
 * belong in and whether Hilom wants to work with them at all.
 *
 * It is not a profile draft. Credentials, specialties, scope of practice,
 * languages and delivery mode used to be collected here and no longer are:
 * they are public marketplace copy, they are collected in the dashboard
 * Profile tab, and an applicant writing them before anyone has read their
 * application was work thrown away every time the answer was no. The two-step
 * `approved` → `published` lifecycle already exists to hold exactly that gap.
 */
import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { currentUser, login } from '../lib/auth';
import { applyAsFacilitator, uploadFacilitatorFile } from '../lib/booking';
import {
  CONTACT_METHODS,
  CONTACT_METHODS_NEEDING_PHONE,
  NEXT_STEPS,
  NEXT_STEPS_CLOSING,
  NEXT_STEPS_PATHWAY,
  PROGRAM_STATUSES,
  REFERRAL_SOURCES,
  SUPPORT_TRACKS,
  YEARS_EXPERIENCE,
  type ContactMethod,
  type ProgramStatus,
  type ReferralSource,
  type SupportTrack,
  type YearsExperience,
} from '../lib/facilitator-intake';

interface Upload {
  key: string;
  filename: string;
  mediaId: string | null;
  url: string | null;
}

export default function FacilitatorApplyForm() {
  const user = currentUser();

  const [draft, setDraft] = useState({
    display_name: [user?.givenName, user?.familyName].filter(Boolean).join(' '),
    contact_method: 'email' as ContactMethod,
    phone: '',
    social_handle: '',
    bio: '',
    years_experience: '' as YearsExperience | '',
    website_url: '',
    referral_source: '' as ReferralSource | '',
    referral_source_other: '',
  });
  const [supportNeeded, setSupportNeeded] = useState<SupportTrack[]>([]);
  const [programStatus, setProgramStatus] = useState<ProgramStatus[]>([]);
  const [photo, setPhoto] = useState<Upload | null>(null);
  const [certificate, setCertificate] = useState<Upload | null>(null);
  const [consented, setConsented] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<
    { alreadyApplied?: boolean; reapplied?: boolean; status: string } | null
  >(null);

  // Re-checking here rather than trusting a stale closure: coming back from
  // sign-in re-renders this component fresh, so this only ever runs once
  // against the current session.
  useEffect(() => {
    if (user && !draft.display_name) {
      setDraft((d) => ({ ...d, display_name: [user.givenName, user.familyName].filter(Boolean).join(' ') }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.email]);

  const set = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const needsPhone = CONTACT_METHODS_NEEDING_PHONE.has(draft.contact_method);
  const needsHandle = draft.contact_method === 'instagram';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await applyAsFacilitator({
        display_name: draft.display_name.trim(),
        bio: draft.bio.trim() || undefined,
        photo_media_id: photo?.mediaId ?? undefined,
        photo_url: photo?.url ?? undefined,
        contact_method: draft.contact_method,
        phone: draft.phone.trim() || undefined,
        social_handle: draft.social_handle.trim() || undefined,
        website_url: draft.website_url.trim() || undefined,
        years_experience: draft.years_experience as YearsExperience,
        support_needed: supportNeeded,
        program_status: programStatus,
        cert_document_key: certificate?.key ?? undefined,
        cert_document_name: certificate?.filename ?? undefined,
        referral_source: draft.referral_source as ReferralSource,
        referral_source_other: draft.referral_source_other.trim() || undefined,
        // The server re-checks this and refuses the application without it —
        // the checkbox below is the affordance, not the enforcement.
        privacy_accepted: true,
      }).then(setResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!user) {
    return (
      <div className="panel">
        <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>First, your Hilom account</h2>
        <p>
          Your application, and later your dashboard, live in this account — so let's set it up
          before the form.
        </p>
        <button
          className="btn btn-accent btn-block"
          type="button"
          onClick={() => void login('/facilitators/apply')}
        >
          Continue with your Hilom account
        </button>
        <p className="small muted" style={{ marginTop: '0.9rem', marginBottom: 0 }}>
          Stuck? <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a> is a real
          inbox we check.
        </p>
      </div>
    );
  }

  if (result) {
    // Someone still in the queue is in exactly the position the next-steps
    // panel speaks to, whether they landed here by applying just now or by
    // re-opening the form weeks later. Someone already approved, rejected or
    // suspended has had their outcome, and repeating "here are the three
    // things that might happen" to them would read as though nobody had
    // noticed.
    const awaitingDecision = !result.alreadyApplied || result.status === 'applied';

    return (
      <>
        <div className="panel">
          {result.alreadyApplied ? (
            <>
              <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Already on file</h2>
              <p style={{ marginBottom: 0 }}>
                There's already an application for {user.email}.{' '}
                {result.status === 'approved' || result.status === 'published' ? (
                  <>
                    It's been approved — head to your <Link to="/facilitator">dashboard</Link> to
                    finish setting up.
                  </>
                ) : result.status === 'rejected' ? (
                  "It wasn't approved. If something's changed since you applied, reach out to us directly."
                ) : result.status === 'suspended' ? (
                  'It was paused after being live. Reach out to us directly if you have questions.'
                ) : (
                  // 'applied' — the only status left, and the true default:
                  // still sitting in the review queue.
                  "We'll be in touch once it's been reviewed."
                )}
              </p>
            </>
          ) : (
            <>
              <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>
                {result.reapplied ? 'Application resubmitted' : 'Application sent'}
              </h2>
              <p style={{ marginBottom: 0 }}>
                {result.reapplied
                  ? "Thanks for coming back — we'll take another look and follow up by email."
                  : "Thank you — we'll read through what you shared and follow up by email."}{' '}
                Once approved, you'll get a dashboard where you'll add your credentials, scope of
                practice and the rest of your public profile before you go live.
              </p>
            </>
          )}
        </div>

        {awaitingDecision && <NextSteps />}
      </>
    );
  }

  return (
    <form className="panel" onSubmit={onSubmit}>
      {error && <div className="alert alert-error">{error}</div>}

      {/* ------------------------------------------------------------------ */}
      <h2 className="form-section-heading">About you</h2>

      <label className="field">
        <span>Your name</span>
        <input
          required
          value={draft.display_name}
          onChange={(e) => set('display_name', e.target.value)}
        />
        <small className="muted">This is the name clients will see.</small>
      </label>

      <FileField
        label="Photo"
        hint="A clear headshot. JPEG, PNG or WebP, up to 5 MB."
        accept="image/jpeg,image/png,image/webp,image/avif"
        kind="photo"
        value={photo}
        onChange={setPhoto}
        onError={setError}
      />

      {/* ------------------------------------------------------------------ */}
      <h2 className="form-section-heading">How can we reach you?</h2>

      <label className="field">
        <span>Preferred method of contact</span>
        <select
          required
          value={draft.contact_method}
          onChange={(e) => set('contact_method', e.target.value as ContactMethod)}
        >
          {CONTACT_METHODS.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
      </label>

      {/* Read-only rather than absent: the applicant should be able to see
          which address this is attached to, and it is not editable because the
          row is keyed to the signed-in account. A typo here would produce a
          profile whose owner can never open its dashboard. */}
      <div className="field">
        <label>Your email address</label>
        <p style={{ margin: '0.15rem 0 0', fontWeight: 600 }}>{user.email}</p>
        <small className="muted">
          The account you're signed in with. Your dashboard will live here too.
        </small>
      </div>

      <label className="field">
        <span>Phone number{needsPhone ? '' : ' (optional)'}</span>
        <input
          type="tel"
          required={needsPhone}
          value={draft.phone}
          onChange={(e) => set('phone', e.target.value)}
        />
      </label>

      <label className="field">
        <span>Your social media handle or link{needsHandle ? '' : ' (optional)'}</span>
        <input
          required={needsHandle}
          value={draft.social_handle}
          onChange={(e) => set('social_handle', e.target.value)}
          placeholder="@yourhandle or instagram.com/yourhandle"
        />
      </label>

      {/* ------------------------------------------------------------------ */}
      <h2 className="form-section-heading">About your work</h2>

      <label className="field">
        <span>Tell us about your work</span>
        <textarea
          required
          rows={8}
          value={draft.bio}
          onChange={(e) => set('bio', e.target.value)}
          placeholder="Share with us more of what you do, how long have you been doing it, and who your target clients are."
        />
      </label>

      <label className="field">
        <span>How long have you been doing this work?</span>
        <select
          required
          value={draft.years_experience}
          onChange={(e) => set('years_experience', e.target.value as YearsExperience)}
        >
          <option value="">Choose…</option>
          {YEARS_EXPERIENCE.map((y) => (
            <option key={y.value} value={y.value}>{y.label}</option>
          ))}
        </select>
      </label>

      {/* Not required. "I'm not sure yet — I want Hilom's recommendation" is an
          option in the question below, and demanding a track from someone who
          has just said they can't pick one is a dead end. Zero selections is a
          real answer here, and the server accepts it. */}
      <fieldset className="field choice-set">
        <legend>What kind of support do you need?</legend>
        <p className="small muted" style={{ marginTop: 0 }}>
          Pick any that apply, or leave blank if you'd rather we recommend one.
        </p>

        {SUPPORT_TRACKS.map((track) => {
          const checked = supportNeeded.includes(track.value);
          return (
            <label key={track.value} className={`choice-card${checked ? ' choice-card--on' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => setSupportNeeded((s) => toggle(s, track.value))}
              />
              <span className="choice-card__body">
                {/* `track.number` is deliberately not rendered here. The
                    01/02/03 ordering is deck and marketing-page furniture; on
                    a form it reads as a sequence to work through rather than
                    three independent things to tick. The field stays on the
                    constant for the marketing page, which does want it. */}
                <span className="choice-card__eyebrow">{track.name}</span>
                <strong className="choice-card__title">{track.question}</strong>
                <ul className="choice-card__list">
                  {track.includes.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
                <span className="choice-card__note">{track.bestFor}</span>
                <span className="choice-card__meta">{track.commercials}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <fieldset className="field choice-set">
        <legend>What do you have for your programs right now?</legend>
        <p className="small muted" style={{ marginTop: 0 }}>
          Pick any that apply.
        </p>

        {PROGRAM_STATUSES.map((option) => {
          const checked = programStatus.includes(option.value);
          return (
            <label key={option.value} className={`choice-row${checked ? ' choice-row--on' : ''}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => setProgramStatus((s) => toggle(s, option.value))}
              />
              <span>
                <strong>{option.label}</strong>
                <span className="small muted" style={{ display: 'block' }}>{option.detail}</span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <label className="field">
        <span>Website (optional)</span>
        <input
          value={draft.website_url}
          onChange={(e) => set('website_url', e.target.value)}
          placeholder="yoursite.com"
        />
      </label>

      <FileField
        label="Certification or affiliation document (optional)"
        hint="PDF, up to 10 MB. Only Hilom sees this — it's never shown on your profile."
        accept="application/pdf"
        kind="certificate"
        value={certificate}
        onChange={setCertificate}
        onError={setError}
      />

      {/* ------------------------------------------------------------------ */}
      <h2 className="form-section-heading">Finally</h2>

      <label className="field">
        <span>How did you hear about Hilom Collective?</span>
        <select
          required
          value={draft.referral_source}
          onChange={(e) => set('referral_source', e.target.value as ReferralSource)}
        >
          <option value="">Choose…</option>
          {REFERRAL_SOURCES.map((r) => (
            <option key={r.value} value={r.value}>{r.label}</option>
          ))}
        </select>
      </label>

      {draft.referral_source === 'other' && (
        <label className="field">
          <span>Tell us more</span>
          <input
            required
            value={draft.referral_source_other}
            onChange={(e) => set('referral_source_other', e.target.value)}
            placeholder="Who or what pointed you here?"
          />
        </label>
      )}

      <label className="field row" style={{ gap: '0.6rem', alignItems: 'flex-start' }}>
        <input
          type="checkbox"
          required
          checked={consented}
          onChange={(e) => setConsented(e.target.checked)}
        />
        <span>
          {/* Must match the route registered in App.tsx. This said "/privacy"
              and 404'd — a consent checkbox linking to a missing page asks
              someone to agree to something they cannot read, which is exactly
              the consent that is worth nothing later. */}
          I agree to the <Link to="/privacy-policy">privacy policy</Link>.
        </span>
      </label>

      <button className="btn btn-accent btn-block" type="submit" disabled={busy || !consented}>
        {busy ? 'Sending…' : 'Submit application'}
      </button>
    </form>
  );
}

/**
 * "What happens after today", from the facilitator deck.
 *
 * Worth the space on a thank-you screen because the alternative is silence.
 * An applicant who has just handed over their work, their credentials and a
 * scanned certificate has no idea whether the next email arrives in two days
 * or two months, or what it might say — and the most common thing to conclude
 * from not knowing is that the answer was no.
 *
 * Naming all three outcomes, including the one nobody wants, is what makes the
 * other two believable.
 */
function NextSteps() {
  return (
    <section className="next-steps" aria-labelledby="next-steps-heading">
      <h2 id="next-steps-heading" className="next-steps__heading">Next steps</h2>
      <p className="next-steps__lede">
        We'll take what you've shared, review the opportunity internally, and recommend the best
        next step.
      </p>

      <ol className="next-steps__list">
        {NEXT_STEPS.map((step) => (
          <li key={step.number} className="next-steps__item">
            <span className="next-steps__number" aria-hidden="true">{step.number}</span>
            <span className="next-steps__body">
              <strong className="next-steps__name">{step.name}</strong>
              <span className="next-steps__detail">{step.detail}</span>
            </span>
          </li>
        ))}
      </ol>

      {/* Split on the arrows so a narrow screen breaks between stages rather
          than inside one — left to wrap on its own it lands as
          "Proceed → Agreement → Kick-" / "Off", because a hyphen is a legal
          break point and "Kick-Off" is the only hyphenated word here. */}
      <p className="next-steps__pathway">
        {NEXT_STEPS_PATHWAY.split('→').map((stage, i) => (
          <Fragment key={stage}>
            {/* A real space either side of the arrow: that whitespace is the
                only break opportunity in the line, so without it the badge
                could never wrap and would overflow a narrow screen instead. */}
            {i > 0 && ' → '}
            <span className="next-steps__stage">{stage.trim()}</span>
          </Fragment>
        ))}
      </p>
      <p className="next-steps__closing">{NEXT_STEPS_CLOSING}</p>
    </section>
  );
}

/**
 * One upload field: pick a file, it goes straight to S3, the parent gets a
 * reference back.
 *
 * The upload happens on selection rather than at submit so that a slow or
 * failed transfer surfaces while the applicant is still looking at that part
 * of the form, instead of blocking the one action they care about and losing
 * everything else they typed if it fails.
 */
function FileField({
  label,
  hint,
  accept,
  kind,
  value,
  onChange,
  onError,
}: {
  label: string;
  hint: string;
  accept: string;
  kind: 'photo' | 'certificate';
  value: Upload | null;
  onChange: (upload: Upload | null) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    onError(null);
    try {
      onChange(await uploadFacilitatorFile(kind, file));
    } catch (err) {
      onChange(null);
      onError(err instanceof Error ? err.message : 'That file could not be uploaded.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="field">
      <label>{label}</label>
      {value ? (
        <div className="row" style={{ gap: '0.6rem', alignItems: 'center' }}>
          <span className="small">{value.filename}</span>
          <button type="button" className="btn btn-ghost small" onClick={() => onChange(null)}>
            Remove
          </button>
        </div>
      ) : (
        <input
          type="file"
          accept={accept}
          disabled={busy}
          onChange={(e) => void pick(e.target.files?.[0])}
        />
      )}
      <small className="muted">{busy ? 'Uploading…' : hint}</small>
    </div>
  );
}
