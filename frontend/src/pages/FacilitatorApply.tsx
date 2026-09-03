/**
 * `/facilitators/apply` — become a facilitator.
 *
 * This is the fallback JSX page, served when the CMS page at slug
 * `facilitators-apply` isn't published — see CmsOrFallback in App.tsx and
 * Community.tsx for the identical pattern. The form itself lives in
 * cms/FacilitatorApplyForm.tsx so this page and the CMS `facilitatorApplyForm`
 * block render exactly the same thing; only the surrounding copy here is
 * editable from Admin → Pages once that CMS page is published.
 */
import FacilitatorApplyForm from '../cms/FacilitatorApplyForm';

export default function FacilitatorApply() {
  return (
    <>
      <section className="hero">
        <div className="container">
          <h1>Facilitate with Hilom</h1>
          <p className="lede">
            Share your holistic health and wellness expertise through Hilom Collective. Set your
            own hours and rates—we’ll handle the bookings and payments.
          </p>
        </div>
      </section>

      <section className="section" style={{ paddingTop: 0 }}>
        <div className="container" style={{ maxWidth: 640 }}>
          <FacilitatorApplyForm />
        </div>
      </section>
    </>
  );
}
