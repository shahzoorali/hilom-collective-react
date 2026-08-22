-- Facilitator marketplace, part 2 of 3: bookings.
--
-- The central design decision here is that **double-booking is prevented by the
-- database, not by application code**. Two people clicking the last remaining
-- slot at the same moment is the defining failure of a booking system, and the
-- obvious implementation — SELECT to check the slot is free, then INSERT —
-- loses that race every time under concurrency: both transactions read "free"
-- before either writes. Advisory locks or SERIALIZABLE would work but put the
-- correctness of the whole feature in handler code that is easy to bypass from
-- a second call site. A GiST exclusion constraint pushes it into the schema,
-- where every writer gets it for free and the failure mode is a clean 23P01.
--
-- Money notes:
--  * The fee split is stored on the row (platform_fee_centavos,
--    facilitator_net_centavos) rather than recomputed from the facilitator's
--    current platform_fee_bps. Rates change; what a facilitator earned on a
--    session in August must not move when their rate is renegotiated in
--    October. Same reason the price and meeting URL are snapshotted.
--  * `paymongo_payment_id` mirrors orders.paymongo_payment_id and is the same
--    idempotency key against PayMongo's at-least-once webhook delivery.
--    Nullable, because free exploratory calls never touch PayMongo.
--  * Refund amounts are *recorded*, not executed. Consistent with the existing
--    "manual revoke, no automation" rule for course refunds — the platform
--    decides and logs the amount, a human moves the money.

-- pending_payment — slot is held, PayMongo checkout not yet completed. Holds
--                   expire (see hold_expires_at) so an abandoned checkout does
--                   not sterilise a slot forever.
-- confirmed       — paid (or free) and on both calendars
-- completed       — the session time has passed; set by the sweep job
-- no_show         — client did not attend; facilitator-reported
-- refunded        — cancelled with money returned
do $$ begin
  create type public.booking_status as enum (
    'pending_payment',
    'confirmed',
    'cancelled_by_client',
    'cancelled_by_facilitator',
    'completed',
    'no_show',
    'refunded'
  );
exception when duplicate_object then null;
end $$;

-- Required by the exclusion constraint below: GiST cannot index a plain uuid
-- for equality without this extension, only the range side.
create extension if not exists btree_gist;

create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  facilitator_id     uuid not null references public.facilitators(id) on delete restrict,
  -- restrict, not cascade: deleting a service must not silently erase the
  -- bookings people already paid for. Services are deactivated, not deleted.
  service_id         uuid not null references public.facilitator_services(id) on delete restrict,
  -- Denormalized from the service purely so the one-free-call-per-client
  -- partial index below can see it — an index cannot reach through a foreign
  -- key. Written once at insert and never updated.
  service_kind       public.service_kind not null,

  -- The client. Like orders, there is no users table: the verified Cognito
  -- email is the identity, and `sub` is kept alongside it for the same reason
  -- facilitators have one (email can change).
  client_email       text not null,
  client_cognito_sub text,
  client_name        text,
  client_notes       text,

  -- Always UTC. The facilitator's timezone lives on their row and is used only
  -- to project weekly availability rules onto real instants; nothing downstream
  -- of slot generation needs a local time.
  starts_at          timestamptz not null,
  -- Includes the service's buffer_minutes. Storing the padded end rather than
  -- the session's true end means the exclusion constraint enforces buffers for
  -- free, instead of every writer having to remember to add them.
  ends_at            timestamptz not null,

  status             public.booking_status not null default 'pending_payment',

  -- Snapshots taken at booking time — see the money note above.
  price_centavos          int not null default 0 check (price_centavos >= 0),
  platform_fee_centavos   int not null default 0 check (platform_fee_centavos >= 0),
  facilitator_net_centavos int not null default 0 check (facilitator_net_centavos >= 0),
  currency                text not null default 'PHP',
  meeting_url             text,

  paymongo_payment_id text unique,
  paymongo_session_id text,

  -- Null once confirmed. While pending_payment, the instant after which the
  -- sweep job (and the next booking attempt for this facilitator) may reclaim
  -- the slot.
  hold_expires_at    timestamptz,

  cancelled_at        timestamptz,
  cancelled_by        text check (cancelled_by in ('client', 'facilitator', 'admin')),
  cancellation_reason text,
  -- What the policy says is owed back, in centavos. 0 is a real value (a
  -- late cancellation), distinct from null (nothing was ever charged).
  refund_centavos     int check (refund_centavos >= 0),

  error_detail       text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  constraint bookings_range check (ends_at > starts_at)
);

-- ---------------------------------------------------------------------------
-- The constraint that makes this a booking system
-- ---------------------------------------------------------------------------
-- No two live bookings for the same facilitator may overlap in time. `[)` is
-- half-open so a 10:00-11:00 and an 11:00-12:00 session do not collide.
-- Cancelled, completed and no-show rows are excluded from the predicate: past
-- and abandoned bookings must not block the slot from being sold again.
--
-- ALTER TABLE ADD CONSTRAINT has no IF NOT EXISTS, so this is guarded by hand
-- to keep the migration re-runnable like every other file here.
do $$ begin
  alter table public.bookings add constraint bookings_no_overlap
    exclude using gist (
      facilitator_id with =,
      tstzrange(starts_at, ends_at, '[)') with &&
    ) where (status in ('pending_payment', 'confirmed'));
exception when duplicate_object then null;
end $$;

-- One free exploratory call per client per facilitator, ever. Without this the
-- free call is an unlimited supply of free coaching. Cancelled-by-client rows
-- are excluded from the predicate so that someone who genuinely could not make
-- it is not permanently locked out — but a completed or no-show call still
-- counts, which is the point.
create unique index if not exists bookings_one_exploratory_per_client_idx
  on public.bookings (facilitator_id, lower(client_email))
  where service_kind = 'exploratory'
    and status not in ('cancelled_by_client', 'cancelled_by_facilitator', 'refunded');

-- "My bookings", upcoming first.
create index if not exists bookings_client_idx
  on public.bookings (lower(client_email), starts_at desc);

-- The facilitator's calendar, and the busy-times read in slot generation.
create index if not exists bookings_facilitator_starts_idx
  on public.bookings (facilitator_id, starts_at);

-- The sweep job's two queries: expire holds, and complete past sessions.
create index if not exists bookings_hold_expiry_idx
  on public.bookings (hold_expires_at)
  where status = 'pending_payment';

create index if not exists bookings_status_ends_idx
  on public.bookings (status, ends_at);

drop trigger if exists bookings_set_updated_at on public.bookings;
create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS — backend-only, exactly like orders.
--
-- Bookings hold client emails, private session notes and payment ids. Nothing
-- here is ever read directly from the browser; both the client's "my bookings"
-- view and the facilitator's calendar go through Lambda, which authorizes the
-- caller against the row before returning it. So there is no policy at all for
-- anon/authenticated, and grants are revoked as a second layer.
-- ---------------------------------------------------------------------------
alter table public.bookings enable row level security;
revoke all on public.bookings from anon, authenticated;

grant select, insert, update, delete on public.bookings to service_role;
