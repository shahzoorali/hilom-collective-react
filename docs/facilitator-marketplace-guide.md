# Facilitators, end to end

How the facilitator marketplace works from both sides: the **admin journey**
(vetting, publishing, money) and the **facilitator journey** (applying, setting
up, running sessions, getting paid).

A facilitator is a coach / breathwork / wellness practitioner who sells 1:1
sessions through Hilom. Hilom curates the roster, takes a per-facilitator
platform fee, collects every payment through PayMongo, and pays each facilitator
their share by hand.

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

Everything below is in **Admin → Facilitators**, **Admin → Bookings**, and
**Admin → Payouts**. Admin access is a Cognito `admin`-group token (or the legacy
shared key).

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

## 8. Payouts (Admin → Payouts)

Hilom collects the full payment and transfers each facilitator's share manually.
This screen is the ledger.

**Build a batch:** pick a facilitator + a calendar month → **Build batch**. It
pulls every **delivered** session in that period not already in a batch.

- "Delivered" = `completed` **or** `no_show`. A no-show still earns — the
  facilitator held the time. A future `confirmed` session is **not** paid in
  advance.
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
| Pay a facilitator | Payouts → Build batch → Approve → Mark paid | Delivered sessions only; enter processing fee |

---

# Facilitator journey

The dashboard is at **`/facilitator`**. No key prompt — access is the Cognito
`facilitator` group on your signed-in token. Tabs: **Overview, Bookings,
Services, Availability, Earnings, Profile.**

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
  weekly hours. Clear it to come back.
- Private: legal name, phone, and **bank + account for payouts** (never shown
  publicly).

Read-only, set by Hilom: **status, platform fee %, profile URL, email.** You
can't publish yourself or change your own commission — the backend rejects those
from this screen too.

## 4. Set up Services

**Services tab.** What you sell. Most facilitators start with a free intro call +
one paid session.

Two types you can create:

- **Single session** — one paid session. Set the price in pesos.
- **Complimentary intro call** — always free; **each client can book one per
  facilitator, ever**; you can only have **one active** intro call.

(Multi-session *packages* exist in the schema but aren't sellable yet — buying
one would charge full price and deliver a single session.)

Per service you also set:

| Field | Meaning | Default |
|---|---|---|
| Length | Session minutes (5–480) | 60 |
| Delivered | online / in person / either | online |
| Meeting link | Your standing room (Zoom/Meet). Sent to the client **only on a confirmed booking**, never shown publicly. Snapshotted onto each booking so changing it later can't redirect sessions already on someone's calendar. | — |
| Gap after each session | Buffer minutes; enforced by the DB overlap constraint | 0 |
| Minimum notice | How far ahead a client must book | 12 h |
| Bookable up to | Days ahead a client can book | 60 |
| Max per day | Cap on sessions/day (blank = unlimited) | unlimited |
| Cancellation note | Free-text, shown to clients | — |
| Show this on my profile | Active toggle | on |

**Removing** a service deactivates it — bookings already taken are unaffected and
stay in your calendar. History is never destroyed.

## 5. Set up Availability

**Availability tab.** Two things:

- **Weekly hours** — a recurring grid, edited as a whole and saved in one click
  ("Save weekly hours"). Add multiple windows per day (a 9–12 and a 2–6 block is
  a lunch break). Times are in **your own timezone**; clients see them converted
  to theirs. The slot engine projects these rules onto real dates and subtracts
  buffers, notice, daily caps, blackouts, and existing bookings.
- **Time off (blackouts)** — one-off unavailable ranges (a holiday, a
  conference). Blocks **new** bookings only. Sessions already booked in that
  range stay in your calendar — cancel those individually if you need to, so the
  client is notified and refunded.

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
3. Double-booking is impossible — the database rejects any overlapping live
   booking for you, so two people clicking the last slot can't both win.
4. Both of you get a confirmation email, then a **reminder ~24 h before**.

## 8. Run sessions (Bookings tab)

Each booking shows the time (in your viewer's timezone), the client's name,
email, and notes, and what you earn. Actions:

- **Join** — opens your meeting link (future sessions).
- **Cancel** (confirmed, future) — the client is **refunded in full and
  emailed, whatever the notice period**. Use sparingly; it's the cancellation
  policy's most expensive path for Hilom.
- **Mark no-show** (after the session time, `confirmed`/`completed` only) —
  records that the client didn't attend. **A no-show still pays you** — you held
  the time. You can't mark a future session as a no-show.

After a session's end time + a 30-minute grace, a sweep job moves it
`confirmed → completed` automatically. That's what makes it payable.

### What the client can do

- **Cancel:** ≥24 h before = full refund · 12–24 h = half · <12 h = none.
  (You cancelling is always a full refund to them.)
- **Reschedule:** only ≥24 h before the current start time. Closer than that they
  can only cancel. No re-payment; the new slot is re-checked against all your
  rules.

All refund amounts are **recorded**; Hilom sends the money by hand.

## 9. Earnings & payouts (Earnings tab)

- **This month** — gross, the Hilom fee (shown explicitly, with your %), and your
  net. The fee is never hidden behind a single number.
- **Awaiting payout** — delivered sessions not yet in a payout batch.
- **Payout history** — each batch: net amount, period, status, reference.

Payouts run on Hilom's schedule (typically one transfer per period, not per
session). Hilom builds a batch from your delivered + not-yet-paid sessions,
deducts the platform fee and the batch's PayMongo processing cost, and transfers
the rest to the bank details on your Profile. `paid` + a reference means the
money has left Hilom's account.

Rounding on the fee split always goes **to the facilitator** (the fee is rounded
down).

## Facilitator quick reference

| I want to… | Where |
|---|---|
| Apply | `/facilitators/apply` (sign in first) |
| Get in after approval | Sign in again, then `/facilitator` |
| Edit what clients see | Profile tab |
| Add / price a session | Services tab |
| Set my weekly hours | Availability → Save weekly hours |
| Take a holiday | Profile → Away until, or Availability → Time off |
| See who's booked | Bookings tab / Overview |
| Join a session | Bookings → Join |
| Report a client no-show | Bookings → Mark no-show (after the time) |
| Cancel a session | Bookings → Cancel (client refunded in full) |
| Check what I've earned | Earnings tab |
| Change my fee % or publish myself | You can't — that's Hilom's call |

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
- **A no-show is paid; a cancellation is not.**
- **Facilitator/admin cancellation = full refund, always.** Client cancellation
  is tiered by notice.
- **Nothing in this system moves money.** Refunds and payouts are recorded here
  and sent by hand in PayMongo.
- **Suspending never cancels bookings.** Cancel them individually if the sessions
  shouldn't happen.
- **Empty availability = no bookings**, by design.
