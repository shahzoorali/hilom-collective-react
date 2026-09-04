# Admin runbook

Day-to-day operation of `/admin`. This is the *procedural* companion to the
reference docs: what to open, in what order, and what will bite you.

It deliberately does not re-explain how each feature works. Where that matters:

- **Facilitators, bookings, reviews, payouts — how the mechanics work:**
  [facilitator-marketplace-guide.md](facilitator-marketplace-guide.md) (its
  *Admin journey* section is the reference; this is the shift handbook).
- **Course-order refunds:** [refund-runbook.md](refund-runbook.md) — that
  procedure is unchanged and is not repeated here.
- **API, secrets, deploys:** [backend-runbook.md](backend-runbook.md).

---

## Getting in

`/admin`. Access is either:

- a **Cognito `admin`-group token** on your signed-in account (preferred), or
- the **shared admin key** in the `x-admin-key` header, which the panel stores
  in `sessionStorage` after you paste it once.

Retrieving the shared key:

```bash
aws secretsmanager get-secret-value --region ap-southeast-1 \
  --secret-id hilom/admin-api-key --query SecretString --output text
```

The key is a stopgap that predates the Cognito group and still works. Prefer the
group: it is per-person and revocable, where the key is shared and rotating it
locks out everyone at once.

---

## The daily loop

Three screens default to a **queue, not a report** — because the thing an
operator opens them to do is find the person waiting, not read a list of
everything that ever happened. Work them in this order; the first two have
someone's money in them.

| Order | Screen | Default filter | Why it's first |
|---|---|---|---|
| 1 | **Bookings** | Refunds due | Someone is owed money and hasn't got it |
| 2 | **Registrations** | Needs attention | A payment is late, or a cancellation is unanswered |
| 3 | **Reviews** | Waiting | Nothing appears on a profile until you read it |
| 4 | **Facilitators** | Needs review | Applications waiting on a decision |
| 5 | **Payouts** | — | Periodic, not daily |

If you only have ten minutes, do 1 and 2.

---

## Money: the rules that apply everywhere

Read these once. They explain most of the "why can't I just…" questions.

**Nothing in this system moves money.** Refunds and payouts are *recorded*
here and *sent by hand* in PayMongo. There is no refund button that moves
money, deliberately — a misfired click that moves real money is not a risk
worth taking at this volume.

**Therefore order matters, and it is always: move the money first, record it
second.** If you record first and the transfer then fails, the ledger says
someone was paid who wasn't, and nothing will ever tell you.

**A reference is required wherever you record a payment.** It is the proof the
money moved. Two admins can't both record the same refund — the write
re-asserts that it hasn't already been done.

**Not every session is worth what it says.** Three cases where the obvious
number is not the number:

- **Package sessions** — a six-session package is one payment from the client,
  but the facilitator earns each session's share *as that session is
  delivered*. A payout batch picks up the sessions held this period, not the
  whole block.
- **Facilitator-booked sessions** — worth **zero** in every money column, and
  never in a payout batch. Hilom collected nothing for them; the amount shown
  as "paid directly" is the facilitator's own note, not a liability.
- **Cancelling a session inside a package** returns the *credit* to the client,
  not money. There is nothing to refund.

**Partial refunds aren't modelled** for course orders (see the refund runbook).
Booking refunds *are* partial by nature — the tiered policy can owe half — and
that half is recorded on the booking for you to send.

---

## Facilitator applications

Full detail: the guide's *Admin journey*, sections 1–6. The procedure:

1. **Facilitators → Needs review → Review.** Read the application. Credentials
   and scope of practice being empty here is **normal** — the form is triage,
   and public profile copy is written by the facilitator after approval.
2. **Certificate**, if attached — the button mints a 5-minute signed URL. The
   file sits in a private bucket with no CDN, so this is the only way to read
   one. Don't bookmark the URL; it dies.
3. **Approve** or **Reject** (rejection is terminal, but they can re-apply).
4. **Fee**, if this facilitator isn't on the standard 15%. Do it *now* — fee
   changes only affect future bookings, so setting it after their first booking
   leaves that booking on the old rate for ever.
5. Wait for them to fill in their profile. **Publish** when the pre-publish
   checklist is satisfied (credentials, scope of practice, approach, at least
   one active service). The checklist is advisory, not a block.

**Three things that go wrong here:**

- **The email must match the address they sign in with.** For a direct add
  especially — get it wrong and their dashboard never links up, and the symptom
  is "I'm approved but I can't get in".
- **A newly approved facilitator must sign in again.** Cognito stamps group
  membership at token issue, so their existing session has no access.
- **Approve ≠ publish.** Approved people are invisible until you publish them.
  If someone says "I'm approved, why can't clients find me?", that's this.

---

## Bookings and booking refunds

**Bookings → Refunds due** is the queue. Each row shows the full split
(`price · Hilom fee · facilitator net`), who cancelled and why, and refund
state.

### Recording a refund

1. Refund in **PayMongo** first.
2. **Mark refund sent**, paste the reference.

Do not do these in the other order.

### Cancelling a session for someone

**Cancel & refund** (confirmed, future sessions only). Use it when neither party
can — an unresponsive facilitator, a fraudulent booking.

- Always a **full refund**, whatever the notice period. This is the platform
  calling off a session the client didn't choose to lose.
- Recorded as `cancelled_by_facilitator` (that's what the client experiences),
  with `cancelled_by = admin` on the row for whoever reads it later.
- Both parties are emailed.
- On a package session this returns the credit instead — there's no money to
  refund, and the client keeps their sessions.

### What the tiered policy means for you

Refund amounts are computed from **the facilitator's own thresholds on that
service**, snapshotted onto the booking when it was taken. So:

- Two clients cancelling with identical notice can be owed different amounts,
  if they booked different facilitators. That's correct, not a bug.
- Changing a facilitator's policy today never changes what an existing booking
  owes.
- If a client disputes the amount, the row is the answer — it carries the
  thresholds that were in force when they booked.

---

## Reviews

**Reviews → Waiting.** Nothing appears on a facilitator's profile until someone
here publishes it.

**Publish** / **Don't publish**. Both are reversible, the facilitator's average
follows either way, and nothing is ever deleted.

**What you are checking for:** abuse, contact details, and clinical or personal
disclosures the client may not have meant to make public.

**What you are not checking for:** whether the review is nice. A one-star review
of a session that went badly is exactly what the ratings are for. A five-star
average with the bad ones filtered out tells a prospective client nothing, and
the moment facilitators learn that happens, the whole feature is worthless.

Expect pushback on one point: **a client marked as a no-show can still review**.
They were charged and had an experience. Unfair is a reason to look; unflattering
is not.

---

## Payouts

Periodic, not daily. Facilitators are paid by manual bank transfer.

1. **Payouts → pick facilitator + month → Build batch.** Pulls every
   **delivered** session (`completed` or `no_show`) in that period not already
   in a batch. A no-show still earns — the facilitator held the time.
2. Enter PayMongo's **processing cost** for the batch by hand. It isn't on the
   webhook payload, so nothing can fill it in for you.
3. **Approve** the draft once the arithmetic looks right
   (`gross − Hilom fee − processing = net`).
4. Send the transfer from the bank, using the details shown on the card.
5. **Mark paid**, with the reference. The facilitator is emailed automatically —
   they don't have to notice a number changed on a screen.

**Void** releases a batch's sessions back into the unpaid pool so it can be
rebuilt. Use it for a mistaken batch; it's the only way back.

Batch states: `draft → approved → paid`, or `void`.

**Future `confirmed` sessions are never paid in advance**, and packages pay per
delivered session rather than on purchase — so a facilitator who just sold a
₱12,000 block will not see ₱12,000 in this period.

---

## Event registrations

**Registrations → Needs attention** — late payments and unanswered
cancellations. Same design as the bookings queue.

Every action that moves money asks for a confirmation and a reason, and both are
recorded. Refund amounts here follow the Participant Agreement §III tiers, and
the screen computes the assessment for you rather than leaving it to arithmetic
on the day.

The 31–60 day band produces a **credit**, not a refund. There is no redemption
ledger for credits yet — it is recorded in the notes and the audit trail and
told to the registrant by email, then arranged by hand. Don't assume the system
will remember it for you.

---

## Course orders and access

Unchanged, and documented separately:
[refund-runbook.md](refund-runbook.md).

The one-line version: **refund in PayMongo, then Revoke in Commerce.** Never the
reverse. Revoke only removes courses that order granted, and subtracts anything
another live order still pays for — so a buyer who owns Module 1 separately
keeps it when they refund the bundle.

---

## Finding a person

Two screens, and the difference matters:

- **People** — derived from Postgres. Everyone who has bought, booked,
  registered or enquired, merged into one row per person. This is the "have we
  dealt with them before?" screen.
- **Accounts** — the raw Cognito pool, including people who signed in once and
  never did anything. **Read-only** by design: Cognito is the system of record
  for identity, and disabling an account from here would be an identity change
  made in the wrong place.

If someone exists in Accounts but not People, they've never transacted. If they
exist in People but can't sign in, the address on their transactions doesn't
match the one they're signing in with.

---

## When something looks wrong, the truth lives here

| Question | Authoritative source |
|---|---|
| Did the money actually move? | PayMongo dashboard — never this panel |
| Is someone enrolled? | Moodle |
| Can they sign in / what groups? | Cognito |
| What was agreed at booking time? | The booking row's snapshots (price, split, refund thresholds) |
| What did we tell them? | The notification emails — every state change sends one |

The admin panel is a view over Postgres plus a set of instructions to a human.
When it disagrees with PayMongo, PayMongo is right about money and the panel is
right about intent.

---

## Never do these

- **Never record a refund or a payout before the money has actually moved.**
- **Never publish a review because it is flattering, or hold one because it is
  not.**
- **Never disable a Cognito account to "remove" someone** — they may hold other
  purchases, and identity is not the place to express a refund.
- **Never assume a facilitator-booked session owes anybody anything.** It is
  recorded at zero on purpose.
- **Never edit money columns directly in Supabase** to fix a discrepancy. Every
  amount is a snapshot of an agreement; changing one silently rewrites what
  someone was promised. Fix it through the panel, or record a compensating
  action with a reason.
