# Facilitator module — state of play and what's missing

An audit of the whole facilitator marketplace as it stands, and the gaps
between "it works" and "it's a tool a practitioner would choose to run their
practice on". Written 2026-09-03, after the OAuth meeting integrations and the
profile redesign landed.

---

## What exists and works

| Area | State |
|---|---|
| **Application** | Intake form (`/facilitators/apply`), admin review with a pre-publish checklist, `applied → approved → published → suspended` lifecycle, reject (terminal but re-appliable), direct admin add. Certificate document upload to a private bucket. |
| **Profile** | Public page (just redesigned), dashboard Profile tab editing every field, vacation mode (`vacation_until`), payout bank details, website + socials + years-of-experience now shown. |
| **Services** | CRUD, `exploratory` (free, one-per-client) and `standard` kinds, per-service scheduling rules (buffer, notice, advance window, daily cap), **meeting provider picker** (Google Meet / Zoom / manual). |
| **Availability** | Recurring weekly grid stored as weekday + minutes, one-off blackouts, per-facilitator timezone. |
| **Slot engine** | `slots.ts` / `scheduling.ts` — projects weekly rules onto real instants, subtracts buffers, notice, blackouts, existing bookings, daily caps, vacation. GiST exclusion constraint makes double-booking impossible at the DB. |
| **Booking flow** | Client picks a slot → 20-min hold → PayMongo (or instant for free) → confirm → **meeting created in the facilitator's account** → both parties emailed. |
| **Booking changes** | Client can cancel (tiered refund: full ≥24h, half 12–24h, none <12h) or reschedule (≥24h notice). Facilitator can cancel (always full refund) or mark no-show (still paid). Admin can cancel any booking. |
| **Meetings** | Google Meet space / Zoom scheduled meeting per booking, manual link as backup/fallback, Zoom PATCH on reschedule + DELETE on cancel, connection health surfaced on the Connections tab. |
| **Money** | Per-facilitator fee in basis points, split snapshotted onto each booking, earnings summary (this month + awaiting payout), admin payout batches (`draft → approved → paid`) with the full arithmetic shown, refund ledger (amounts recorded, money moved by hand). |
| **Notifications** | Confirmed, 24h reminder (sweep), cancelled, rescheduled, approved, meeting-link-failed. |
| **Housekeeping** | 5-min sweep: release lapsed holds, complete past sessions, send due reminders. |
| **Admin** | Facilitators tab (review/approve/publish/fee/suspend, certificate view, support-track filter), Bookings tab (all bookings, refunds-due queue, admin cancel), Payouts tab (build/approve/mark-paid batches). |

This is a complete, correct booking-and-payments pipeline. The gaps below are
about **trust, retention, and the daily experience of actually running a
practice on it** — not about it being broken.

---

## Missing — critical (a practitioner would not choose this tool without them)

### 1. Reviews and ratings — entirely unbuilt

`facilitator_reviews` has existed since migration 0013: table, RLS, a
`pending/approved/rejected` moderation status, keyed one-per-completed-booking.
**Nothing writes to it, nothing reads it, there is no UI anywhere.**

A wellness marketplace with no visible social proof asks a client to book a
stranger for an intimate 1:1 on nothing but a self-written bio. This is the
single biggest hole.

Needs: a review prompt to the client after a `completed` session, a moderation
screen in admin, an aggregate rating + recent reviews on the public profile,
and a "reviews" count in the directory card.

### 2. No messaging between client and facilitator

After a booking, the only channel is the email addresses that appear in
notification emails. There is no in-platform way to say "running five minutes
late", "can we move to Thursday", or "here's the doc I mentioned".

For 1:1 services this is table stakes. Every comparable tool (Calendly is the
exception because it's pure scheduling; anything coaching-shaped has it) lets
the two parties talk without swapping personal emails.

Needs: a per-booking thread, email notification on a new message, and a
facilitator inbox view.

### 3. Multi-session packages are disabled

`SELLABLE_SERVICE_KINDS` excludes `package`. A facilitator can only sell single
sessions. Coaching, therapy-adjacent work and structured programs are almost
always sold as blocks — "6 sessions", "a 3-month container". The kind is fully
modelled in the schema and the decided design is documented in
`facilitator-input.ts`; the missing half is a purchase that grants N
schedulable credits.

Without this, a facilitator running a real program has to sell six separate
things and hope the client books all six.

### 4. No client relationship view for the facilitator

Every booking is an island. A facilitator seeing a returning client has no
"we've had four sessions, here's what we covered, here are my notes" view.
There is a single `client_notes` free-text field set *by the client* at
booking time, and nothing the facilitator can write.

Needs: a per-client timeline (their bookings with this facilitator), private
per-session facilitator notes, and a client "about" the facilitator maintains.

### 5. No payout notification

A facilitator is paid by manual bank transfer and finds out by opening the
Earnings tab and noticing. No email. `sendPayoutPaid` does not exist. The one
moment a marketplace most needs to feel reliable — "you've been paid" — is
silent.

---

## Missing — important (friction that adds up)

### 6. The per-service cancellation policy is cosmetic

A facilitator can write a `cancellation_policy` string per service. The actual
refund math in `booking-domain.ts` **ignores it entirely** — it always applies
the hardcoded 24h/12h tiers. So a facilitator who writes "48 hours notice, no
refunds after" is making a promise the system will not keep, and a client
reading it is misled. Either enforce per-service policy or stop letting them
write one.

### 7. Facilitators cannot reschedule, only cancel

`facilitator-portal.ts` has no reschedule path. If a facilitator needs to move
a session, their only option is to cancel (full refund) and ask the client to
rebook — losing the payment, the slot, and often the client. They should be
able to propose a new time the client accepts.

### 8. No calendar feed (iCal / Google Calendar subscribe URL)

A facilitator's confirmed sessions live only in the Hilom dashboard. To see
them alongside the rest of their life they'd re-enter each one by hand. A
read-only signed `.ics` feed URL is small to build and is the difference
between "a site I check" and "a tool in my workflow".

### 9. No availability preview for the facilitator

They configure weekly hours plus buffer, minimum notice, advance window and
daily cap — four interacting rules — with no way to see the resulting slots a
client would actually see. Misconfiguration (e.g. 12h notice + a 2h buffer +
`max_per_day: 1`) is silent until bookings dry up.

### 10. No facilitator-initiated / manual booking

A facilitator cannot book a client in directly — someone who paid offline, a
pro-bono session, a rebooking after a cancellation. Everything must go through
the public paid flow. A "book a client" action (with an optional "already
paid" flag that skips PayMongo) covers a real recurring need.

### 11. Vacation mode is half a feature

`vacation_until` blocks *new* bookings in the window but does nothing about
bookings already in it. The facilitator has to spot and cancel each one. Going
away should at least surface "you have 3 sessions during your time off".

### 12. No pre-session intake

A client books and gets a meeting link. There is no "fill this in first" —
health questionnaire, intake form, "what do you want from this session". The
single `client_notes` field is optional and unstructured. For wellness work
this is often clinically important, not just nice-to-have.

### 13. Both parties' timezones are not shown together

The dashboard renders times in the viewer's zone. A Manila facilitator with a
Sydney client should see both zones on the booking, every time — "3:00 PM
(your time) / 6:00 PM (client's time)". Right now one side is always doing
the mental arithmetic that causes missed sessions.

---

## Missing — polish and growth

- **Directory browse at scale.** The specialty filter was removed (deliberately
  — free-text tags made a poor filter). Fine for a handful of facilitators; a
  roster of 50 needs *something* — search, or a curated category set.
- **Profile SEO / share cards.** Facilitator pages have no Open Graph tags. A
  facilitator sharing their link on Instagram gets a bare URL with no image or
  blurb.
- **Facilitator analytics.** Earnings tab shows this-month and awaiting-payout
  only. No booking rate, no-show rate, repeat-client rate, or revenue trend —
  the numbers a practitioner uses to run the business.
- **Waitlist.** No way for a client to be notified when a fully-booked
  facilitator opens hours, or when a taken slot frees up.
- **Structured dispute flow.** If a session goes wrong the client's only
  recourse is emailing support. No "report an issue with this booking" that
  routes to admin with the booking attached.
- **Automated refunds.** Admin does the refund by hand in PayMongo, then marks
  it sent. PayMongo has a refunds API; at volume the manual step is a
  bottleneck and a source of "promised but not sent" gaps.
- **Extra one-off availability.** Blackouts subtract time; there is no way to
  *add* a one-off ("I'll open this Saturday only").
- **Re-upload / add credential documents.** The certificate is uploaded once at
  apply time with no path to add or replace one later.
- **Reviews moderation surface** (depends on #1) — the table's
  `pending/approved/rejected` status needs an admin screen.

---

## Recommended next, in order

1. **Payout notification email** (#5) — an afternoon, and it closes the most
   glaring "does this thing actually work" gap for the supply side.
2. **Reviews, end to end** (#1) — the biggest lever on client-side conversion.
   Prompt after `completed`, moderate in admin, show aggregate + recent on the
   profile and a rating on the directory card.
3. **Per-booking messaging** (#2) — removes the "swap personal emails" step
   that every 1:1 currently requires.
4. **Multi-session packages** (#3) — unlocks the way structured practices
   actually sell, and the design is already decided.
5. **Fix or remove the per-service cancellation policy** (#6) — small, but it
   is currently a promise the system breaks, which is worse than not offering
   it.

Everything else is real but sequenceable behind these five.
