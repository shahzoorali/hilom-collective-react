# Canny backlog: delivery plan (2026-11-20, revised after reading every post, comment and screenshot)

Source: https://poky.canny.io/hilom-feature-requests. There are **15 posts**. A first pass only saw 10, because the rest of the list loaded in later.

## A. Likely already done: verify and reply/close (½ day)

| Post | Evidence | Action |
|---|---|---|
| URGENT: facilitator email on group-class signup | Our own reply on the post (Nov 6) says the "New seat" email is already sent to the facilitator, with a copy to kumusta@ | Close it as Complete; the reply already explains |
| [HIGH] No kumusta@ email for these payments | Screenshot: HIIT teacher-training "Payment 2" (event instalment) and group-class rows, Oct 14–17. Commit `05a40d8` added admin alerts for event instalments and group-class seats | Check SES logs for one payment made after `05a40d8`, then close |
| Internal Server Error: Group Classes Feedback | Screenshot: "Leave my review" on Innerchild Healing gives a 500. Commit `0436680` fixed the review-save 500 | Submit one test class review on production, then close |
| Assistant/Help Center on Facilitator Dashboard | Commit `03dc768` shipped the Help tab, per-tab guide links, and a welcome email with guides on approval | Reply that it's done. A facilitator-facing AI assistant is the only open part; treat it as a later idea |
| Multi-Session / Recurring Events (status: Planned) | Event series already exist (series review and delete in `9ecac92`) | Check whether "book individual sessions" and "whole program" are both supported; build only what's missing |

## B. Wave 1: bugs (1–2 days)

| Post | Root cause (confirmed in code or screenshot) | Fix |
|---|---|---|
| Duplicate course purchase emails | Request is accurate: `lib/fulfillment.ts:56` checks `fulfilled` only at the start, with no claim | Add an atomic claim step, like `class-fulfillment`/`booking-fulfillment`. Release the claim on failure so retries still work. Test with 2 concurrent webhooks plus a Moodle failure followed by a retry |
| Rejected event change still shows 2:00 AM | The server side is correct: reject sets `pending_changes = null` (`admin-events.ts:529`). **10:00 AM in UTC+8 is 02:00 UTC**, and the screenshot's edit form shows 21/11 02:00–03:30. So the facilitator **edit form is showing UTC**, not the rejected change. Saving that form may well have *created* the "change to 2 AM" request | Fix the datetime-local conversion in the facilitator event editor (and check the series editor). Check the facilitator's stored timezone. Search for the same pattern in the class and booking editors |
| "Module" still in course titles | Moodle titles are fixed (screenshot 2), but the course sync (`admin.ts` ~L187–204) only **inserts new** products and never updates the names of existing ones | Change sync to update `products.name` for already-linked courses, or add an admin "pull title from Moodle" action. Then re-sync |
| Support email on Facilitator Help page | Screenshot circles `hello@`, in `HelpTab.tsx:162` and `FacilitatorDashboard.tsx:374,499,517` | Change to `kumusta@` everywhere (confirm whether hello@ even receives mail) |
| Filipino Incense Making shows "no split" | Finance sales register shows "no split" for Batara's ₱2,500 tickets. The revenue split rules for Batara were never entered (noted as pending when Finance shipped) | **Data entry, not code:** add a Batara rule (₱1,500 facilitator / ₱1,000 Hilom, with PayMongo fee and venue on Hilom). Check whether the rule model supports a fixed amount and absorbed fees; if not, that's a small code change |

## C. Wave 2: small features (3–4 days)

| Post | Work |
|---|---|
| Community sign-ups to database + CSV | `community.ts` today only relays to SES. Add a `community_signups` table (unique email, merged interests, `marketing_consent` + `consent_at`, with grants + RLS), an optional consent checkbox, and an admin view with search, filter and CSV export. Optional later: import past sign-ups with consent = false |
| Registration bulk download | CSV per event and for all events, from admin registrations. Reuse the CSV helper from the community export |

## D. Wave 3: larger features (2–3 weeks)

| Post | Work |
|---|---|
| Manual booking for multi-session packages | Screenshot: the "Thrive" package, ₱25,000, offers only one slot. Show N slot pickers from the package's session count, all linked to one package booking. Add a "schedule remaining sessions later" option with a scheduled/remaining counter |
| Group packages: instalments and reminders | Reuse the event-instalment machinery (reminders, SES tracking, admin alerts). Configurable plan per package, schedule shown before checkout, per-instalment PayMongo link, paid/pending/overdue, reminders 7 days / 3 days / same day tied to session dates that stop once paid and follow reschedules, kept separate from session reminders. **Build after the manual-booking item** |
| Participant setup in the class/event editor | Not built yet. Per-offering welcome message, file uploads (S3 media), intake-form link and meeting links, all editable later. Sent automatically in the confirmation email for paid/confirmed signups. Ideally also shown on the participant dashboard |

## Delivery mechanics
- One branch per wave. Use `npm run build` in frontend (not `tsc --noEmit`).
- Confirm with the owner before every `cdk deploy`. The frontend ships on push to `main`.
- New tables get grants + RLS in the same migration.
- Move each Canny post to In progress / Complete, with a short reply, as it ships.

## Questions for the requester (Crizy)
- Incense split: are the PayMongo fee and venue rental always on Hilom for Batara, or only for this event?
- Community: should past sign-ups be imported from the kumusta@ mailbox?
- Packages: who sets instalment rules, the facilitator per package or a platform default?
- Participant setup: should materials also stay visible on the participant dashboard, or only go out by email?
