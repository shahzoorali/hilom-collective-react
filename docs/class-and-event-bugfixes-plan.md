# Class & Event Bug Fixes — Implementation Plan

Four facilitator reports, checked against the live site, the API and the database
before writing this. Two are confirmed bugs in last week's work, one is a fair
feature request, one report doesn't reproduce but uncovered a real bug underneath it.

Status: **planned, nothing built.** Ordered by severity — the two things that are
flatly broken first, then the one that lies to a facilitator on screen, then the
feature request. Build and deploy one at a time; each is independently shippable.

| # | Fix | Kind | Size |
|---|---|---|---|
| 1 | Event submit is broken for everyone | 1-line backend bug + frontend ordering | small |
| 2 | Class join sends no email, but claims it does | new email + copy fix | small |
| 3 | A class session can be priced wrong with no way to see or fix it | data bug + UI | medium |
| 4 | Pay-what-you-want for classes | new feature, reuses events' plumbing | medium |

---

## 1. Event submit is broken for everyone

### What's actually happening

Confirmed against Crizy Austria's "TEST - JOURNALING" event: it sits in the
database as `review_status = 'draft'` with `submitted_at` empty. The save worked.
The submit silently did nothing.

Two independent bugs, both mine, and either alone would explain what she saw.

**Bug A — the submit check reads a column it never asked for.**

[`submitProposal`](../backend/src/handlers/facilitator-portal.ts) refuses to submit
without a title, a date and a description:

```ts
const missing = [
  !existing.title && 'a title',
  !existing.starts_at && 'a date',
  !existing.description && 'a description',   // <-- always true
].filter(...)
```

`existing` comes from `ownedEvent`, which selects `HOSTED_EVENT_COLUMNS`. That
constant does not include `description`:

```ts
const HOSTED_EVENT_COLUMNS =
  'id, title, subtitle, excerpt, image_url, image_alt, location, starts_at, ends_at, status, ' +
  'ticketing_enabled, capacity, currency, venue_details, format, join_url, join_instructions, ' +
  'review_status, submitted_at, reviewed_at, review_note, submitted_by';
```

So `existing.description` is `undefined` for every event, on every submit
attempt, regardless of what was actually typed and saved. Crizy's event has a
description in the database. The check never saw it. **Submit has never worked
for anyone**, not just her — nobody has been able to move an event past `draft`
since 0048 shipped.

**Bug B — the frontend hides the resulting error.**

`saveAndSubmit()` in [`EventsTab.tsx`](../frontend/src/pages/facilitator/EventsTab.tsx)
calls `save()` first, and `save()` calls `onDone(saved)` on success. `onDone` is
wired in the parent to `setComposing(null)`, which unmounts the whole form —
before `saveAndSubmit` goes on to call `submitMyHostedEvent`. When that second
call then fails with Bug A's 400, `setError(...)` fires against a component that
no longer exists. Nothing is shown. This is why it read as a blank page rather
than as a message she could act on.

### The fix

**Backend:** add `description` to `HOSTED_EVENT_COLUMNS`. One line. Re-verify the
existing tests still pass — none currently exercise this path, which is itself
worth noting for phase-4-style follow-up.

**Frontend:** don't unmount on `save()` inside `saveAndSubmit()`. The cleanest
fix is to give `save()` an option to skip calling `onDone`, and have
`saveAndSubmit` use it — the form stays mounted through both round-trips, and
whichever one fails, the error renders where the facilitator is looking.

```ts
async function save(opts?: { silent?: boolean }): Promise<MyHostedEvent | null> {
  ...
  if (!opts?.silent) onDone(saved);
  return saved;
}

async function saveAndSubmit() {
  const saved = await save({ silent: true });
  if (!saved) return;
  ...
  onDone(await submitMyHostedEvent(saved.id));   // only unmounts on final success
}
```

### Verify

Re-run Crizy's exact case after deploy: open "TEST - JOURNALING", press **Send to
Hilom**, confirm it moves to `submitted` and appears in the admin review queue.
Then deliberately clear the description on a fresh draft and confirm the error
now renders inline instead of vanishing.

---

## 2. Class join sends no email, but the screen claims it does

### What's actually happening

There is no confirmation email for joining a class — paid or free. I wrote
`sendClassCancelled` for the one case (cancellation) and never wrote the
sibling for the far more common one (joining). Every one of Prem's three
September confirmations sent nothing.

Worse than a silent gap: [`ClassJoin.tsx`](../frontend/src/pages/ClassJoin.tsx)
tells the person joining, in the confirmation screen itself:

> "The joining details are on your account, and we have emailed them to you."

That sentence is false today. It should not ship again until it's true.

### The fix

**A `sendClassJoined` email**, mirroring the shape of `sendClassCancelled`:
who, what class, when, and — this is the part that actually matters for a paid
class — the joining link if the class is online and the seat is confirmed.
Free classes confirm immediately with no payment step, so this is the only
email a free joiner will ever get; it needs to carry everything a confirmation
normally would, not a stub.

Sent from the same place `sendClassCancelled` is sent from: the confirmation
path in `classes.ts` (free join) and the PayMongo webhook's `class` branch
(paid join), matching how bookings and event registrations already split
confirmation between "confirmed instantly" and "confirmed on payment."

**The copy fix ships in the same deploy**, not before it — until the email
exists, the honest sentence is something like "Your place is confirmed. Find
the joining details any time in your account," with the emailed claim removed.

### Verify

Join a free class end-to-end as a test client and confirm the email arrives
with a working joining link. Then join a paid one through checkout and confirm
the same, sent from the webhook path rather than the immediate-confirm path.

---

## 3. A class session can be priced wrong, invisibly

### What's actually happening

Not the reported symptom (classes are showing correctly on both profiles —
checked live), but real, and worse: **the public page can advertise a price
the site will not actually charge.**

Prem's "Online HIIT Pilates Express" class is priced at ₱15. Every one of his
scheduled dates carries `price_centavos = 0`. The class page shows ₱15 up top
and free dates underneath — and joining any of them is genuinely free, because
`claim_class_seat` charges whatever the *session* row says, not the class.

This is by design and the design is correct on its own terms: a session
snapshots the class's price at the moment it's scheduled, precisely so that
editing the class later can't move the ground under a date people already paid
for (see 0049's header comment). What's missing is everything downstream of
that decision:

* the facilitator's own session list doesn't show a session's price at all —
  [`ClassesTab.tsx`](../frontend/src/pages/facilitator/ClassesTab.tsx) renders
  the class's price on every row, never the session's;
* there is no way to fix a session that was scheduled before the class was
  priced correctly;
* the public class card shows the class price beside dates that may not
  charge it, with nothing to say they differ.

Prem priced his class after scheduling several dates against it, and nothing
in the product told him — or tells a client — that the numbers had come apart.

### The fix

**Show the real number, everywhere it's read.**

* `ClassesTab.tsx`'s date list: show each session's own `price_centavos`
  alongside the date, not the class's. If it differs from the class's current
  price, say so — "₱0 (class is now ₱15)" — rather than leaving a silent
  mismatch for the facilitator to notice or not.
* The public class card ([`FacilitatorProfileView.tsx`](../frontend/src/components/FacilitatorProfileView.tsx)
  and [`ClassJoin.tsx`](../frontend/src/pages/ClassJoin.tsx)): price the date
  from the session, which the API already returns — a display fix, not a data
  fix, since `seatsTaken`/`seatsLeft` already come from the session and the
  price should too.

**Let a mispriced session be corrected, but only while it's safe to.**

A new endpoint (or an extension of the existing session update path) to change
one scheduled session's price — allowed only while `seatsTaken = 0`. The
moment someone has a confirmed seat, the snapshot rule has to hold: that
person's price does not move underneath them. This mirrors the existing rule
that a class's *description* is only editable while a proposal is still a
draft — price on a session follows the same "editable until someone has acted
on it" shape already used elsewhere in this codebase.

### Open question for you

Should scheduling a **new** date always pull the class's *current* price
(today's behaviour — the bug is only that nobody can see or fix a stale one),
or should the facilitator be able to override the price per-date at scheduling
time (useful for an early-bird date, but a bigger UI change)? The fix above
assumes the former; flag if you want the latter instead.

### Verify

Reproduce with Prem's exact class: confirm the facilitator's session list now
shows ₱0 next to the September dates and ₱15 next to any newly scheduled one,
correct the stale ones, and confirm the public page updates to match.

---

## 4. Pay-what-you-want for classes

### What's being asked

Events already have this — Prem's "Pay What Feels Right" plan collected ₱1 from
five people over one weekend, so the pattern is proven and in active use. The
request is to offer the same on a group class.

### Why it isn't a small copy of the events version

Events price at the *plan* level, chosen once per event and shared by every
registration against it (`event_payment_plans`). A class prices at two levels —
the class's list price and, per this session's fix #3, the session's snapshot
of it — and pay-what-you-want has to slot into both without reopening the
snapshot problem this plan is already fixing.

### Proposed shape

Add a `pricing_mode` to `facilitator_classes`: `'fixed'` (today's only mode) or
`'donation'`. In donation mode, `price_centavos` becomes a *suggested* amount
rather than the charge, and `claim_class_seat` accepts a payer-supplied amount
within `[min_centavos, no upper bound]` — reusing the validation
`event_payment_plans` already has for this, rather than inventing a second
implementation of "pay what you want" with its own edge cases.

**Learn from what's already been observed in production first.** Section
"Money in — 19–22 Sept" from the earlier transaction summary showed Prem's
event PWYW plan anchoring hard at its ₱1 floor — most payments landed at the
minimum, because the minimum and the suggested amount were the same number.
Before shipping this on classes, decide whether the class version enforces
`suggested > min` (nudging the anchor up) or leaves that entirely to the
facilitator. Cheap to build either way; expensive to leave undecided and watch
the same pattern repeat.

### Sequencing

This depends on fix #3 landing first — a session's price is about to become
something the UI actively shows and lets you correct, and donation mode should
be built against that corrected picture rather than against the version where
a stale price silently disagrees with the class.

---

## Deploying this

1. Fix #1 (backend column + frontend ordering) and fix #2 (email) can ship
   together — neither touches the database.
2. Fix #3 needs a small migration only if the price-correction endpoint needs
   a new guard column; otherwise it's existing columns read and written more
   carefully. Confirm during implementation.
3. Fix #4 is new work, sequenced after #3, and needs the open question above
   answered before it starts.

None of these need coordinated downtime — each is additive or a display
correction, and #1–#3 are pure bug fixes with no new surface area for anyone
who isn't already hitting the bug.
