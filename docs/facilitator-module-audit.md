# Facilitator module — state of play and what's missing

An audit of the whole facilitator marketplace as it stands, and the gaps
between "it works" and "it's a tool a practitioner would choose to run their
practice on". Written 2026-09-03, after the OAuth meeting integrations and the
profile redesign landed.

> **Status, 2026-09-04.** All thirteen numbered gaps below have been built —
> migrations 0027–0036, plus the payout email that closed #5 the day before this
> audit was written. Each section keeps its original text so the reasoning that
> motivated it stays readable, with a **Built** note recording what was actually
> done and, where the shipped design differs from what the audit assumed, why.
>
> The "polish and growth" list near the end is untouched and remains the
> backlog. **Nothing here is deployed or migrated yet** — see *Deploying this*.

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

> **Built** (0036). The table needed no change; the *aggregate* did. The
> directory shows every published facilitator on one page, and "4.9 (23)" per
> card cannot come from a per-facilitator query without N+1, nor from averaging
> every approved review on the site in memory. So a running sum and count live
> on the facilitator row, maintained by a trigger written as "subtract what this
> row used to contribute, add what it contributes now" — one shape for every
> operation, so no path through moderation can drift the total. Two integers
> rather than a stored average, because they are exact and can be recomputed;
> the migration ends with the recompute that makes them a cache, not the truth.
>
> Two judgement calls worth recording. A **no-show is reviewable**: the client
> did not attend, was charged, and has something to report a facilitator would
> prefer they did not — excluding it would make the rating a measure of sessions
> that went well rather than of the practice. And the moderation screen says in
> as many words that it is *not* a quality bar on the opinion: a one-star review
> of a bad session is exactly what this is for, and filtering those out makes
> every remaining review worthless.
>
> The completion sweep asks once and never chases. Reviewers appear as
> "Maria C." or "A client", never anything derived from their email.

### 2. No messaging between client and facilitator

After a booking, the only channel is the email addresses that appear in
notification emails. There is no in-platform way to say "running five minutes
late", "can we move to Thursday", or "here's the doc I mentioned".

For 1:1 services this is table stakes. Every comparable tool (Calendly is the
exception because it's pure scheduling; anything coaching-shaped has it) lets
the two parties talk without swapping personal emails.

Needs: a per-booking thread, email notification on a new message, and a
facilitator inbox view.

> **Built** (0034). Threads are scoped to a **booking** rather than to a pair of
> people, which is a constraint chosen rather than conceded: "may I read this
> thread" becomes "is this your booking", which every handler already answers;
> it cannot be used to reach someone you have no booking with, which is the
> failure mode that turns a marketplace inbox into a harassment vector; and the
> context of "can we move it?" is never ambiguous. The cost is a returning
> client's conversation split across sessions — acceptable because the client
> view (#4) already gathers a person's sessions in one place.
>
> Notifications carry the message body: an email saying only "you have a new
> message" forces a trip to the site to read one sentence, which is exactly the
> friction that sends people back to mailing each other. Consecutive messages
> from one person inside fifteen minutes collapse into a single notification.
> Facilitators get both an inbox and an in-booking thread.

### 3. Multi-session packages are disabled

`SELLABLE_SERVICE_KINDS` excludes `package`. A facilitator can only sell single
sessions. Coaching, therapy-adjacent work and structured programs are almost
always sold as blocks — "6 sessions", "a 3-month container". The kind is fully
modelled in the schema and the decided design is documented in
`facilitator-input.ts`; the missing half is a purchase that grants N
schedulable credits.

Without this, a facilitator running a real program has to sell six separate
things and hope the client books all six.

> **Built** (0035), along exactly the decided lines. The package price is split
> across its sessions and the facilitator earns each share as that session is
> *delivered*, rather than the whole thing paying out on purchase — a client who
> takes two of six and stops would otherwise have had six paid out, making a
> refund money Hilom has to claw back from a facilitator it has already sent.
>
> `splitPackageSessions` allocates by running total rather than dividing and
> patching the remainder onto the last session. Both sum back exactly, but
> divide-and-patch only does so because of a correction step that has to be
> applied consistently to the price, the fee *and* the net — and that is where
> the bug would live. Tested exhaustively across awkward prices, rates and
> counts.
>
> Cancelling a package session returns the **credit**, not money. Credits are
> counted from live bookings rather than stored, so a cancelled session simply
> reappears. A package needs at least two sessions and a price.

### 4. No client relationship view for the facilitator

Every booking is an island. A facilitator seeing a returning client has no
"we've had four sessions, here's what we covered, here are my notes" view.
There is a single `client_notes` free-text field set *by the client* at
booking time, and nothing the facilitator can write.

Needs: a per-client timeline (their bookings with this facilitator), private
per-session facilitator notes, and a client "about" the facilitator maintains.

> **Built** (0033) as a Clients tab, with all three. The standing "about" note
> and the per-session note are kept separate deliberately: the first is edited
> constantly, the second belongs to one hour forever, and a single box for both
> would make every update to the former an edit to the history of the latter.
>
> No client entity is introduced — a client is still an email on a booking, and
> two facilitators seeing the same person keep entirely separate records, which
> is the only correct reading of what these notes are. RLS is on and grants
> nothing; `session_notes` is absent from every client-facing column list.

### 5. No payout notification

A facilitator is paid by manual bank transfer and finds out by opening the
Earnings tab and noticing. No email. `sendPayoutPaid` does not exist. The one
moment a marketplace most needs to feel reliable — "you've been paid" — is
silent.

> **Built** in commit `1970172`, the day before this audit was written — the
> audit was drafted against the commit before it.

---

## Missing — important (friction that adds up)

### 6. The per-service cancellation policy is cosmetic

A facilitator can write a `cancellation_policy` string per service. The actual
refund math in `booking-domain.ts` **ignores it entirely** — it always applies
the hardcoded 24h/12h tiers. So a facilitator who writes "48 hours notice, no
refunds after" is making a promise the system will not keep, and a client
reading it is misled. Either enforce per-service policy or stop letting them
write one.

> **Built** (0027): enforced. The thresholds are two integers per service,
> snapshotted onto each booking so a later policy change cannot move what an
> already-booked client is owed. The sentence shown on the booking page, the
> profile, the service editor and the cancel dialog is generated from the same
> numbers the refund is computed from, so the promise and the payout cannot
> drift; the free-text field is demoted to the facilitator's own notes beside it.
>
> The reschedule notice window now tracks the full-refund threshold rather than
> a fixed 24 hours, for the reason `canReschedule` already documented: a free
> move inside the paid-cancellation window is that policy defeated by another
> name.

### 7. Facilitators cannot reschedule, only cancel

`facilitator-portal.ts` has no reschedule path. If a facilitator needs to move
a session, their only option is to cancel (full refund) and ask the client to
rebook — losing the payment, the slot, and often the client. They should be
able to propose a new time the client accepts.

> **Built** (0029) as a **proposal**, not a facilitator-side reschedule: the
> booking is untouched until the client accepts. One party silently moving the
> other's committed hour is a different act from moving one's own calendar, and
> not one a client forgives twice.
>
> The proposed slot is deliberately not held — holding a real bookable hour on
> the strength of an unanswered offer costs more than the rare lost race, and
> acceptance re-verifies through the same engine any booking goes through.
> Accepting is exempt from the client-side reschedule notice window: that rule
> protects the facilitator's hour from a late client move, and here the
> facilitator is the one asking.

### 8. No calendar feed (iCal / Google Calendar subscribe URL)

A facilitator's confirmed sessions live only in the Hilom dashboard. To see
them alongside the rest of their life they'd re-enter each one by hand. A
read-only signed `.ics` feed URL is small to build and is the difference
between "a site I check" and "a tool in my workflow".

> **Built** (0030). Unauthenticated by necessity — calendar clients poll on a
> schedule with no session and no way to send a bearer token — so the credential
> is a 32-byte random token in the URL, minted on demand and rotatable, with the
> Connections tab saying so plainly rather than burying it.
>
> The serialiser is hand-written (`backend/src/lib/ical.ts`) and tested on the
> three rules with an exact answer: escaping, 75-*octet* folding that never
> splits a multi-byte character, and UTC timestamps. iCalendar failures are
> silent and remote — a mis-folded line is a file some app on someone else's
> machine quietly refuses to parse. Events end when the *session* does rather
> than after the scheduling buffer, and cancellations are published as
> `STATUS:CANCELLED` rather than omitted.

### 9. No availability preview for the facilitator

They configure weekly hours plus buffer, minimum notice, advance window and
daily cap — four interacting rules — with no way to see the resulting slots a
client would actually see. Misconfiguration (e.g. 12h notice + a 2h buffer +
`max_per_day: 1`) is silent until bookings dry up.

> **Built** as a "What clients see" panel on the Availability tab, backed by
> `GET /facilitator/slot-preview`. It works on an unpublished profile and an
> inactive service — checking the configuration *before* going live is the
> point, and that is exactly when the public endpoint refuses to answer.
>
> An empty week comes with reasons, found by running the real slot engine with
> each rule applied **in isolation** against an otherwise permissive
> configuration. Isolation rather than relaxation: two rules can each be enough
> to empty a week on their own, so lifting either one leaves it empty and the
> facilitator would be told nothing at all.

### 10. No facilitator-initiated / manual booking

A facilitator cannot book a client in directly — someone who paid offline, a
pro-bono session, a rebooking after a cancellation. Everything must go through
the public paid flow. A "book a client" action (with an optional "already
paid" flag that skips PayMongo) covers a real recurring need.

> **Built** (0031). The design is really a money decision. These rows carry
> **zero** in every money column, because payouts disburse money Hilom actually
> collected, and a booking claiming a price PayMongo never saw would have Hilom
> paying the facilitator's share out of its own pocket — surfacing only at
> reconciliation, as a shortfall nobody could account for. What the client paid
> the facilitator directly is recorded separately as a note nothing reads to
> move money.
>
> A payable *flag* was rejected: it makes every earnings and payout query
> responsible for remembering it, and a query that forgets pays out real money.
> Zero is not something a sum can get wrong. Both the booking form and the
> Earnings tab say this in as many words, since a facilitator who believed
> otherwise would be waiting on a payout that is never coming.

### 11. Vacation mode is half a feature

`vacation_until` blocks *new* bookings in the window but does nothing about
bookings already in it. The facilitator has to spot and cancel each one. Going
away should at least surface "you have 3 sessions during your time off".

> **Built**: the profile save returns the conflicting sessions, the overview
> carries a banner for the whole away period (someone books time off in March
> for a trip in June, and the sessions that need moving are the ones they will
> have forgotten), and each affected session is flagged in the bookings list.
>
> It reports rather than cancels. Auto-cancelling a week of sessions and
> refunding every client in full off the back of a date field is a destructive
> act triggered by a setting nobody would expect to be destructive.

### 12. No pre-session intake

A client books and gets a meeting link. There is no "fill this in first" —
health questionnaire, intake form, "what do you want from this session". The
single `client_notes` field is optional and unstructured. For wellness work
this is often clinically important, not just nice-to-have.

> **Built** (0032). Questions are jsonb on the service, answers jsonb on the
> booking, and each stored answer carries a copy of the label it was answering.
> The relational shape was rejected for a specific reason: editing a question
> would either rewrite the meaning of answers already given or force versioning
> every question to avoid it. An answered intake is a *document* — what this
> person was asked, and what they said.
>
> Required questions are enforced server-side on every submission, revisions
> included: a facilitator relying on "have you had surgery in the last six
> months" as screening is relying on something a browser-side asterisk does not
> provide. Answers are validated by iterating the questions rather than the
> submitted body, so the document cannot become arbitrary storage on someone
> else's booking.
>
> The form is first asked mid-checkout, when someone wants to be finished, so it
> stays open until the session starts and the 24h reminder nudges anyone who has
> not filled it in. The *questions* are public on the service — a client is
> entitled to see what they are about to be asked. Only the answers are private.

### 13. Both parties' timezones are not shown together

The dashboard renders times in the viewer's zone. A Manila facilitator with a
Sydney client should see both zones on the booking, every time — "3:00 PM
(your time) / 6:00 PM (client's time)". Right now one side is always doing
the mental arithmetic that causes missed sessions.

> **Built** (0028). The client's zone was never captured at all — it is now
> taken from the browser at booking time. Every notification email used to
> render the *facilitator's* zone to both recipients, so an overseas client was
> always the one converting; each copy now leads with its reader's own time and
> carries the other beside it, as do both dashboards. Degrades to a single
> labelled time when the other zone is unknown or resolves to the same wall
> clock at that instant — "3:00 PM (3:00 PM for them)" is noise that teaches
> people to skim the line that matters.

---

## Missing — polish and growth

Untouched. This remains the backlog.

- **Directory browse at scale.** The specialty filter was removed (deliberately
  — free-text tags made a poor filter). Fine for a handful of facilitators; a
  roster of 50 needs *something* — search, or a curated category set. (Ratings
  now give the cards something to sort by, if that turns out to be the answer.)
- **Profile SEO / share cards.** Facilitator pages have no Open Graph tags. A
  facilitator sharing their link on Instagram gets a bare URL with no image or
  blurb.
- **Facilitator analytics.** Earnings tab shows this-month and awaiting-payout
  only. No booking rate, no-show rate, repeat-client rate, or revenue trend —
  the numbers a practitioner uses to run the business. (The Clients tab now
  holds most of the raw material for this.)
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

### New, arising from what was built

- **Package refunds.** `booking_packages` has a `refunded` status and refund
  columns, but nothing sets them. A client abandoning a package halfway has no
  path to a partial refund of the unused credits beyond emailing support.
- **Stale reschedule proposals.** A proposed time nobody answers sits on the
  booking until the session passes. `proposed_at` exists so a sweep could expire
  them; none does yet.
- **Message moderation and rate limiting.** Threads are unmoderated and
  unthrottled. Fine at this volume, not fine at any other.
- **Calendar feed is facilitator-only.** Clients have no equivalent, and would
  benefit as much.

---

## What was built, and in what order

Built 2026-09-03/04, in the order below — roughly this audit's own priority,
with the small correctness fix first and reviews last.

| # | Gap | Migration |
|---|---|---|
| 5 | Payout notification email | — (commit `1970172`) |
| 6 | Per-service cancellation policy, enforced | 0027 |
| 13 | Both parties' timezones everywhere | 0028 |
| 11 | Vacation-mode conflicts surfaced | — |
| 9 | Availability preview, with diagnosis | — |
| 7 | Facilitator proposes a new time | 0029 |
| 8 | Subscribable iCal feed | 0030 |
| 10 | Facilitator-initiated booking | 0031 |
| 12 | Pre-session intake | 0032 |
| 4 | Client relationship view | 0033 |
| 2 | Per-booking messaging | 0034 |
| 3 | Multi-session packages | 0035 |
| 1 | Reviews and ratings, end to end | 0036 |

## Deploying this

None of it is live. Before it is:

1. **Apply migrations 0027–0036** to Supabase, in order. Each is re-runnable.
2. **Deploy `HilomMarketplaceStack`.** There are new routes on nearly every
   handler in it — `/facilitator/slot-preview`, `/facilitator/calendar-feed`,
   `/facilitator/clients*`, `/facilitator/messages`, `/packages`,
   `/me/packages`, `/admin/reviews*`, `/facilitator-calendar/{token}`, and
   several per-booking sub-paths — plus a new `API_BASE_URL` environment
   variable on the facilitator portal function for the calendar feed URL.
   Check the branch first, and confirm before deploying.
3. **Amplify** picks up the frontend from `main` as usual.

One thing to watch on the first deploy: the completion sweep now sends a review
request for every session it transitions to `completed`. Its first run will move
any backlog of past-but-still-`confirmed` sessions at once and email each of
those clients. If that backlog is non-trivial, clear it in SQL first or accept
the batch knowingly.
