# Refund runbook (Phase 8)

Refunds are **manual by design** — a locked project decision. Nothing about a
PayMongo refund automatically revokes course access, and nothing in the admin
panel moves money. The two halves are separate on purpose, and both must be done.

## The two steps, in order

### 1. Refund the money — PayMongo dashboard 🔧

Find the payment and issue the refund there. The admin panel deliberately has no
refund button: automating refunds was explicitly out of scope, and a
misfired click that moves real money is not a risk worth taking for the volume
involved.

### 2. Revoke the access — admin panel

Go to `/admin` → find the order → **Revoke** → confirm.

That single action:
- unenrols the buyer from the courses **that order** granted, via Moodle's
  `enrol_manual_unenrol_users`,
- sets the order's status to `refunded`.

Order matters: refund first, revoke second. If you revoke first and the refund
then fails, the customer has lost access while still being charged.

## What revoke deliberately does NOT do

**It does not delete the buyer's Moodle or Cognito account.** They may hold other
purchases, and destroying an identity over a single refund is unrecoverable. Only
the course enrolments tied to that one order are removed.

**It does not strip access another live order still pays for.** This is the
subtle case worth understanding:

> A buyer owns *Module 1* on its own, and later buys *The Breakthrough Bundle*
> (which also grants Module 1). They refund the bundle. Naively unenrolling
> everything the bundle granted would also remove Module 1 — which they still
> paid for separately.

Revoke therefore subtracts any course still granted by that buyer's other orders
that are `fulfilled` and not `refunded`. The API response reports both lists:

```json
{
  "status": "refunded",
  "revokedCourseIds": [15, 16],
  "retainedCourseIds": [10]
}
```

and the admin panel surfaces the retained ones ("Kept 10 — still covered by
another order"), so it is visible rather than silent.

Verified against production: with both orders held, revoking the bundle removed
courses 15 and 16 and left course 10 intact; revoking the Module 1 order then
removed course 10.

## Repeat clicks are safe

Revoking an already-refunded order returns `already_refunded` and changes
nothing — no duplicate unenrol calls, no error.

## API

```
POST /admin/revoke-access/{orderId}
x-admin-key: <from Secrets Manager: hilom/admin-api-key>
```

Returns 401 without the key, 404 for an unknown order.

## Partial refunds

Not supported. An order is refunded in full or not at all — the schema has a
single `refunded` status, not a partial amount. A part-refund would need to be
handled in PayMongo only, leaving access in place and the order untouched.
