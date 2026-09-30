# Facilitator partnership agreement (digital signing)

Built 2026-09-30. Migration `0066_facilitator_agreement.sql`.

## How it works

- **Text is versioned data** (`facilitator_agreement_versions`). A version is a `draft`
  until an admin publishes it; publishing freezes the words (DB trigger) and retires the
  previous `current` one. Placeholders (`{{facilitator_name}}`, `{{effective_date}}`, …)
  are filled per signer.
- **A signature is a row** (`facilitator_agreement_acceptances`, append-only): version,
  SHA-256 of the text signed, typed legal name, address, contact, timestamp, IP, browser,
  Cognito sub.
- **Facilitator signs when applying** (folded into `POST /facilitators/apply`). Existing
  applicants / facilitators sign from the dashboard (`POST /facilitators/agreement`).
- **Hilom counter-signs on approval** (`PATCH /admin/facilitators/{id}` → approved).
  Someone already approved who signs later is counter-signed immediately. The executed PDF
  is emailed to the facilitator.
- **Gating**: with a `current` version, an admin cannot move a facilitator *into*
  approved/published until they have signed it, and the dashboard shows a sign screen
  instead of the studio. With no `current` version nothing is asked or enforced.
- **PDF** is rendered on demand from the immutable rows (`GET /facilitators/agreement/pdf`,
  `GET /admin/facilitators/{id}/agreement`); nothing is stored in S3.

## Rollout (order matters)

1. Apply `db/migrations/0066_facilitator_agreement.sql`. **Before** the backend deploy:
   `apply()` now reads the new tables.
2. `cdk deploy HilomMarketplaceStack` (new routes, `pdf-lib` in the bundle).
3. Push the frontend (Amplify).
4. Admin → People → Agreement: open the seeded draft, have counsel finalise the text, fill
   in Hilom's authorized representative and address, then **Publish**. That is the switch.

## Known limits

- Backend enforces the gate at approval/publish, not on every dashboard write; the dashboard
  gate is UI-level for facilitators already approved before a new version.
- Engagement Orders (per-event base fee / top-up) and Annex A are not modelled here; the
  agreement refers to them but the platform's existing event/booking fee terms carry them.
- Witness blocks were dropped from the template (click-to-sign has no witnesses).
