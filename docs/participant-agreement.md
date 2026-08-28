# Participant agreement — Return to Self retreat

The retreat sells a legally-operative participant agreement, not just an
info sheet: it carries a liability release (§V), refund tiers (§III), a
health disclosure duty (§IV) and an 18+ attestation. It reaches the buyer
in **two** places, and both must stay in sync when the wording changes.

| | Where | Source of truth |
|---|---|---|
| On-page, before payment | `events.liability_consent_html` for the event | this file (canonical HTML below) |
| Attached to the confirmation email | `backend/src/assets/return-to-self-participant-agreement.pdf` | the PDF file in the repo |

Event: **Return to Self** — `780002bf-573e-47c0-a77c-c5f32f9f20dd`.

## On-page gate

`EventRegister.tsx` renders a required checkbox — *"I have read and agree to
the Participant Agreement"* — whose link opens the `liability_consent_html`
text in a modal. The pay button stays disabled until it is ticked. Ticking
it and completing payment is the electronic acceptance (§IX allows electronic
signature in counterparts); there is no separate wet-signature step.

To change the text: edit the **Liability & participation consent** field in
the Event Ticketing editor, or `PATCH` `events.liability_consent_html`
directly. It is run through `sanitizeRichText` on save — allowed tags are
`p h2 h3 h4 strong em u ul ol li a br blockquote`, everything else is
stripped, 20 000-char cap. Keep the canonical copy below updated too.

## Refund tiers on cancellation (§III)

`assessRefund` in `backend/src/lib/event-ticketing.ts` is the one place §III's
arithmetic lives. Keyed on whole days from `now` to the event start:

| Days before | Outcome |
|---|---|
| > 60 | Cash refund of payments received, **less the deposit** and any admin-supplied non-recoverable third-party cost. |
| 31–60 | **50% of payments as a credit** toward another Hilom retreat within 12 months. No cash; deposit and balance forfeited. |
| ≤ 30 (or already started) | Non-refundable. "Except where required by law" stays a manual admin override. |

`GET /admin/registrations/{id}/refund-assessment[?nonRecoverableCentavos=]`
returns the position for the admin screen; the admin **Cancel** / **Approve**
prompts pre-fill the cash figure with it. `cancel()` recomputes it server-side
— when no `refundCentavos` is sent it uses the tier's figure; an override wins
but is written to the audit trail and the registration's `admin_notes`.

The **credit** has no redemption mechanism yet: it is recorded in `admin_notes`
and the audit `after` block (`refund_tier`, `refund_credit_centavos`), and the
cancellation email tells the registrant a credit is owed — but arranging it is
still a person's job.

## Email attachment

`sendRegistrationConfirmed` attaches the PDF for any event id in
`PARTICIPANT_AGREEMENT_EVENT_IDS` (default:
`DEFAULT_PARTICIPANT_AGREEMENT_EVENT_IDS` in `infra/lib/hilom-shared.ts`).
The bytes ride in the Lambda bundle via an esbuild `binary` loader; the
email is composed as raw MIME because SESv2 `Content.Simple` cannot carry
attachments (see `backend/src/lib/mime.ts`).

It is attached on the seat-confirming email only — never on instalment
receipts — and on all three paths that reach `applyChargePayment`: the
PayMongo webhook and SQS retry consumer (`HilomBackendStack`) and the admin
offline "mark paid" (`HilomMarketplaceStack`).

The PDF is pre-countersigned by the CEO. When you replace it, re-check that
the countersignature and date are still present and that the wording matches
the HTML below.

## Canonical `liability_consent_html`

```html
<h3>VPH Coaching Return to Self Retreat Agreement</h3>
<p><em>Presented by Hilom Collective.</em> This Agreement is between Hilom Collective ("Hilom") and the participant registering below ("Participant"). It covers the Participant's attendance at the Return to Self Retreat stated in the booking confirmation.</p>
<p>Hilom will organize and facilitate the Return to Self Retreat, including the accommodation, meals, sessions, activities, and transfers specifically listed in the Participant's booking confirmation. The Participant agrees to pay the retreat fee according to the invoice or approved payment schedule. This Agreement remains in effect until the retreat is completed or the booking is cancelled under the terms below.</p>

<h3>I. Retreat Details</h3>
<p>The retreat dates, venue, inclusions, fees, and payment deadlines are stated in the Participant's booking confirmation and invoice. Unless specifically included, the Participant is responsible for airfare, transportation to the meeting point, passports or visas, insurance, medical expenses, and personal purchases. Hilom may make reasonable changes to the schedule, facilitator, meals, transfers, or comparable accommodation when needed for safety, weather, availability, or circumstances outside Hilom's control.</p>

<h3>II. Accommodation</h3>
<p>Accommodation is in a shared villa. Every participant will have their own bed and will share a room only with participants of the same gender. Private rooms are limited, first come and first served, subject to an additional fee, and confirmed only when Hilom provides written confirmation. Roommate, sleep, health, and accessibility requests will be considered but cannot be guaranteed. The Participant agrees to respect roommates, quiet hours, shared spaces, venue rules, and property, and is responsible for damage they intentionally or negligently cause.</p>

<h3>III. Payment and Cancellation</h3>
<p>A slot is confirmed only after Hilom accepts the registration, receives the required downpayment or full payment, and sends written confirmation. All remaining balances must be paid by the dates stated in the invoice or approved payment plan. An unpaid balance may result in the Participant's slot being released after written notice. Cancellation requests must be sent in writing to the Hilom email address used for the booking.</p>
<ul>
<li><strong>More than 60 days before the retreat:</strong> payments will be refunded less the downpayment and any non-recoverable cost already paid for the Participant's booking.</li>
<li><strong>31 to 60 days before the retreat:</strong> 50% of payments may be credited once toward another Hilom retreat held within twelve (12) months. The downpayment and remaining balance are forfeited.</li>
<li><strong>30 days or fewer before the retreat, including non-attendance or early departure:</strong> payments are non-refundable, except where required by law.</li>
</ul>
<p>More than 30 days before the retreat, the Participant may request one transfer to another eligible person, subject to Hilom's written approval and completion of all registration requirements.</p>

<h3>IV. Health and Participation</h3>
<p>The retreat is an educational and wellness experience. It is not medical care, psychotherapy, diagnosis, or crisis treatment. Activities may include movement, breathwork, mindfulness, embodiment exercises, sound practices, outdoor activities, and group sharing. Participation is voluntary, and the Participant may rest, modify, or opt out at any time.</p>
<p>The Participant agrees to disclose relevant allergies, dietary needs, injuries, pregnancy, medications, health considerations, or physical limitations and to inform Hilom if anything changes. The Participant is responsible for obtaining medical advice or clearance when needed. Hilom may ask the Participant to modify or skip an activity when reasonably necessary for safety. In an emergency, Hilom may contact the Participant's emergency contact and seek appropriate assistance. Third-party medical and transportation costs remain the Participant's responsibility unless caused by Hilom's breach of a legal duty.</p>

<h3>V. Assumption of Risk and Release</h3>
<p>The Participant understands that travel, shared accommodation, food, movement, breathwork, outdoor activities, and emotional reflection carry ordinary inherent risks, including discomfort, illness, injury, or loss of personal property. The Participant voluntarily accepts these inherent risks and agrees to follow safety instructions and stay within their own capacity.</p>
<p>To the fullest extent allowed by law, the Participant releases Hilom, its facilitators, staff, contractors, venue partners, and agents from claims arising solely from these accepted risks or the Participant's own actions. This release does not cover fraud, willful misconduct, gross negligence, breach of a non-waivable duty, or any right that cannot legally be waived.</p>

<h3>VI. Participant Conduct and Confidentiality</h3>
<p>The Participant agrees to act respectfully, honor personal boundaries, obtain consent before touch or recording, follow safety and venue rules, and avoid harassment, discrimination, unlawful conduct, or disruptive behavior. Hilom may remove a Participant whose behavior reasonably threatens safety, privacy, dignity, property, or the retreat. A Participant removed for serious or repeated misconduct will not receive a refund for unused services, except where required by law.</p>
<p>Personal stories, identities, images, and sensitive information shared by other participants must remain confidential and must not be recorded, published, or shared without permission. Hilom will encourage confidentiality but cannot guarantee that every participant will comply. Confidentiality does not prevent reporting a safety concern, seeking professional support, or complying with the law.</p>

<h3>VII. Photography and Privacy</h3>
<p>On the signed Participant Agreement you will be asked to choose one of the following. If you have a preference before then, let the team know by replying to your confirmation email.</p>
<ul>
<li>I consent to Hilom using recognizable photos or videos of me for its website, social media, educational materials, and promotions.</li>
<li>I consent to internal archival use only.</li>
<li>I do not consent to recognizable photos or videos of me.</li>
</ul>
<p>Hilom will announce organized filming and will not intentionally record sensitive personal sharing for public use without separate consent. Hilom will use registration, health, dietary, accessibility, payment, and emergency information only for retreat administration, safety, support, legal compliance, and the purposes stated in its Privacy Notice.</p>

<h3>VIII. Cancellation or Interruption by Hilom</h3>
<p>If Hilom cancels the retreat for a reason within its reasonable control, the Participant may choose a transfer of all retreat payments to a rescheduled or comparable retreat, or a refund of retreat payments received.</p>
<p>If severe weather, government restrictions, venue closure, transport disruption, public-health events, natural disaster, or another event beyond Hilom's control prevents safe or lawful delivery, Hilom may modify, relocate, postpone, or cancel the retreat. In such a case, Hilom will offer a rescheduled retreat, credit, or refund less documented, non-recoverable third-party costs, to the extent permitted by law. Hilom is not responsible for independently booked airfare or other external expenses. Travel insurance is strongly recommended.</p>

<h3>IX. General Terms</h3>
<p>Philippine law governs this Agreement. Both parties agree to first attempt to resolve any concern in good faith through the Hilom email address used for the booking. This Agreement, the booking confirmation, invoice, registration form, and Privacy Notice form the complete agreement for the retreat. Changes must be agreed in writing, except for reasonable operational changes described above. If one provision is invalid or unenforceable, the remaining provisions remain effective. This Agreement may be signed electronically and in counterparts.</p>

<h3>Acknowledgement</h3>
<p>By ticking the box and completing payment, the Participant confirms that they are at least eighteen (18) years old, have read and understood this Agreement, have provided accurate information, and voluntarily agree to participate under these terms. A copy of the full Participant Agreement is attached to the confirmation email for your records.</p>
```
