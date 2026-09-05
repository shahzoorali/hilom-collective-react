import { Link } from 'react-router-dom';
import CommunityForm from '../cms/CommunityForm';

/**
 * Mirrors hilomcollective.com/community/ — same fields and interest options
 * as the live Divi contact form, verified against the rendered page.
 *
 * The form itself lives in cms/CommunityForm.tsx so that this page and the CMS
 * `communityForm` block render exactly the same thing. It submits to
 * /community/submit, which relays the signup to kumusta@hilomcollective.com via
 * SES — there is no mailing-list/CRM service behind this yet, just a direct
 * email to the team.
 */
export default function Community() {
  return (
    <>
      <section className="cv-hero">
        <div className="container">
          <div className="cv-hero__inner">
            <h1>Join our community</h1>
            <p className="cv-hero__sub">
              Be the first to hear about upcoming courses, workshops, wellness gatherings, and new
              offerings from Hilom Collective.
            </p>
          </div>
        </div>
      </section>

      <section className="cv-band cv-band--white">
        <div className="container" style={{ maxWidth: 640 }}>
          <CommunityForm />
        </div>
      </section>

      <section className="cv-band cv-band--cream">
        <div className="container cv-center">
          <div className="cv-head cv-head--center">
            <p className="cv-eyebrow">Join the movement</p>
            <h2>There's a place for you here.</h2>
            <p>
              Whether you're seeking support, want to bring Hilom to your community, or believe in
              this work, we'd love to hear from you.
            </p>
          </div>
          <p style={{ marginTop: '2rem' }}>
            <Link className="btn btn-accent" to="/courses">
              Browse courses
            </Link>
          </p>
        </div>
      </section>
    </>
  );
}
