# Sept 20 Feedback — Implementation Plan

Scope taken from *[HILOM COLLECTIVE] To Fix/Add as of Sept 20*, less the items ruled
out in review: recurring event series, scholarship applications, coach-matching
percentages, client self-profiles, LMS course links on facilitator profiles, and the
"₱1 and above" price floor (already shipped as pay-what-you-want, `0047`).

Status: **all 7 phases built, 2026-09-21. Not deployed** — migrations 0048–0050 have
not been run and no stack has been deployed. See "Deploying this" at the foot of this
document.

| # | Phase | Schema | Size |
|---|---|---|---|
| 1 | Event poster is no longer cropped | — | hours |
| 2 | Facilitator profile picture upload | — | hours |
| 3 | Facilitator is notified of event sign-ups | — | small |
| 4 | Event attendees appear in the facilitator's clients | — | small |
| 5 | Facilitator-submitted events, admin-approved | `0048` | medium |
| 6 | Group classes with min/max joiners | `0049` | large |
| 7 | Reviews for events and classes | `0050` | medium |

---

## 1. Event poster is no longer cropped

**The bug.** A poster is portrait artwork with type on it. Three places crop it with
`object-fit: cover` against a fixed aspect ratio, so the top and bottom — usually the
title and the date — are cut off:

- [Events.tsx:17](../frontend/src/pages/Events.tsx:17) — `aspectRatio: '4/5'` on the list card
- [EventRegister.tsx:276](../frontend/src/pages/EventRegister.tsx:276) — the detail hero
- [EventRegister.tsx:353](../frontend/src/pages/EventRegister.tsx:353) — `3/4` gallery thumbnails

**The fix, and why it differs per surface.** The list card genuinely needs a uniform
crop — a grid of mixed aspect ratios is a worse page than a grid of tidy crops, and a
card is a teaser, not the artwork. So the card keeps `cover`. The *detail* page is
where someone goes to read the poster, and there nothing may be cut: the hero becomes
`object-fit: contain` inside a fixed-height box, backed by a blurred, scaled copy of
the same image so the letterbox bars are not dead grey. Gallery thumbnails keep their
crop, since clicking one opens it whole.

No schema, no backend. This is the one item on the list that is a defect rather than a
feature, so it goes first.

---

## 2. Facilitator profile picture upload

[ProfileTab.tsx:217](../frontend/src/pages/facilitator/ProfileTab.tsx:217) is a bare
text input for `photo_url`. A facilitator with a photo on their phone has no way to
get it into that box.

Everything needed already exists — `handlers/facilitator-uploads.ts` issues presigned
S3 PUTs for the portal. The work is a picker component next to the field that uploads,
then writes the returned URL into `draft.photo_url`; the text input stays for anyone
pasting a hosted URL.

Constraints worth enforcing client-side, because a headshot is rendered small and
round everywhere: reject over ~5 MB, reject non-image types, and centre-crop to a
square preview before upload so the facilitator sees what the directory card will
show rather than discovering it later.

---

## 3. Facilitator is notified of event sign-ups

`events.facilitator_id` (`0045`) already identifies the host account. Registration
confirmation email already goes out on payment. This phase adds the host as a
recipient of a *different*, host-shaped message: who registered, what they answered in
`registrant_details`, and the running seat count — not a copy of the attendee's
receipt.

Two things to get right:

- **It is a separate send, not a CC.** A CC leaks the host's address to the attendee
  and gives the host a message written in the second person about their own event.
- **It fires on `confirmed`, not on `pending_payment`.** The registration row exists
  from the moment a seat is claimed; mailing then would announce sign-ups that never
  pay. Same rule the attendee email already follows.

An event with no `facilitator_id` simply has no second recipient — no new failure mode.

---

## 4. Event attendees appear in the facilitator's clients

Today the clients list is derived from `bookings` grouped by `client_email`
([ClientsTab.tsx](../frontend/src/pages/facilitator/ClientsTab.tsx)); `facilitator_clients`
(`0033`) holds only the private `about` note. Someone who attended a facilitator's
event but never booked a 1:1 does not appear at all.

The list becomes a union: booking clients, plus confirmed `event_registrations` on
events where `facilitator_id` is this facilitator. Keyed on email, the same key
`facilitator_clients.about` already uses, so notes continue to work untouched.

**Each entry must carry its source.** A 1:1 client and a workshop attendee are not the
same relationship, and a facilitator who messages all of them as if they were will get
it wrong. The card shows which — "2 sessions · 1 event" — and the detail panel lists
both histories. No migration: this is a second query and a merge in
`facilitator-portal.ts`.

---

## 5. Facilitator-submitted events, admin-approved

A facilitator creates an event in their portal; **nothing is publicly visible until a
Hilom admin approves it.**

### Why a new column and not a new `page_status` value

`events.status` is `public.page_status` (`draft`/`published`), shared with pages and
posts (`0006`). Adding `submitted`/`rejected` to that enum would put event-moderation
states into the page editor's vocabulary, where they mean nothing. So moderation gets
its own column:

```sql
-- 0048_event_submissions.sql
create type public.event_review_status as enum
  ('draft', 'submitted', 'approved', 'rejected');

alter table public.events
  add column if not exists review_status public.event_review_status
    not null default 'approved',
  add column if not exists submitted_by uuid references public.facilitators(id)
    on delete set null,
  add column if not exists submitted_at  timestamptz,
  add column if not exists reviewed_at   timestamptz,
  add column if not exists review_note   text;
```

`default 'approved'` is deliberate: every event that exists today was created by an
admin and must stay live through the migration. Only rows a facilitator submits start
at `draft`.

**Invisibility is inherited, not re-implemented.** The public RLS policy on `events`
is already `using (status = 'published')` (`0007:72`). A submitted event is
`status = 'draft'`, so it is invisible to anon and authenticated readers with no new
policy at all. Approval is the act that sets `status = 'published'` alongside
`review_status = 'approved'`. The backend must never publish a row whose
`review_status` is not `approved` — one guard, in the admin handler.

### Surfaces

- **Portal:** an Events tab for creating and editing an event while it is `draft` or
  `rejected`, read-only once `submitted`, and locked to safe fields (join link,
  instructions) once approved. A facilitator editing the title of a published,
  already-sold event would change what attendees bought.
- **Admin:** the pending queue joins the existing `EventsTab`, with approve / reject +
  note. Reject writes `review_note`, which is what the portal shows back — a rejection
  with no reason generates a support email every time.
- **Ticketing:** a facilitator-submitted event may propose payment plans, but the
  plans are part of what the admin approves. Money terms are not editable after
  approval by anyone but an admin.

---

## 6. Group classes with min/max joiners

The largest item. A facilitator offers a session many people join at one time —
online or in person — with a minimum and a maximum number of joiners.

### The constraint that decides the design

`bookings` carries an exclusion constraint over `(facilitator_id, tstzrange(starts_at,
ends_at))` ([0012:125](../db/migrations/0012_bookings.sql:125)). It is what makes
double-booking impossible, and it is load-bearing. Twelve people joining one class at
10:00 would be twelve overlapping `bookings` rows for one facilitator — the constraint
rejects them, correctly, because that is exactly the bug it exists to prevent.

Weakening it to allow group rows would mean every future 1:1 write depends on getting
a predicate right. So group classes do **not** become bookings.

### What they become instead

A class is structurally an event: one instant, a capacity, a seat, a roster, many
payers. `event_registrations` already solves seat allocation under concurrency via
`claim_event_seat()` (`0013`). Two new tables mirror that shape:

```sql
-- 0049_group_classes.sql
create table public.facilitator_classes (       -- the offering
  id, facilitator_id, title, description,
  delivery_mode public.delivery_mode,           -- reuses 0011's enum
  location text,                                -- for in_person
  meeting_url text,                             -- withheld from public reads, per 0045
  duration_minutes int,
  price_centavos int, currency text,
  min_joiners int not null default 1,
  max_joiners int not null check (max_joiners >= min_joiners),
  is_active boolean, ...
);

create table public.facilitator_class_sessions ( -- one scheduled occurrence
  id, class_id, starts_at, ends_at,
  status public.class_session_status,            -- scheduled | cancelled | completed
  seats_taken int not null default 0, ...
);

create table public.class_registrations (        -- who is in it
  id, session_id, client_email, client_cognito_sub, client_name,
  status public.registration_status,             -- reuses 0013's enum
  seat_no int not null check (seat_no > 0),
  price_centavos, platform_fee_centavos, facilitator_net_centavos, currency,
  paymongo_payment_id, paymongo_session_id, ...
);
```

Money snapshots and the fee split are copied from `bookings` verbatim so the class
feeds the existing `facilitator_payouts` ledger with no new payout code path. The
**record-the-money-before-fulfilling** rule applies unchanged: the registration row is
written before the seat is confirmed.

### The minimum does not cancel anything

Decided in review: **a class runs even if it does not reach `min_joiners`.** The
minimum is advisory — shown to the facilitator on their session list, and optionally
on the public page as "runs with 3+". Nothing automatic reads it.

This is worth stating plainly because the alternative was expensive. An auto-cancel at
minimum would have to refund every paid seat, which means driving PayMongo refunds
from a scheduled job and reconciling partial failures — the whole of the `0027` refund
machinery, on a trigger nobody watches. Not building that is most of why this phase is
merely large rather than enormous.

### The one place group classes must touch the 1:1 system

A facilitator teaching a class at 10:00 must not be bookable for a 1:1 at 10:00. Slot
generation ([lib/slots.ts](../backend/src/lib/slots.ts)) already subtracts
`facilitator_blackouts`; it must also subtract `facilitator_class_sessions` that are
`scheduled`. That is the single integration point, and it is one more array passed
into an existing pure function with existing tests.

---

## 7. Reviews for events and classes

Reviews are built end to end — submission from
[account/BookingsTab.tsx](../frontend/src/pages/account/BookingsTab.tsx), moderation in
[admin/ReviewsTab.tsx](../frontend/src/pages/admin/ReviewsTab.tsx), aggregates
maintained by trigger (`0036`), ratings on directory cards. They just cannot attach to
anything but a 1:1 booking:

```
booking_id uuid not null unique references public.bookings(id)
```

### Making the subject polymorphic

```sql
-- 0050_reviews_for_events_and_classes.sql
alter table public.facilitator_reviews
  alter column booking_id drop not null,
  add column if not exists event_registration_id uuid
    references public.event_registrations(id) on delete cascade,
  add column if not exists class_registration_id uuid
    references public.class_registrations(id) on delete cascade,
  add constraint facilitator_reviews_one_subject check (
    (booking_id is not null)::int
  + (event_registration_id is not null)::int
  + (class_registration_id is not null)::int = 1
  );
```

The existing `unique` on `booking_id` is dropped and replaced by three partial unique
indexes — one review per subject, with nulls not colliding.

`facilitator_id` stays a required column, and the aggregate trigger is untouched: a
review of an event and a review of a session both land on the same facilitator's
rating. That is the intent — the rating is of the person, not of the format.

### The question this raises, and the default taken

An event with no `facilitator_id` has no one to attribute a rating to. **Default: only
events hosted by a marketplace facilitator can be reviewed.** A Hilom-run retreat
collects no rating, because there is no profile for it to appear on.

If Hilom wants testimonials on its own events, that is a different feature — testimonial
copy for the event page, not a rating feeding a facilitator's average — and it should
be built as one rather than by inventing a house facilitator row.

### Eligibility and prompting

A review may be left once the subject is in the past and was actually attended:
booking `completed`, registration `confirmed` and the event or session past. The
prompt appears in the account area alongside the existing one, and the moderation
queue gains a column for what the review is *of*, since an admin reading "the room was
freezing" needs to know it is about a venue and not a Zoom call.

---

## Open questions

1. **Class cancellation by the facilitator.** Not auto-cancellation at minimum — that
   is settled — but a facilitator manually cancelling a scheduled session. Full refund
   to every registrant regardless of notice, or does the `0027` refund-tier policy
   apply? Recommendation: full refund. The client did nothing wrong.
2. **Class rescheduling.** Same question, less urgent. Can be deferred past phase 6 by
   making the answer "cancel and re-open", at the cost of everyone re-registering.
3. **Who receives class money if a facilitator is removed.** `bookings.facilitator_id`
   is `on delete restrict` for this reason; `facilitator_classes` should match.


---

## Deploying this

Nothing here is live. The order matters — the migrations add columns and a constraint
that the new handler code reads, so a Lambda deployed first would query columns that do
not exist yet.

1. **Migrations, in order**, against the Supabase pooler:
   `0048_event_submissions.sql`, `0049_group_classes.sql`,
   `0050_reviews_for_events_and_classes.sql`.

   `0048` is the only one that touches an existing table's data path: it adds
   `review_status` defaulting to `'approved'` so every event that exists today stays
   publishable, and adds a CHECK that refuses to publish an unapproved row. If any live
   event is somehow `published` with a non-approved review status, that `ALTER` fails —
   it cannot, given the default, but it is the one statement worth watching.

2. **CDK deploy.** Both stacks changed: `HilomCmsStack` gained
   `/admin/events/{eventId}/review`, and `HilomMarketplaceStack` gained the classes
   Lambda plus the class, proposal and review routes.

3. **Frontend** deploys by pushing to `main` (Amplify auto-build).

### What to check first, once it is up

- An existing event still publishes and unpublishes from the admin screen. That is the
  0048 constraint's blast radius.
- A 1:1 slot list is unchanged for a facilitator with no classes. `scheduling.ts` gained
  a fourth query; an empty result must behave exactly as before.
- A booking review still saves. The panel moved to a shared component and the unique
  constraint behind it was replaced by a partial index.
