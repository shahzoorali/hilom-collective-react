# Admin Panel — Structure and Gaps

A review of `/admin` as it stands, and a phased plan to fix what is missing.
Written after the Sept 20 feature work, which added two screens' worth of
functionality and exposed how little the panel does to tell an operator what
needs them.

Status: **all six phases built and deployed, 2026-09-23.** Phases shipped one
at a time, each leaving the panel working, same as
[the main plan](hilom-development-plan.md). Auditing phases 1-4 after the fact
also surfaced and fixed a pre-existing bug: voiding a facilitator payout
released its 1:1 bookings back to the unpaid pool but not its group-class
seats, so a voided batch's class earnings could never be paid.

| # | Phase | Kind | Size |
|---|---|---|---|
| 1 | A dashboard, and make it the landing page | new screen + 1 endpoint | medium |
| 2 | People misses group-class attendees | migration | hours |
| 3 | The audit log has no screen | frontend only | small |
| 4 | Split Commerce into Orders and Catalogue | refactor | medium |
| 5 | Group classes have no admin screen | new screen | medium |
| 6 | Regroup the menu, add a Settings home | IA + redirects | small |

---

## What the panel looks like today

Three groups, seventeen items:

- **Content** — Pages, Posts, Events, Help Centre, Media, Menus, Footer
- **Engagement** — Forms, Bookings, Registrations, Facilitators, Reviews, People, Accounts
- **Commerce** — Commerce, Promo Codes, Payouts

Most of the individual screens are good. `PeopleTab` in particular does a hard
thing well — it answers "have we dealt with this person before?" from a
database view rather than by making an operator open four tabs and match email
addresses by eye — and `BookingsTab` already defaults its filter to *Refunds
due*, which is precisely the instinct the rest of the panel lacks.

The problems are almost all at the level above the screens: what an operator
sees first, what has no screen at all, and what is filed somewhere nobody would
look.

---

## 1. A dashboard, and make it the landing page

### The problem

`/admin` redirects to the CMS page list. The first thing an operator sees on
opening the admin panel is a list of web pages.

Meanwhile there are at least seven queues of work, each invisible until
somebody clicks into the right tab and, in several cases, picks the right
filter:

| Queue | Where it lives now |
|---|---|
| Facilitator applications awaiting review | Facilitators, filtered |
| Reviews awaiting moderation | Reviews (defaults to pending — good) |
| Event proposals awaiting approval | Events, behind a status dropdown option |
| Class refunds owed | a panel inside Payouts |
| Booking refunds owed | Bookings (defaults to *Refunds due* — good) |
| Overdue registration instalments | Registrations, filtered |
| Orders paid but not fulfilled | Commerce, behind a "stuck" checkbox |

Two of those seven default to the thing that needs doing. The rest are
discoverable only if you already know they exist. The event proposal queue is
the worst case and it is the newest: it is an option inside a status filter,
which nobody will find by accident.

The cost is not theoretical. A facilitator's event proposal, a client's refund
and a stuck enrollment all sit silently until somebody happens to look, and the
help centre now promises clients a class refund "within a few working days".

### What to build

A **Dashboard** screen, registered first in the menu and set as the index
route, showing each queue as a count with a link straight to the filtered view
that works it. Zero counts render as muted rather than hidden — an operator
should be able to trust that a quiet dashboard means quiet, not broken.

Plus a short "last 7 days" line: money in, split by source. That number is
currently obtainable only by querying the database by hand.

### One new endpoint, not seven reads

`GET /admin/overview`, returning counts only.

The tempting alternative is to call the seven existing list endpoints from the
browser and count the rows. It is wrong: those endpoints return **full rows** —
`/admin/bookings` returns every booking, `/admin/registrations` every
registration with its charges — and the landing page would become the slowest
and most expensive screen in the panel, fetching megabytes to render seven
integers.

The endpoint should use count-only queries (`select('id', { count: 'exact',
head: true })`), which return a number and no rows. Seven of those in one
`Promise.all` is a handful of milliseconds.

**Each count must be paired with the filter that produces it**, in one place.
A dashboard saying "3 refunds owed" that links to a screen showing four is
worse than no dashboard, and the way that happens is two definitions of "owed"
drifting apart. The overview handler should import the same predicates the list
endpoints use rather than restating them.

### Deliberately not in scope

No charts, and no "revenue over time". The panel is a tool for doing work, not
a reporting suite, and a sparkline nobody acts on costs the same to maintain as
one somebody does. The seven-day figure earns its place because it answers
"did anything happen this week", which is the question an operator actually
opens the panel with.

---

## 2. People misses group-class attendees

### The problem

`people_directory` (0022) is the view behind the People screen, and the screen
describes itself as every person the platform knows. It merges five sources:
orders, event registrations, registration charges, bookings and form
submissions.

It does not know about `class_registrations`, because that table did not exist
when the view was written and **0049 did not extend it**. Someone whose only
contact with Hilom is a group class is absent from the one screen built to
prove nobody gets lost between tables.

This is a defect introduced by the group-class work, not a pre-existing gap.

### The fix

A migration that rebuilds the view with a sixth arm for class registrations,
matching the shape of the existing five: email, name, first-seen, last-seen and
a source tag.

Worth doing carefully rather than quickly. The view is `union all` across
sources keyed on lower(email), and the screen's value comes entirely from it
being complete — a half-added sixth source that double-counts somebody who both
booked and attended a class is worse than the current honest omission.

---

## 3. The audit log has no screen

### The problem

Every sensitive action writes to `admin_audit_log`: publishing and
unpublishing, refunds, cancellations, price overrides, waived charges,
facilitator approvals, and now event approvals and rejections. The table
records who did it, which credential they used (`shared_key`, `cognito` or
`system`), their IP, the before and after, and any note.

`GET /admin/audit-log` is implemented, with filters for `eventId`, `targetId`,
a `money=1` view and a `limit`.

`adminListAuditLog` exists in the frontend client library.

**No component calls it.** The only audit visible anywhere is the fragment
rendered inline at the bottom of a single registration.

So the panel records accountability data that cannot be read. "Who unpublished
that event, and when?" has an exact answer sitting in a table with no door.

### What to build

An **Audit Log** screen: a reverse-chronological table of actor, action,
target, amount where there is one, and note, with the filters the endpoint
already supports.

The backend needs two small additions for the screen to be useful, and neither
exists today: a filter on `action`, and a date range. Both are one line each on
the existing query builder.

### Why the actor column needs care

`actor_source` is load-bearing and the screen must show it. A `shared_key`
actor label is **a name somebody typed into a box** — an attestation, not an
identity. A `cognito` label is a verified email. Rendering both as plain text
in an "Actor" column invites an operator to treat a self-declared name as
proof, which is exactly the misreading the column was added to prevent.

Show the source as a badge beside the name, and say what it means in a line
above the table.

---

## 4. Split Commerce into Orders and Catalogue

### The problem

There is a nav **group** called Commerce containing an **item** called
Commerce. That item is 645 lines doing three unrelated jobs:

1. **Course sync** — pulling courses from the LMS. A maintenance action run
   occasionally, not a daily screen.
2. **Products and pricing** — what is for sale and for how much.
3. **The order ledger** — every course purchase, with retry and revoke.

The third is the money record and has no screen of its own. Finding an order
means opening a tab named after its group and scrolling past a sync button and
a product list.

### The split

- **Orders** — the ledger, filterable, with the stuck-order view promoted from
  a checkbox to a real filter beside the others (the pattern `BookingsTab`
  already uses well).
- **Products & Courses** — the catalogue, with course sync as an action on that
  screen, where it belongs: sync exists to keep the catalogue in step.

This is a refactor, so the risk is behavioural regression rather than new bugs.
The retry and revoke actions carry real consequences — one re-runs an
enrollment, the other removes somebody's access — and both should move
unchanged rather than be reimplemented.

---

## 5. Group classes have no admin screen

### The problem

A facilitator can create a class, schedule dates, see who has joined and cancel
a date. An admin can do **none** of those. The only class-shaped thing in the
panel is the refund queue added inside Payouts.

That asymmetry matters the moment something goes wrong. If a facilitator stops
responding a week before a class, there is no lever: no way to see who is
booked, no way to cancel it, no way to message the room.

It also breaks a pattern the panel holds everywhere else — every other thing a
facilitator manages (bookings, event rosters, their profile) has an admin view
over the top of it.

### What to build

A **Classes** screen listing classes and their scheduled dates with live seat
counts, opening into a roster. Cancel-a-date from admin, using the same path
the facilitator's cancel uses so the refund records and the attendee emails are
identical whoever pressed the button.

Reuse rather than rebuild: the roster shape already exists for events, and the
cancellation logic already exists in the facilitator portal. An admin
cancellation that recorded refunds differently from a facilitator cancellation
would be a second definition of what a client is owed.

---

## 6. Regroup the menu, add a Settings home

### The problems, which are small individually

- **Engagement** is a grab-bag: people (People, Accounts, Facilitators),
  transactions (Bookings, Registrations), and content-ish things (Forms,
  Reviews) in one group of seven.
- **Menus, Footer and Media** are configuration filed under Content.
- `site_settings` is designed as a general key/value store for site-wide
  configuration and currently holds exactly one key, `footer` — reachable only
  by opening the Footer screen. The day a second setting exists (a contact
  address, an analytics id, a maintenance flag) there is nowhere for it to go.
- **Reviews** and the new **event proposal queue** are both moderation queues
  and live nowhere near each other.

### Proposed structure

| Group | Items |
|---|---|
| **Overview** | Dashboard |
| **Content** | Pages, Posts, Events, Help Centre, Media |
| **People** | People, Accounts, Facilitators, Forms |
| **Commerce** | Orders, Products & Courses, Bookings, Registrations, Classes, Promo Codes, Payouts |
| **System** | Settings, Audit Log |

Settings absorbs Menus and Footer as sections, and becomes the home for the
next site-wide setting.

### Do this once, and keep the old URLs working

Every path change breaks a bookmark, and admins bookmark deeply — `/admin/commerce`
is somebody's pinned tab. Old paths should redirect to new ones rather than
404, and the redirects should stay. This is also why the regroup is last: doing
it before the screens settle means doing it twice.

---

## Open questions

1. **Who is the dashboard for?** If one person runs this, the seven queues are
   right. If it is a team with roles, the dashboard should eventually filter to
   *your* work — which is a bigger question about whether admin accounts have
   roles at all, and they currently do not.
2. **Is the shared admin key still the main way in?** The audit log's actor
   distinction exists because of it. A screen making that visible may make the
   case for retiring it in favour of Cognito admin accounts, where every action
   carries a verified identity.
3. **Should the dashboard own alerting?** Counts on a screen still require
   somebody to open the screen. A weekly digest email — "3 refunds owed, oldest
   9 days" — reaches an operator who has not logged in, which is the case that
   actually goes wrong. Out of scope here, worth deciding.
