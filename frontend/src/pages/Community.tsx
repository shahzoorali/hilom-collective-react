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
      <section className="hero">
        <div className="container">
          <h1>Join Our Community</h1>
          <p className="lede">
            Be the first to hear about upcoming courses, workshops, wellness gatherings, and new
            offerings from Hilom Collective.
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container" style={{ maxWidth: 640 }}>
          <CommunityForm />
        </div>
      </section>

      <section className="section" style={{ textAlign: 'center', background: 'var(--cream)' }}>
        <div className="container">
          <p className="badge">Join The Movement</p>
          <h2>There's a place for you here.</h2>
          <p className="lede" style={{ margin: '0 auto 1.5rem' }}>
            Whether you're seeking support, want to bring Hilom to your community, or believe in
            this work, we'd love to hear from you.
          </p>
          <Link className="btn btn-primary" to="/courses">
            Browse Courses
          </Link>
        </div>
      </section>
    </>
  );
}
