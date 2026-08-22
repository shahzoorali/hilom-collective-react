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
          <h1>Facilitate on Hilom</h1>
          <p className="lede">
            Offer your coaching, breathwork, or wellness practice through the same site our
            clients already trust — you set your own hours and prices, and we handle booking and
            payment.
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
