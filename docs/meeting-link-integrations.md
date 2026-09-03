# Meeting links: Google Meet and Zoom

Scope for replacing the manual "Meeting link" field on a service with a
provider picker — **Manual · Google Meet · Zoom** — where the two integrated
options generate a real link from the facilitator's **own** account.

Decided constraints:

- **Bring your own account.** Zoom is offered only to facilitators who have a
  Zoom account; Google Meet only to those with a Google account. The UI has to
  say so before they pick.
- **Hilom owns no meeting account.** No Hilom Zoom plan, no Hilom Workspace
  tenant, no meetings hosted under a Hilom identity. The facilitator is the
  host and the meeting lives in their account.
- **Manual stays.** It is the fallback for everyone who has neither, and the
  safety net when an integration fails.

---

## The headline: these two are not equally hard

| | Google Meet | Zoom |
|---|---|---|
| Can external facilitators connect without app review? | **Yes** — up to 100 users in Testing mode | **No** |
| Review needed to launch | None at your size | **Marketplace review, required** |
| Cost to Hilom | £0 | £0 |
| Meeting has a start time? | No — a space is a persistent room | Yes (unless we use a no-fixed-time recurring meeting) |
| Reschedule/cancel sync needed? | No | Yes |

**Google Meet can ship immediately. Zoom is gated on Zoom's review queue.**

That is the opposite of what you would guess, and it is the single most
important fact in this document.

### Why Google is now the easy one

The instinct is to reach for the Calendar API, which is what makes this look
expensive — calendar access is a *sensitive* scope and drags in verification.
We do not need it. The Meet REST API has a dedicated endpoint:

```
POST https://meet.googleapis.com/v2/spaces
scope: https://www.googleapis.com/auth/meetings.space.created
```

That scope is **principal-scoped**: it grants access *only to spaces the app
itself created*. It cannot read their calendar, their existing meetings, their
contacts, or anything else. It is close to the narrowest scope Google offers,
and it is exactly "give me a Meet link, nothing more".

Separately: the **CASA security assessment** — the expensive, slow one — applies
to **restricted** scopes (Gmail, Drive-class). It does not apply here.

And while the OAuth consent screen is in **Testing**, up to 100 manually-added
users can connect with no verification at all. Hilom is nowhere near 100
facilitators. Verification becomes a launch task when the roster grows, not a
blocker now.

### Why Zoom is the gated one

An unpublished Zoom OAuth app can only be authorised by users **inside the
developer's own Zoom account**. An external facilitator trying to connect gets:

> Unable to install this app without the developer's account.

There is no small-scale escape hatch equivalent to Google's Testing mode. To
let any facilitator connect, the app must be **published to the Zoom App
Marketplace**, which requires passing Zoom's quality and security review:
privacy policy, terms of use, support contact, security questionnaire,
functional demo. Budget weeks of back-and-forth, not days.

---

## What Hilom has to provide

### Google (do this first)

1. A Google Cloud project (free).
2. Enable the **Google Meet API**.
3. An **OAuth 2.0 Client ID** (Web application), redirect URI
   `https://api.hilomcollective.com/facilitator/integrations/google/callback`.
4. Consent screen: External, publishing status **Testing**, with each
   facilitator's Google address added as a test user. Requires the privacy
   policy URL — `/privacy-policy` now exists.
5. Client id + secret into Secrets Manager as `hilom/google-meet`.

No payment, no review, no assessment.

### Zoom (start the clock early, ship later)

1. A Zoom account to own the app (developer account is free).
2. Create a **user-managed OAuth app** (not Server-to-Server — that only reaches
   your own account, which is the thing we are not doing).
3. Scopes: `meeting:write:meeting`, `meeting:update:meeting`,
   `meeting:delete:meeting`, `user:read:user`.
4. Redirect URI `https://api.hilomcollective.com/facilitator/integrations/zoom/callback`.
5. **Submit for Marketplace review** and work the queue.
6. Client id + secret into Secrets Manager as `hilom/zoom`.

Facilitators need their own Zoom account. Free tier is fine for 1:1 — the
40-minute cap only applies to group meetings.

---

## What we build

### 1. Token storage — the actual cost of this feature

Everything else is small. This is the part that deserves care, because we are
holding credentials that belong to somebody else.

```sql
create table public.facilitator_integrations (
  id                  uuid primary key default gen_random_uuid(),
  facilitator_id      uuid not null references public.facilitators(id) on delete cascade,
  provider            text not null check (provider in ('google_meet', 'zoom')),

  -- KMS envelope-encrypted. Never a plaintext column, and never logged.
  access_token_enc    bytea not null,
  refresh_token_enc   bytea not null,
  expires_at          timestamptz not null,

  -- Which account this actually is, so the dashboard can show
  -- "Connected as maria@gmail.com" rather than an opaque green tick.
  external_account_id text,
  external_email      text,
  scopes              text[] not null default '{}',

  -- Set when a refresh fails for good (revoked, expired, password change).
  -- The dashboard reads this; services using the provider fall back to manual.
  broken_at           timestamptz,
  broken_reason       text,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  unique (facilitator_id, provider)
);
```

Notes that matter:

- **Not AWS Secrets Manager.** It is priced per secret per month and is designed
  for a handful of application secrets, not one row per user. KMS envelope
  encryption into a `bytea` column is the right shape: one CMK, `GenerateDataKey`
  on write, `Decrypt` on read.
- **RLS: backend only.** `revoke all from anon, authenticated`, no policy, same
  as `bookings` and `facilitator_payouts`. There is no version of this table a
  browser should ever read.
- **Zoom rotates refresh tokens on every use.** Each refresh returns a *new*
  refresh token and invalidates the old one. Failing to persist it immediately
  locks the facilitator out permanently. This is the single most common way
  this kind of integration breaks.
- Google's refresh tokens are long-lived but revocable from the user's Google
  account at any time, with no notification to us.

### 2. OAuth endpoints

```
GET    /facilitator/integrations                  — what's connected, and health
POST   /facilitator/integrations/{provider}/start — returns the consent URL
GET    /facilitator/integrations/{provider}/callback
DELETE /facilitator/integrations/{provider}       — disconnect, revoke upstream
```

Standard hardening: signed `state` bound to the facilitator's session, PKCE,
redirect URI allowlisted, tokens never in a log line or an error response.

### 3. Creating the meeting

Currently `meeting_url` is copied from the service onto the booking at insert
time. That stays for `manual`. For the integrated providers, the link is created
at **confirmation** (`booking-fulfillment.ts → confirmBooking`) — after payment,
so an abandoned checkout never creates a meeting.

**Google** — one call, and the response is the whole answer:

```
POST https://meet.googleapis.com/v2/spaces  →  { meetingUri, meetingCode, name }
```

A space is a persistent room with **no start time**, which is why Google needs
no lifecycle sync at all. Reschedule the session and the link still works.
Cancel it and there is nothing to tear down.

**Zoom** — `POST /users/me/meetings`, and here there is a real design choice:

- **Scheduled meeting (type 2)** — has `start_time` and `duration`, shows up
  correctly in the facilitator's Zoom app and upcoming list. Costs us lifecycle
  sync: `PATCH` on reschedule, `DELETE` on cancel.
- **Recurring, no fixed time (type 3)** — behaves like Google's space. No sync.
  But it does not appear as a scheduled item in their Zoom client, which is
  most of why a facilitator wanted Zoom in the first place.

Recommend **type 2** and accept the sync, because the calendar entry is the
point. It is two extra calls in paths that already exist.

### 4. Failure handling — non-negotiable

The rule the booking flow is built on is *record the money before fulfilling*.
That applies here without modification:

**A booking must never fail because a meeting link could not be created.**

So at confirmation:

1. Confirm the booking and take the money regardless.
2. Attempt the provider call.
3. On failure, fall back to the service's manual `meeting_url` if one is set.
4. If there is none, confirm anyway, flag the booking, and email the facilitator
   — *"we couldn't create your Zoom link for this session, please send one"* —
   rather than emailing the client a session with no way to join.
5. Retry in the existing 5-minute booking sweep while the session is still in
   the future.

This is the same shape as the enrollment retry path in the core stack.

### 5. Connection health, surfaced early

A revoked token discovered at session time is a ruined session. It has to be
caught while it is still cheap:

- The sweep pings each connection periodically and stamps `broken_at`.
- The facilitator dashboard shows a persistent warning on Overview and Services.
- Services set to a broken provider **fall back to their manual link**, and if
  there is none, the admin queue surfaces it.

### 6. UI

**Facilitator → Settings → Connections** (new screen)

> **Google Meet** — Not connected. *Requires a Google account.*
> A new Meet link is created for each session you're booked for.
> `[ Connect Google ]`
>
> **Zoom** — Connected as `maria@example.com`. `[ Disconnect ]`
> *Requires a Zoom account.*

**Service editor**, replacing today's single "Meeting link" field:

> **Where do you meet?**
> ( ) Google Meet — a fresh link per session · **Connect your Google account first**
> ( ) Zoom — a scheduled meeting in your Zoom account · **Connect your Zoom account first**
> ( ) I'll provide my own link → [ text field, today's behaviour ]

A provider the facilitator has not connected is **shown but disabled**, with the
connect prompt inline. Hiding it makes the feature undiscoverable; enabling it
produces a service that silently cannot create links. This is where the "you
need a Zoom/Google account" message lives, at the moment of the decision.

### 7. Schema on the existing tables

```sql
alter table public.facilitator_services
  add column meeting_provider text not null default 'manual'
    check (meeting_provider in ('manual', 'google_meet', 'zoom'));

alter table public.bookings
  add column meeting_provider    text,
  add column meeting_external_id text;   -- Zoom meeting id / Meet space name
```

`bookings.meeting_url` keeps its current meaning and stays the single field the
emails read — so `booking-email.ts` needs no change at all.

---

## Alternatives, and why not

**Jitsi Meet.** Generate `https://meet.jit.si/hilom-<random>` per booking. No
OAuth, no account for anyone — not even Hilom — no API key, no review, and it
would take an afternoon. Genuinely the cheapest thing that works, and it does
satisfy "nothing to do with Hilom's account" better than either option above.
Rejected as the *primary* because a wellness client being sent to an unfamiliar
domain for a paid 1:1 is a trust cost, and the public instance offers no
guarantees. Worth reconsidering as a free-intro-call default.

**Daily.co / Whereby embedded.** Hilom holds one API key, creates a room per
booking, and the session can run *inside* Hilom rather than bouncing to another
app. Best product outcome by some distance. Rejected here only because it needs
a Hilom account and a spend commitment, which is explicitly out of scope — but
if that constraint ever softens, this is the option to revisit.

**Hilom-owned Zoom account.** Sidesteps Marketplace review entirely via
Server-to-Server OAuth. Rejected: meetings would be owned by Hilom, the
facilitator would not be host without a paid plan's alternative-host feature,
and recordings would land in Hilom's account. Explicitly out of scope.

---

## Recommended order

1. **Shared OAuth + token infrastructure.** The table, KMS encryption, refresh
   handling, connect/disconnect, the Connections screen. Provider-agnostic.
2. **Google Meet end to end.** Ships to real facilitators immediately in Testing
   mode. Proves the whole path with the simpler of the two providers — no
   lifecycle sync.
3. **Submit the Zoom app for review** as soon as (1) is done, so the queue runs
   in parallel with (2) rather than after it.
4. **Zoom**, once approved. Adds the `PATCH`/`DELETE` sync to the reschedule and
   cancel paths.
5. **Google verification**, only when the roster approaches 100 facilitators.

Steps 1–2 are the bulk of the value and depend on nobody else's queue.

---

## Answer to "is this doable?"

Yes, and without paying anyone. The honest shape of it:

- **Google Meet**: a few days, no external dependency, no cost.
- **Zoom**: same engineering, plus an unbounded wait on Zoom's review.
- The genuinely careful part is not the meeting links. It is holding other
  people's OAuth tokens safely and refreshing them without locking anyone out.
