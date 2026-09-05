/**
 * Privacy Policy — the fallback behind the CMS page of the same slug.
 *
 * Same arrangement as the other marketing pages (see CmsOrFallback): staff edit
 * the policy in the admin, and this JSX is what visitors get until that page is
 * published, or if the CMS API is down. scripts/seed-cms.ts writes the same copy
 * into the draft, so the two must be kept in sync while both exist.
 */

const EFFECTIVE_DATE = 'May 19, 2026';
const LAST_UPDATED = 'May 19, 2026';

/** Narrow measure: legal text at the site's full container width is unreadable. */
const prose: React.CSSProperties = { width: 'min(70ch, 100%)' };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginTop: '2.5rem' }}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function PrivacyPolicy() {
  return (
    <>
      {/* The hero band mirrors the CMS version's first block, which is a `hero`
          rather than an <h1> inside rich text: sanitizeRichText only allows
          h2–h4, so the page title has to come from a real heading element. */}
      <section className="hero">
        <div className="container">
          <h1>Privacy Policy</h1>
          <p className="lede">Hilom Collective Website &amp; Learning Management System (LMS)</p>
        </div>
      </section>

      <section className="cv-band cv-band--white">
        <div className="container">
          <div style={prose}>
            <p className="muted">
            <strong>Effective Date:</strong> {EFFECTIVE_DATE}
            <br />
            <strong>Last Updated:</strong> {LAST_UPDATED}
          </p>

          <p>
            Welcome to <a href="https://hilomcollective.com">Hilom Collective</a> (“Hilom
            Collective,” “we,” “our,” or “us”).
          </p>
          <p>
            Hilom Collective is committed to protecting your privacy and ensuring transparency in
            how we collect, use, store, and safeguard your personal information across our website,
            Learning Management System (LMS), community platforms, wellness programs, events, and
            digital services.
          </p>
          <p>
            By accessing or using our website, LMS, or related services, you agree to the terms
            outlined in this Privacy Policy.
          </p>

          <Section title="1. Information We Collect">
            <p>We may collect the following types of information:</p>

            <h3>A. Personal Information</h3>
            <p>Information you voluntarily provide, including:</p>
            <ul>
              <li>Full name</li>
              <li>Email address</li>
              <li>Mobile number</li>
              <li>Date of birth</li>
              <li>Gender or pronouns (optional)</li>
              <li>Billing or payment details</li>
              <li>Wellness interests and preferences</li>
              <li>LMS account credentials</li>
              <li>Uploaded assignments, reflections, or learning outputs</li>
              <li>Event registration details</li>
              <li>Community participation information</li>
            </ul>

            <h3>B. Automatically Collected Information</h3>
            <p>When you use our website or LMS, we may automatically collect:</p>
            <ul>
              <li>IP address</li>
              <li>Browser type</li>
              <li>Device information</li>
              <li>Operating system</li>
              <li>Website usage behavior</li>
              <li>Login timestamps</li>
              <li>Pages visited</li>
              <li>Cookies and analytics data</li>
            </ul>

            <h3>C. Sensitive Wellness Information</h3>
            <p>
              Some courses, coaching services, or wellness assessments may involve personal
              reflections or wellness-related information.
            </p>
            <p>
              Hilom Collective does <strong>not</strong> provide medical diagnosis, psychiatric
              treatment, or emergency healthcare services. Any wellness information voluntarily
              shared by users will be treated with reasonable confidentiality and used solely for
              educational, coaching, or community-support purposes.
            </p>
            <p>
              We encourage users not to share highly sensitive medical or personal information
              unless necessary.
            </p>
          </Section>

          <Section title="2. How We Use Your Information">
            <p>We may use your information to:</p>
            <ul>
              <li>Create and manage your LMS account</li>
              <li>Deliver courses, programs, and wellness content</li>
              <li>Personalize your learning experience</li>
              <li>Process payments and registrations</li>
              <li>Communicate updates, reminders, and announcements</li>
              <li>Improve website functionality and user experience</li>
              <li>Analyze engagement and learning outcomes</li>
              <li>Provide customer support</li>
              <li>Ensure platform security and fraud prevention</li>
              <li>Comply with legal obligations</li>
            </ul>
          </Section>

          <Section title="3. Cookies &amp; Analytics">
            <p>
              Our website and LMS may use cookies, analytics tools, and similar technologies to
              improve user experience and understand platform performance.
            </p>
            <p>These tools may help us:</p>
            <ul>
              <li>Remember user preferences</li>
              <li>Track website traffic</li>
              <li>Measure course engagement</li>
              <li>Improve accessibility and usability</li>
            </ul>
            <p>
              Users may disable cookies through their browser settings; however, some features may
              not function properly.
            </p>
          </Section>

          <Section title="4. Sharing of Information">
            <p>Hilom Collective does not sell personal data.</p>
            <p>We may share information only with:</p>
            <ul>
              <li>Trusted service providers and technology partners</li>
              <li>Payment processors</li>
              <li>LMS hosting providers</li>
              <li>Email and communication platforms</li>
              <li>Legal authorities when required by law</li>
              <li>Business partners involved in program delivery (with appropriate safeguards)</li>
            </ul>
            <p>
              All third-party providers are expected to maintain reasonable security and
              confidentiality standards.
            </p>
          </Section>

          <Section title="5. Data Retention">
            <p>We retain personal information only for as long as necessary to:</p>
            <ul>
              <li>Provide our services</li>
              <li>Maintain educational records</li>
              <li>Comply with legal obligations</li>
              <li>Resolve disputes</li>
              <li>Enforce agreements</li>
            </ul>
            <p>
              Users may request deletion of their account and personal information, subject to
              applicable legal and operational requirements.
            </p>
          </Section>

          <Section title="6. Data Security">
            <p>
              Hilom Collective implements reasonable administrative, technical, and organizational
              measures to protect user information from unauthorized access, disclosure, misuse, or
              loss.
            </p>
            <p>
              However, no online platform or transmission method can guarantee absolute security.
            </p>
            <p>
              Users are responsible for maintaining the confidentiality of their account
              credentials.
            </p>
          </Section>

          <Section title="7. User Rights">
            <p>Depending on applicable laws, users may have the right to:</p>
            <ul>
              <li>Access their personal information</li>
              <li>Request correction of inaccurate information</li>
              <li>Request deletion of personal data</li>
              <li>Withdraw consent</li>
              <li>Object to certain forms of processing</li>
              <li>Request a copy of stored data</li>
            </ul>
            <p>Requests may be submitted through our official contact channels.</p>
          </Section>

          <Section title="8. Children’s Privacy">
            <p>
              Hilom Collective does not knowingly collect personal information from children under
              the age required by applicable law without parental or guardian consent.
            </p>
            <p>
              If we become aware that information from a minor has been collected improperly, we
              will take reasonable steps to delete it.
            </p>
          </Section>

          <Section title="9. Third-Party Links &amp; Platforms">
            <p>
              Our website or LMS may contain links to third-party websites, applications, or
              wellness resources.
            </p>
            <p>
              Hilom Collective is not responsible for the privacy practices, policies, or content of
              third-party services.
            </p>
            <p>
              Users are encouraged to review the privacy policies of external platforms they access.
            </p>
          </Section>

          <Section title="10. Community Guidelines &amp; User Content">
            <p>
              Users participating in forums, discussions, group coaching, or community spaces within
              the LMS should understand that:
            </p>
            <ul>
              <li>Shared content may be visible to other participants</li>
              <li>Respectful and ethical communication is expected</li>
              <li>Users remain responsible for the content they voluntarily post or share</li>
            </ul>
            <p>
              Hilom Collective reserves the right to moderate or remove harmful, abusive,
              discriminatory, or inappropriate content.
            </p>
          </Section>

          <Section title="11. Compliance with Philippine Data Privacy Laws">
            <p>
              Hilom Collective aims to comply with applicable provisions of the National Privacy
              Commission and the Data Privacy Act of 2012.
            </p>
            <p>
              Users located outside the Philippines acknowledge that their information may be
              processed and stored in jurisdictions where our technology providers operate.
            </p>
          </Section>

          <Section title="12. Changes to This Privacy Policy">
            <p>
              Hilom Collective may update this Privacy Policy periodically to reflect operational,
              legal, or technological changes.
            </p>
            <p>
              Updated versions will be posted on our website with a revised “Last Updated” date.
            </p>
            <p>
              Continued use of our services after updates constitutes acceptance of the revised
              policy.
            </p>
          </Section>

          <Section title="13. Contact Information">
            <p>
              For questions, requests, or concerns regarding this Privacy Policy or your personal
              data, you may contact:
            </p>
            <p>
              <strong>Hilom Collective</strong>
              <br />
              Email: <a href="mailto:kumusta@hilomcollective.com">kumusta@hilomcollective.com</a>
              <br />
              Website:{' '}
              <a href="https://hilomcollective.com">Hilom Collective Official Website</a>
            </p>
          </Section>

          <Section title="14. Disclaimer">
            <p>
              Hilom Collective provides wellness education, community learning, coaching support,
              and holistic development resources.
            </p>
            <p>
              Our content and programs are not intended to replace professional medical,
              psychiatric, legal, or financial advice. Users are encouraged to consult qualified
              professionals when appropriate.
            </p>
          </Section>
        </div>
      </div>
    </section>
    </>
  );
}
