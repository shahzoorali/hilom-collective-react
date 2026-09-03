# Facilitators, end to end

How the facilitator marketplace works from both sides: the **admin journey**
(vetting, publishing, money) and the **facilitator journey** (applying, setting
up, running sessions, getting paid).

A facilitator is a coach / breathwork / wellness practitioner who sells 1:1
sessions — singly or as multi-session packages — through Hilom. Hilom curates the
roster, takes a per-facilitator platform fee, collects payment through PayMongo,
and pays each facilitator their share by hand.

The one exception to "collects payment" is a session a facilitator **books in
themselves** for someone who paid them directly. Hilom records those but never
touches the money, and never pays anything out for them. It matters enough to
the arithmetic that it's called out wherever it applies.

---

## The lifecycle in one picture

```
applied ──approve──▶ approved ──publish──▶ published ──suspend──▶ suspended
   │                    │                     ▲                       │
 reject              (dashboard             reinstate ────────────────┘
   │                  access,
   ▼                  not listed)
rejected (terminal)
```

| Status | Dashboard access | In the public directory | Bookable |
|---|---|---|---|
| `applied` | no | no | no |
| `approved` | **yes** | no | no |
| `published` | yes | **yes** | **yes** |
| `suspended` | no | no | no — existing bookings kept |
| `rejected` | no | no | no |

`approved` and `published` are separate on purpose: a facilitator sets up
services and hours while `approved`, and Hilom flips them to `published` only
once the profile is ready. Suspending pulls someone from the directory without
destroying their booking history.

---

# Admin journey

Everything below is in **Admin → Facilitators**, **Admin → Bookings**,
**Admin → Reviews**, and **Admin → Payouts**. Admin access is a Cognito
`admin`-group token (or the legacy shared key).

## 1. Applications arrive

Two doors, one row shape:

- **Self-service** — someone signs in and fills in `/facilitators/apply`.
- **Direct add** — *Admin → Facilitators → + Add facilitator*, for someone Hilom
  already vetted elsewhere (a referral, a direct recruit).

Both land in **`applied`** ("Needs review"). The direct-add form does *not* let
you skip the queue — you still Approve and Publish separately. The email you
enter for a direct add **must match the email that person signs in with**, or
their dashboard will never link up.

## 2. Review an application

Open a row → **Review**. The drawer shows the application itself:

- **Contact** — preferred method, phone, email, social handle
- **Experience** — how long they've been practising
- **Wants support with** — which of the three service tracks (Design ·
  Build & Launch · Create Live Experiences). Empty is a real answer: it means
  they picked *"I'm not sure yet — I want Hilom's recommendation."*
- **Where they are now** — their program status, in their own words
- **About their work** — the long-form description
- **Website / socials**, **referral source**, and the **privacy consent**
  timestamp with the policy version they agreed to
- **Certification document** — a button that mints a 5-minute signed URL. The
  file lives in a private bucket with no CDN in front of it, so this is the only
  way to read one.

The queue can be filtered by **status** and by **support track**, since the
person who reviews a Build & Launch application isn't always the person who
reviews a retreat.

Decision buttons on an `applied` row: **Approve** or **Reject** (rejection is
terminal).

> **Credentials and scope of practice are empty at this stage, and that's
> normal.** The application form is triage — what someone wants to build and how
> involved Hilom should be. Public profile copy is written by the facilitator in
> their dashboard *after* approval. Those fields are checked before **Publish**
> instead, via the checklist described below.

## 3. Approve

**Approve** does three things atomically:

1. Adds the person to the Cognito **`facilitator`** group (attempted *before* the
   DB write — if Cognito is unreachable the status doesn't move and you retry).
2. Sets status to `approved` and stamps `approved_at`.
3. Sends the **"you're approved"** email.

The facilitator now has dashboard access but is **not listed**. If they were
already signed in, they must sign in again — Cognito stamps group membership at
token issue time.

## 4. Set the platform fee (optional)

**Fee** button → enter a percentage. Stored as basis points per facilitator
(default **1500 = 15%**; partner tiers 12% / 10% are just a data change). Fee
changes **only affect future bookings** — every booking snapshots its own split
at the moment it's taken, so renegotiating a rate in October never moves what
someone earned in August.

## 5. Publish

Open their row → **Review**. The drawer carries a **pre-publish checklist**
covering the four things a directory listing needs:

- credentials listed
- a scope-of-practice statement
- "my approach" copy
- at least one active service

It's advisory, not an enforced block — there are legitimate reasons to publish a
thin profile, and a hard gate would just send people looking for a way round it.
What it must not do is let the omission be invisible. Everything on it is the
facilitator's to fill in from their own dashboard.

Then **Publish**. They become visible in `/facilitators` and bookable
immediately.

## 6. Ongoing: suspend / reinstate

- **Suspend** — hidden from the directory, loses dashboard access. **Existing
  bookings are not cancelled** — cancel those individually if needed (see below).
- **Reinstate** — `suspended` → `published` again.

## 7. Bookings oversight (Admin → Bookings)

Spans every facilitator. Default filter is **"Refunds due"** — the one queue with
a person waiting at the end of it. Other filters: confirmed, completed, missed,
cancelled by client/facilitator, everything.

Each row shows the full split (`price · Hilom fee · facilitator net`), the
cancellation reason and who cancelled, and refund state.

**Admin cancel** (*Cancel & refund*, confirmed future sessions only):

- Always a **full refund**, regardless of notice period — this is the platform
  calling off a session the client didn't choose to lose.
- Recorded as `cancelled_by_facilitator` (that's what the client experiences),
  with `cancelled_by = admin` on the row for anyone reading it.
- Both parties are emailed.
- Use it when the other two cancel paths can't be reached — an unresponsive
  facilitator, a fraudulent booking.

**Mark refund sent** — the money moves by hand in PayMongo first, *then* you
paste the reference here. A reference is **required** — it's the proof the money
moved. Two admins can't both record the same refund (the write re-asserts
`refunded_at is null`).

Refunds are **recorded, not executed** anywhere in this system — consistent with
the "manual revoke, no automation" rule for course refunds.

> **Sessions inside a package refund differently.** Cancelling one session of a
> multi-session package returns the *credit* to the client — they can book it
> again — rather than refunding money. They paid for the block, and cancelling
> one session hasn't cost them it. Refunding a package as a whole is not built;
> that's still a support conversation.

## 8. Reviews (Admin → Reviews)

Every review a client writes lands as **Waiting** and is invisible until someone
reads it. Three filters: Waiting · Published · Not published.

Each row shows the rating and comment, which facilitator and which session it
concerns, the client's email (admin-only — the public review shows only
"Maria C."), and when it was written.

**What this screen is for, and what it is not.** It is *not* a quality bar on
the opinion. A one-star review of a session that went badly is exactly what
ratings are for, and rejecting it because it's unflattering makes every
remaining review worthless — a five-star average that had the bad ones filtered
out tells a prospective client nothing. What you're checking is whether
something about to be published permanently, under a real practitioner's name,
is abuse, someone's phone number, or a clinical disclosure the client will
regret making public.

**Publish** / **Don't publish** — and both are reversible. A published review
can be unpublished and vice versa; the facilitator's star average follows either
way. Nothing is ever deleted.

Only clients with a session that **actually took place** can review, one review
per session, so there is no path for a review from someone who never had one.
Note that includes sessions marked **no-show** — the client was charged and has
an experience to report, and excluding them would make the rating a measure of
sessions that went well rather than of the practice. Expect the occasional
aggrieved facilitator on this point; the answer is that moderation catches abuse,
not unflattering opinions.

## 9. Payouts (Admin → Payouts)

Hilom collects the full payment and transfers each facilitator's share manually.
This screen is the ledger.

**Build a batch:** pick a facilitator + a calendar month → **Build batch**. It
pulls every **delivered** session in that period not already in a batch.

- "Delivered" = `completed` **or** `no_show`. A no-show still earns — the
  facilitator held the time. A future `confirmed` session is **not** paid in
  advance.
- **Package sessions pay out one at a time.** A six-session package is a single
  payment from the client, but the facilitator earns each session's share as
  that session is delivered — so a batch picks up the two sessions held this
  month, not the whole block. That's deliberate: paying the whole package on
  purchase would mean clawing money back from a facilitator Hilom had already
  paid if the client stopped after two.
- **Sessions a facilitator booked in themselves are worth zero here** and never
  appear in a batch. Hilom collected nothing for them, so there is nothing to
  pay out. See *Book a client in* in the facilitator journey.
- Enter PayMongo's **processing cost** for the batch by hand (it isn't on the
  webhook payload). It's deducted from the facilitator's net.
- Concurrency-safe: if another batch claimed some sessions between the read and
  the write, the batch re-totals from what it actually won, or voids itself if
  nothing's left.

**Batch states:** `draft` (here are the numbers) → `approved` (checked, go send
it) → `paid` (money left the account, reference recorded). **Void** releases the
sessions back into the unpaid pool so a mistaken batch can be rebuilt.

The card shows the full arithmetic —
`gross − Hilom fee − processing = net` — plus the facilitator's bank details
from their profile.

## Admin quick reference

| Task | Where | Notes |
|---|---|---|
| Add a vetted facilitator | Facilitators → + Add facilitator | Lands in "Needs review"; email must match sign-in |
| Approve | Facilitators → row → Approve | Grants group + dashboard, sends email, not yet listed |
| Change fee | Facilitators → row → Fee | Percentage; future bookings only |
| Publish | Facilitators → row → Publish | Goes live in the directory |
| Suspend / reinstate | Facilitators → row | Bookings kept either way |
| Cancel a session for a client | Bookings → Cancel & refund | Always full refund, both parties emailed |
| Record a refund | Bookings → Mark refund sent | Send in PayMongo first, reference required |
| Publish or hold back a review | Reviews → Publish / Don't publish | Reversible; publish unflattering ones too |
| Pay a facilitator | Payouts → Build batch → Approve → Mark paid | Delivered sessions only; enter processing fee |

---

# Facilitator journey

The dashboard is at **`/facilitator`**. No key prompt — access is the Cognito
`facilitator` group on your signed-in token. Tabs: **Overview, Bookings,
Clients, Messages, Services, Availability, Earnings, Profile, Connections.**

## 1. Apply

At **`/facilitators/apply`**: sign in with a Hilom account first (your
application and later your dashboard live in that account), then fill in the
form. It asks what you want to build — not for your full profile, which comes
later.

**About you** — your name, and a photo.

**How can we reach you?** — preferred contact method (Email · Phone ·
Instagram DM · WhatsApp), your email (fixed to the account you signed in with),
a phone number, and your social handle. A phone number is required if you chose
Phone or WhatsApp; a handle is required if you chose Instagram DM.

**About your work**

- **Tell us about your work** — what you do, who you work with, how you run a
  session
- **How long have you been doing this work?** — under 1 year · 1–3 · 3–5 · 5+
- **What kind of support do you need?** — any of the three Hilom tracks:
  **01 Design with Hilom** (shape your expertise into a learning experience) ·
  **02 Build & Launch with Hilom** (bring your course online) ·
  **03 Create Live Experiences** (a workshop or retreat). Each card lists what's
  included and the engagement shape. **You can leave this blank** if you'd
  rather Hilom recommended one.
- **What do you have for your programs right now?** — pick any that apply, from
  "I have an existing program and want to put it online" through to "I'm not
  sure yet — I want Hilom's recommendation."
- **Website**, and an optional **certification or affiliation document** (PDF).
  Only Hilom sees the document — it is never shown on your profile and is stored
  privately.

**Finally** — how you heard about Hilom, and agreeing to the privacy policy.

You'll get an email once it's reviewed. If you've already applied, the form
tells you your current status instead of creating a duplicate.

### After you submit

The confirmation screen sets out the three possible outcomes, taken from
Hilom's facilitator deck — so nobody is left guessing what "we'll be in touch"
means:

| | | |
|---|---|---|
| **01** | **Proceed** | There's a strong fit. We'll confirm the pathway, partnership terms, and schedule Kick-Off. |
| **02** | **Develop further** | There's potential, but the offering needs more clarity or development before Kick-Off. |
| **03** | **Not right now** | The opportunity may not be the right fit or timing for Hilom today. |

The happy path is **Proceed → Agreement → Kick-Off**. The same panel shows to
anyone who re-opens the form while still in the queue, and is hidden once
they've been approved, rejected or suspended — at that point they've had their
answer.

> Credentials, specialties, scope of practice, languages and delivery mode are
> **not** on this form any more. You write those in your dashboard once
> approved, before Hilom lists you — so nobody drafts a public profile for an
> application that hasn't been read yet.

## 2. You're approved

You get an email. **Sign in again** — your access attaches to a fresh sign-in.
Then open `/facilitator`. Your status pill reads **"Not yet listed"** until Hilom
publishes you. The Overview banner: *"Set up your services and availability —
Hilom publishes your profile once it's ready."*

## 3. Set up your Profile

**Profile tab.** What the public sees plus private details. **This is where the
application form left off** — until you've added your credentials, scope of
practice and approach, a banner at the top of this tab tells you what Hilom is
still waiting on, and you won't be listed.

- Public: name, headline, photo URL, approach (basic formatting kept, rest
  stripped), specialties (these become the **filters clients browse by**),
  credentials, scope of practice, location, languages, delivery mode.
- **Your timezone** — your availability is stored against this. Get it right.
- **Away until** — vacation mode. Pauses all *new* bookings without touching your
  weekly hours. Clear it to come back. **Sessions already booked in that window
  stay put** — saving lists them for you, and the Overview keeps a banner up for
  the whole period so a trip booked in March doesn't ambush you in June. Hilom
  won't cancel them for you: that would refund every one of those clients in
  full off the back of a date field.
- Private: legal name, phone, and **bank + account for payouts** (never shown
  publicly).

Read-only, set by Hilom: **status, platform fee %, profile URL, email.** You
can't publish yourself or change your own commission — the backend rejects those
from this screen too.

## 4. Set up Services

**Services tab.** What you sell. Most facilitators start with a free intro call +
one paid session.

Three types you can create:

- **Single session** — one paid session. Set the price in pesos.
- **Complimentary intro call** — always free; **each client can book one per
  facilitator, ever**; you can only have **one active** intro call.
- **Package of sessions** — a block sold as one payment (a "6 sessions", a
  "3-month container"). Needs **at least two sessions and a price**. See below.

Per service you also set:

| Field | Meaning | Default |
|---|---|---|
| Length | Session minutes (5–480) | 60 |
| Delivered | online / in person / either | online |
| Meeting link | Your standing room, or let Hilom create one per booking in your own Google/Zoom account (see **Connections**). Sent to the client **only on a confirmed booking**, never shown publicly. Snapshotted onto each booking so changing it later can't redirect sessions already on someone's calendar. | — |
| Gap after each session | Buffer minutes; enforced by the DB overlap constraint | 0 |
| Minimum notice | How far ahead a client must book | 12 h |
| Bookable up to | Days ahead a client can book | 60 |
| Max per day | Cap on sessions/day (blank = unlimited) | unlimited |
| **Full refund with at least** | Hours of notice for a full refund | 24 h |
| **Half refund with at least** | Hours of notice for half. Below it, nothing. | 12 h |
| Cancellation note | Free text, shown *under* the generated policy sentence | — |
| Before the session | Your intake questions (see below) | none |
| Show this on my profile | Active toggle | on |

**Removing** a service deactivates it — bookings already taken are unaffected and
stay in your calendar. History is never destroyed.

### Your cancellation policy is now real

The two refund-notice fields **are** the policy. The refund a cancelling client
actually gets is computed from them, and the sentence shown on your profile,
on the booking page and in the cancel dialog is generated from the same two
numbers — so what a client is promised and what they're paid can't drift apart.
The editor previews that sentence as you type.

This changed. The old free-text "cancellation note" was **cosmetic** — the
platform applied a fixed 24 h / 12 h ladder no matter what you'd written, so
"48 hours notice, no refunds after" was a promise the system quietly broke. If
you wrote a policy before this shipped, **check it now**: your service kept the
24/12 default, which may not be what your note says.

The free-text note still exists, demoted to what it should always have been —
your own extra wording shown beneath the real policy.

One thing the fields don't govern: **you cancelling is always a full refund**,
whatever you set. Your thresholds are about a client changing their mind, not
about you changing yours.

### Multi-session packages

A package is bought once and scheduled afterwards. The client pays for the whole
block; nothing is booked at purchase. They then book each session from their own
bookings page, one at a time, whenever suits them.

- **You earn each session's share as you deliver it**, not all at once on
  purchase. A ₱12,000 six-session package pays you in six parts, as the six
  sessions happen.
- **Cancelling a session returns the credit**, not money. Someone who bought six
  and cancelled one still has six to use.
- Packages need a price. A free package would be an unlimited supply of free
  sessions — the free intro call is capped at one per client, and no such cap
  can exist for a block of N.
- A one-session "package" is refused. That's a single session under a confusing
  name, and it would put the buyer through a credit flow for nothing.

### Pre-session intake

**Before the session** on each service builds a short form your client answers
when they book. Short answer, long answer, choose-one, or a tick-to-confirm; each
can be marked **must answer**.

For wellness work this is often screening rather than paperwork — "is there
anything about your health I should know", "have you done breathwork before", a
tick confirming this isn't medical treatment. Required questions are enforced
properly, so a client can't book past one.

- Answers appear on the booking in your **Bookings** and **Clients** tabs.
- The client can **revise their answers up until the session starts**. The form
  is first asked mid-checkout, when people want to be finished, so a
  half-remembered health answer often gets corrected that evening.
- Anyone who hasn't filled it in is nudged in their 24-hour reminder email, and
  the booking is flagged for you.
- The **questions** are visible on your public profile — a client is entitled to
  see what they'll be asked before booking. Only the **answers** are private.
- Editing your form later never changes what an existing client was asked; each
  answer keeps a copy of the question it answered.

## 5. Set up Availability

**Availability tab.** Three things:

- **Weekly hours** — a recurring grid, edited as a whole and saved in one click
  ("Save weekly hours"). Add multiple windows per day (a 9–12 and a 2–6 block is
  a lunch break). Times are in **your own timezone**; clients see them converted
  to theirs. The slot engine projects these rules onto real dates and subtracts
  buffers, notice, daily caps, blackouts, and existing bookings.
- **Time off (blackouts)** — one-off unavailable ranges (a holiday, a
  conference). Blocks **new** bookings only. Sessions already booked in that
  range stay in your calendar — cancel those individually if you need to, so the
  client is notified and refunded.
- **What clients see** — the preview, and the most useful thing on this screen.

### "What clients see"

The next two weeks of genuinely bookable times for a chosen service, after
*everything* has been applied: weekly hours, buffer, minimum notice, booking
window, daily limit, time off, and sessions already booked.

It works before you're published and on hidden services, because checking the
configuration before going live is the whole point.

**If it's empty, it tells you why.** Four interacting rules on top of a weekly
grid is easy to get wrong in a way that's completely silent — 12 hours' notice
plus a 2-hour buffer plus one session a day can produce an empty calendar, and
the only symptom is that bookings stop. The preview names every setting that is,
on its own, enough to empty the period. Expect more than one reason sometimes:
fixing only the first wouldn't have changed anything.

If you save an empty grid you get **no bookings** — that's the safe failure
direction (better than offering hours you didn't agree to).

## 6. Go live

Hilom flips you to **`published`**. Your status pill turns to **"Live"** and a
**View profile** link appears. Clients can now find you at
`/facilitators/<your-slug>` and book.

## 7. How a booking reaches you

1. Client picks a service + a slot on your public profile.
2. **Paid session:** the slot is *held* (`pending_payment`) and the client goes
   to PayMongo. If they abandon checkout, the hold lapses (~20 min) and the slot
   frees up automatically. On payment, the booking becomes `confirmed`.
   **Free intro call:** confirmed immediately, no PayMongo.
   **Package:** the client pays for the block, then books each session from
   their bookings page — each one confirmed immediately, nothing more to pay.
3. Double-booking is impossible — the database rejects any overlapping live
   booking for you, so two people clicking the last slot can't both win.
4. Both of you get a confirmation email, then a **reminder ~24 h before**.

**Every time you're shown is in both zones.** Your own first, your client's
beside it — "Thu 12 Mar, 3:00 PM GMT+8 · Thu 6:00 PM GMT+11 for your client" —
on the dashboard and in every email. Their copy leads with *their* time and
shows yours. A Manila facilitator with a Sydney client is the normal case here,
and one side doing the arithmetic in their head is how sessions get missed. If
a client's browser never reported a zone, you'll just see one labelled time
rather than a guess.

## 8. Run sessions (Bookings tab)

Each booking shows the time in both zones, the client's name, email, their
booking note and intake answers, and what you earn. Actions:

- **Join** — opens your meeting link (future sessions).
- **Message** — the conversation for this session (see **Messages**).
- **Suggest another time** — offer the client a different slot instead of
  cancelling. Listed before Cancel deliberately; for "something came up, could
  we do Thursday?", cancelling is almost never what you want.
- **Cancel** (confirmed, future) — the client is **refunded in full and
  emailed, whatever the notice period**. Use sparingly; it's the cancellation
  policy's most expensive path for Hilom.
- **Mark no-show** (after the session time, `confirmed`/`completed` only) —
  records that the client didn't attend. **A no-show still pays you** — you held
  the time. You can't mark a future session as a no-show.

After a session's end time + a 30-minute grace, a sweep job moves it
`confirmed → completed` automatically. That's what makes it payable.

### Suggest another time

You pick from your own genuinely-free slots and add an optional note ("I'm so
sorry — I have a clinic that morning"). Your client gets an email and can
**accept or decline** from their bookings page.

- **Nothing moves until they accept.** The session stays exactly where it is,
  and the dashboard keeps saying so while you're waiting. You can withdraw the
  offer at any time.
- **The slot isn't held** while you wait. If someone books it first, your client
  is told to ask you for another time rather than being handed a broken offer.
- There's no notice requirement on *making* the offer — needing to move
  tomorrow morning's session is exactly the case this exists for. What protects
  the client is that they can simply say no.
- Declining leaves the original session standing, and tells you so — the useful
  half isn't the refusal, it's that the hour you were trying to free is still
  yours.

### Book a client in

**Bookings → Book a client in.** For everything the public flow doesn't cover:
someone who paid you by bank transfer or in cash, a pro-bono session, a goodwill
rebooking, the long-standing client who has always just texted you.

Pick a service, type their email, choose from your free slots. They don't need a
Hilom account — if they make one later with that address, the session is already
there. From then on it behaves like any other session: meeting link created,
both of you emailed.

> **No money goes through Hilom, and Hilom owes you nothing for it.** You've
> already been paid, or chosen not to be. The "what they paid you" box is a note
> for your own records — it appears on the booking and in a separate *Arranged
> by you this month* panel on Earnings, and it deliberately stays out of your
> Hilom earnings and payouts. Don't wait on a transfer for these.

Your away dates don't block this one — booking into a week you're away is either
a mistake you'll catch on the form, or exactly the exception you opened it to
make.

### What the client can do

- **Cancel:** judged by **your** service's refund thresholds — full refund at or
  above your full-refund notice, half at or above your half-refund notice,
  nothing below it. (You cancelling is always a full refund to them.) A session
  inside a package returns the credit instead of money.
- **Reschedule:** only at or above your **full-refund** threshold. Closer than
  that they can only cancel. That line moves with your policy on purpose: below
  it, cancelling costs them money, so a free move would be strictly the better
  option and your policy would be bypassed by another name. No re-payment; the
  new slot is re-checked against all your rules.
- **Accept or decline** a time you've suggested.
- **Message you** about the session.
- **Fill in or revise your intake form**, up until the session starts.
- **Review you**, after the session.

All refund amounts are **recorded**; Hilom sends the money by hand.

## 9. Clients tab

The Bookings tab answers "what's happening this week". This answers "who is this
person and what have we done" — the question you have thirty seconds before a
session with someone you last saw six weeks ago.

Everyone you've seen, and per person: every session with you, their intake
answers, what they wrote at booking, and two kinds of note you write.

- **About this client** — the standing picture. What they're working on, what to
  remember, how you like to start. Read before every session, edited constantly.
- **Notes on this session** — what happened in one hour. Written after, and
  belongs to that hour forever.

They're separate on purpose: one box for both would make every update to the
first an edit to the history of the second.

**Neither is ever shown to the client**, or included in any email. If you're
unsure about that you'll write nothing useful, so: they're yours. Two
facilitators seeing the same person keep entirely separate records.

## 10. Messages tab

A conversation attached to each booking, so neither of you has to hand over a
personal email address to say "running five minutes late" or "could we move to
Thursday".

- **Threads are per session.** A client who's had four sessions has four
  threads. Their whole history is gathered on the **Clients** tab instead.
- The **inbox** lists conversations with unread ones first — you shouldn't have
  to open twelve sessions to find out whether anyone asked you something. You
  can also message from inside a booking.
- **New messages are emailed**, with the message text in them, so nobody has to
  come to the site to read one sentence. A run of messages from the same person
  within fifteen minutes arrives as one email rather than three.
- The thread closes when a session is cancelled.

## 11. Reviews

After a paid session, your client is asked once — by email, and on their
bookings page — how it went. One review per session, and only from someone who
booked and paid for a session that then happened. Cancelled sessions can't be
reviewed: nothing happened, and a review of a session that didn't take place is
a review of the cancellation policy.

- **Hilom reads every review before it appears.** That's a check for abuse,
  contact details and things a client may not have meant to make public — *not*
  a filter on unflattering opinions. Bad reviews get published.
- Approved reviews show on your profile with the rating, the comment, and the
  client's first name and last initial ("Maria C."). Your average and review
  count appear on your profile and on your directory card.
- Clients can revise a review later; a revised one is read again before it
  reappears.
- Complimentary intro calls aren't reviewed — rating a fifteen-minute "are we a
  fit" chat would mostly measure how many free calls someone offers.
- **No reviews yet is shown as no rating**, not as zero stars. A new facilitator
  doesn't look worse than a badly-reviewed one.
- **A client you marked as a no-show can still review you.** That's deliberate,
  and worth knowing before it happens: they were charged, they had an
  experience, and a rating that only counted sessions which went well would
  measure the sessions rather than the practice. If one is unfair rather than
  merely unflattering, that's a conversation with Hilom — moderation happens
  before anything appears.

## 12. Connections tab

Two directions, both about the tools you already use.

**Meeting accounts** — link your own Google or Zoom so Hilom creates a real
meeting per booking in *your* account, with you as host. Pick the provider per
service. Hilom holds no meeting account of its own.

**Your sessions in your own calendar** — a private link you subscribe to in
Google Calendar, Apple Calendar or Outlook. Your Hilom sessions then appear
alongside the rest of your life, updating on their own. It's read-only: nothing
you do in your calendar changes a booking here.

> **Treat the link like a password.** It carries a secret, and anyone with it
> can see your schedule — that's how every subscribable calendar feed works,
> because calendar apps can't sign in. If you ever share it by accident,
> **Generate a new link** and the old one stops working immediately. **Turn it
> off** removes it entirely. It isn't created until you ask for one.

Cancelled sessions are published to your calendar as cancellations, so they
actually disappear rather than lingering. Events end when the *session* ends —
your buffer stops Hilom booking over it, it doesn't block out your evening.

## 13. Earnings & payouts (Earnings tab)

- **This month** — gross, the Hilom fee (shown explicitly, with your %), and your
  net. The fee is never hidden behind a single number.
- **Arranged by you this month** — sessions you booked in yourself, and what you
  recorded being paid directly. Kept out of the totals above, because Hilom
  collected none of it and will pay out none of it.
- **Awaiting payout** — delivered sessions not yet in a payout batch.
- **Payout history** — each batch: net amount, period, status, reference.

Payouts run on Hilom's schedule (typically one transfer per period, not per
session). Hilom builds a batch from your delivered + not-yet-paid sessions,
deducts the platform fee and the batch's PayMongo processing cost, and transfers
the rest to the bank details on your Profile. `paid` + a reference means the
money has left Hilom's account — **and you get an email when it does**, so you
don't find out by checking this screen.

Rounding on the fee split always goes **to the facilitator** (the fee is rounded
down).

## Facilitator quick reference

| I want to… | Where |
|---|---|
| Apply | `/facilitators/apply` (sign in first) |
| Get in after approval | Sign in again, then `/facilitator` |
| Edit what clients see | Profile tab |
| Add / price a session | Services tab |
| Sell a block of sessions | Services → Package of sessions (2+, priced) |
| Set my cancellation policy | Services → the two refund-notice fields |
| Ask clients something before we meet | Services → Before the session |
| Set my weekly hours | Availability → Save weekly hours |
| Check my hours actually work | Availability → What clients see |
| Take a holiday | Profile → Away until, or Availability → Time off |
| See who's booked | Bookings tab / Overview |
| Join a session | Bookings → Join |
| Move a session | Bookings → Suggest another time (client accepts) |
| Book someone in myself | Bookings → Book a client in |
| Talk to a client | Messages tab, or Bookings → Message |
| Look up a client's history | Clients tab |
| Keep private notes | Clients → About this client / session notes |
| See my sessions in my own calendar | Connections → calendar link |
| Report a client no-show | Bookings → Mark no-show (after the time) |
| Cancel a session | Bookings → Cancel (client refunded in full) |
| Check what I've earned | Earnings tab |
| Change my fee % or publish myself | You can't — that's Hilom's call |
| Publish my own reviews | You can't — Hilom reads them first |

---

## Key rules that surprise people

- **Approve ≠ publish.** Approved facilitators are invisible until Hilom
  publishes them.
- **The apply form is not a profile.** It asks what someone wants to build.
  Credentials and scope of practice are written in the dashboard after approval
  and checked before publishing — so an `applied` row with neither is normal.
- **A newly approved facilitator must sign in again** before the dashboard works.
- **The fee is snapshotted per booking.** Changing a facilitator's rate never
  moves past earnings.
- **Your refund thresholds are the policy now.** They used to be decoration —
  the platform applied a fixed 24/12 ladder regardless. Existing services kept
  24/12, so if your old free-text note said something else, it says it wrongly
  until you change the numbers.
- **A no-show is paid; a cancellation is not.**
- **Facilitator/admin cancellation = full refund, always** — your own thresholds
  don't apply to you.
- **A package session cancels back to a credit, not to money.**
- **Package money arrives session by session.** Selling a six-session block
  doesn't pay you six sessions' worth this month.
- **Sessions you book in yourself pay you nothing through Hilom.** By design —
  Hilom never collected for them.
- **Suggesting a new time changes nothing until the client accepts**, and the
  slot isn't held while you wait.
- **Nothing in this system moves money.** Refunds and payouts are recorded here
  and sent by hand in PayMongo.
- **Suspending never cancels bookings.** Cancel them individually if the sessions
  shouldn't happen.
- **Going away never cancels bookings either** — it only stops new ones. You're
  shown what's already in the window.
- **Empty availability = no bookings**, by design. If you can't work out why your
  calendar is empty, *Availability → What clients see* will tell you.
- **Client notes and session notes are never shown to the client.**
- **Bad reviews get published.** Moderation is for abuse and privacy, not for
  protecting a star average.
- **A no-show client can still review.** They paid and had an experience;
  counting only sessions that went well would measure the sessions, not the
  practice.
- **Everything is shown in both timezones** — yours and your client's — on the
  dashboard and in every email.
