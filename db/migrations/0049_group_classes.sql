-- Group classes: a facilitator teaches many people at one time, online or in
-- person, with a minimum and a maximum number of joiners.
--
-- ===========================================================================
-- Why these are not `bookings`
-- ===========================================================================
-- `bookings` carries an exclusion constraint (0012:125):
--
--   exclude using gist (facilitator_id with =, tstzrange(starts_at, ends_at) with &&)
--
-- It is what makes double-booking impossible and it is load-bearing. Twelve
-- people joining one class at 10:00 would be twelve overlapping rows for one
-- facilitator, and the constraint would reject eleven of them — correctly,
-- because that is exactly the bug it exists to prevent.
--
-- The alternative was to weaken the predicate so that group rows are exempt.
-- Rejected: every future write to `bookings` would then depend on getting that
-- exemption right, and a write that gets it wrong double-books a real person's
-- calendar. A constraint that is unconditional is one you cannot be wrong
-- about.
--
-- Structurally a class is an *event*, not a booking: one instant, a capacity, a
-- seat, a roster, many payers, one facilitator. `event_registrations` already
-- solves seat allocation under concurrency (claim_event_seat, 0016), so the
-- three tables below mirror that shape and reuse its enums rather than
-- inventing parallel ones.
--
-- ===========================================================================
-- The minimum does not cancel anything
-- ===========================================================================
-- `min_joiners` is advisory. A class runs whether or not it reaches it.
--
-- This is a product decision and it is the reason this migration is merely
-- large rather than enormous. Auto-cancelling an under-subscribed class means
-- refunding every paid seat, which means driving PayMongo refunds from a
-- scheduled job and reconciling partial failures — the whole of the 0027
-- refund machinery, on a trigger nobody watches. Nothing in this schema reads
-- `min_joiners` to make a decision; it is shown to the facilitator on their
-- session list and, optionally, on the public page as "runs with 3+".

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
-- scheduled — on the calendar, taking registrations
-- cancelled — called off by the facilitator or an admin. Refunds are handled
--             by the same manual path a 1:1 cancellation uses; this column
--             does not move money.
-- completed — it happened.
do $$ begin
  create type public.class_session_status as enum ('scheduled', 'cancelled', 'completed');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- The offering
-- ---------------------------------------------------------------------------
-- "Thursday morning breathwork" as a thing that exists, separate from the
-- particular Thursday. Split for the same reason `event_payment_plans` is
-- separate from `event_registrations`: the description, the price and the
-- capacity are authored once and a session inherits them, but a session that
-- has already sold seats must keep what it sold under.
create table if not exists public.facilitator_classes (
  id             uuid primary key default gen_random_uuid(),
  facilitator_id uuid not null references public.facilitators(id) on delete restrict,

  title       text not null,
  description text,

  -- Reuses 0011's enum rather than a boolean: 'both' is a real answer for a
  -- class that runs in a room and streams at the same time.
  delivery_mode public.delivery_mode not null default 'online',
  -- Where, for in_person/both. Free text, same call 0007 made for events.
  location      text,
  -- The room. Withheld from every public read and released to confirmed
  -- registrants only — the same rule as facilitator_services.meeting_url
  -- (0011) and events.join_url (0045).
  meeting_url   text,

  duration_minutes int not null check (duration_minutes between 5 and 480),

  price_centavos int  not null default 0 check (price_centavos >= 0),
  currency       text not null default 'PHP',

  -- Advisory, per the note above. `min <= max` is enforced; nothing else reads
  -- min_joiners.
  min_joiners int not null default 1 check (min_joiners >= 1),
  max_joiners int not null check (max_joiners >= 1),

  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint facilitator_classes_joiner_range check (max_joiners >= min_joiners)
);

comment on column public.facilitator_classes.min_joiners is
  'Advisory only. A class runs below this number — nothing cancels or refunds '
  'automatically. See the header of 0049 for why.';
comment on column public.facilitator_classes.meeting_url is
  'NEVER include in a public read. Released to confirmed registrants only.';

create index if not exists facilitator_classes_facilitator_idx
  on public.facilitator_classes (facilitator_id, is_active);

-- ---------------------------------------------------------------------------
-- One scheduled occurrence
-- ---------------------------------------------------------------------------
create table if not exists public.facilitator_class_sessions (
  id       uuid primary key default gen_random_uuid(),
  -- restrict, not cascade: deleting a class must not erase sessions people
  -- paid for. Classes are deactivated, not deleted — same rule as
  -- bookings -> facilitator_services (0012).
  class_id uuid not null references public.facilitator_classes(id) on delete restrict,

  -- Denormalized from the class so slot generation and the calendar can read a
  -- session without a join, and so that editing the class later cannot move
  -- sessions that are already on somebody's calendar.
  facilitator_id uuid not null references public.facilitators(id) on delete restrict,

  starts_at timestamptz not null,
  ends_at   timestamptz not null,

  -- Snapshots, for the reason 0016 gives about plans: editing the class in
  -- November must not restate what someone bought in September.
  price_centavos int  not null default 0 check (price_centavos >= 0),
  currency       text not null default 'PHP',
  capacity       int  not null check (capacity >= 1),
  min_joiners    int  not null default 1 check (min_joiners >= 1),

  status public.class_session_status not null default 'scheduled',

  -- Snapshotted at creation, like bookings.meeting_url, so that changing the
  -- class's standing room later cannot silently redirect a session people are
  -- already booked onto.
  meeting_url text,

  cancelled_at        timestamptz,
  cancellation_reason text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint class_sessions_range check (ends_at > starts_at)
);

-- The two queries this table exists for: "what is this facilitator teaching,
-- and when" (their dashboard, and the slot generator subtracting class time
-- from 1:1 availability) and "what is on this class".
create index if not exists class_sessions_facilitator_idx
  on public.facilitator_class_sessions (facilitator_id, starts_at)
  where status = 'scheduled';

create index if not exists class_sessions_class_idx
  on public.facilitator_class_sessions (class_id, starts_at desc);

-- ---------------------------------------------------------------------------
-- Who is in it
-- ---------------------------------------------------------------------------
-- The money columns are copied from `bookings` verbatim — same names, same
-- split, same meaning — so that this feeds the existing facilitator_payouts
-- ledger with no second payout code path and no query that has to remember
-- which of two shapes it is summing.
create table if not exists public.class_registrations (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.facilitator_class_sessions(id) on delete restrict,
  -- Denormalized so "everything this facilitator is owed" is one index scan
  -- rather than a two-hop join through sessions and classes.
  facilitator_id uuid not null references public.facilitators(id) on delete restrict,

  -- The client. As with orders, bookings and event_registrations, there is no
  -- users table: the verified Cognito email is the identity, and `sub` rides
  -- alongside because an email can change.
  client_email       text not null,
  client_cognito_sub text,
  client_name        text,
  client_notes       text,

  -- Reuses 0016's registration_status: the lifecycle is identical, down to
  -- keeping `expired` rows rather than deleting them.
  status public.registration_status not null default 'pending_payment',

  -- 1..capacity, assigned by claim_class_seat(). Capacity is enforced through
  -- a number rather than a count, for the reason 0016 gives.
  seat_no int not null check (seat_no > 0),

  price_centavos           int not null default 0 check (price_centavos >= 0),
  platform_fee_centavos    int not null default 0 check (platform_fee_centavos >= 0),
  facilitator_net_centavos int not null default 0 check (facilitator_net_centavos >= 0),
  currency                 text not null default 'PHP',

  paymongo_payment_id text unique,
  paymongo_session_id text,

  -- Null once confirmed. While pending_payment, the instant after which the
  -- sweep may reclaim the seat.
  hold_expires_at timestamptz,

  cancelled_at        timestamptz,
  cancelled_by        text check (cancelled_by in ('client', 'facilitator', 'admin')),
  cancellation_reason text,
  refund_centavos     int check (refund_centavos >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The constraint that makes capacity real: two concurrent claims cannot land
-- on the same number, whatever the function does. Partial on the live statuses
-- so a cancelled seat is immediately resellable.
create unique index if not exists class_registrations_seat_idx
  on public.class_registrations (session_id, seat_no)
  where status in ('pending_payment', 'confirmed');

-- One place per person per session. Someone buying for a friend registers the
-- friend; someone buying twice for themselves is a mistake, not a feature.
create unique index if not exists class_registrations_one_per_client_idx
  on public.class_registrations (session_id, lower(client_email))
  where status in ('pending_payment', 'confirmed');

create index if not exists class_registrations_facilitator_idx
  on public.class_registrations (facilitator_id, status);

create index if not exists class_registrations_client_idx
  on public.class_registrations (lower(client_email), status);

-- The sweep's scan for lapsed holds.
create index if not exists class_registrations_hold_idx
  on public.class_registrations (hold_expires_at)
  where status = 'pending_payment';

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists facilitator_classes_set_updated_at on public.facilitator_classes;
create trigger facilitator_classes_set_updated_at
  before update on public.facilitator_classes
  for each row execute function public.set_updated_at();

drop trigger if exists class_sessions_set_updated_at on public.facilitator_class_sessions;
create trigger class_sessions_set_updated_at
  before update on public.facilitator_class_sessions
  for each row execute function public.set_updated_at();

drop trigger if exists class_registrations_set_updated_at on public.class_registrations;
create trigger class_registrations_set_updated_at
  before update on public.class_registrations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Seat claiming
-- ---------------------------------------------------------------------------
-- Modelled directly on claim_event_seat (0016). The row lock on the session is
-- what serialises concurrent claims; the unique index above is the backstop
-- that holds even if this function is ever wrong.
create or replace function public.claim_class_seat(
  p_session_id   uuid,
  p_client_email text,
  p_client_sub   text,
  p_client_name  text,
  p_client_notes text,
  p_hold_minutes int
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.facilitator_class_sessions%rowtype;
  v_taken   int;
  v_seat    int;
  v_reg_id  uuid;
  v_hold    timestamptz := now() + make_interval(mins => p_hold_minutes);
begin
  select * into v_session
    from public.facilitator_class_sessions
   where id = p_session_id
     for update;
  if not found then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;

  if v_session.status <> 'scheduled' then
    raise exception 'session_not_open' using errcode = 'P0001';
  end if;
  if v_session.starts_at <= now() then
    raise exception 'session_started' using errcode = 'P0001';
  end if;

  -- Lapsed holds, released inline — the seat index cannot read
  -- hold_expires_at (a partial index predicate must be immutable), so without
  -- this an abandoned checkout keeps its number until the sweep next runs.
  update public.class_registrations
     set status = 'expired'
   where session_id = p_session_id
     and status = 'pending_payment'
     and hold_expires_at < now();

  -- Checked after the release above, so someone re-attempting a checkout they
  -- abandoned is not blocked by their own lapsed hold.
  if exists (
    select 1 from public.class_registrations
     where session_id = p_session_id
       and lower(client_email) = lower(p_client_email)
       and status in ('pending_payment', 'confirmed')
  ) then
    raise exception 'already_registered' using errcode = 'P0001';
  end if;

  select count(*) into v_taken
    from public.class_registrations
   where session_id = p_session_id
     and status in ('pending_payment', 'confirmed');

  if v_taken >= v_session.capacity then
    raise exception 'class_full' using errcode = 'P0001';
  end if;

  -- Lowest free number, so a released seat 3 is resold as seat 3 rather than
  -- the roster growing gaps as holds come and go.
  select min(g) into v_seat
    from generate_series(1, v_session.capacity) g
   where not exists (
     select 1 from public.class_registrations r
      where r.session_id = p_session_id
        and r.seat_no = g
        and r.status in ('pending_payment', 'confirmed'));

  insert into public.class_registrations (
    session_id, facilitator_id, client_email, client_cognito_sub, client_name,
    client_notes, status, seat_no, price_centavos, currency, hold_expires_at
  ) values (
    p_session_id, v_session.facilitator_id, lower(p_client_email), p_client_sub,
    p_client_name, p_client_notes, 'pending_payment', v_seat,
    v_session.price_centavos, v_session.currency, v_hold
  ) returning id into v_reg_id;

  return v_reg_id;
end;
$$;

revoke all on function public.claim_class_seat(uuid, text, text, text, text, int)
  from public, anon, authenticated;
grant execute on function public.claim_class_seat(uuid, text, text, text, text, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
-- Classes and their sessions follow the published-content shape: a price and a
-- schedule are public by nature, and the class page has to render them. Gated
-- on the facilitator being published, the same gate the directory uses.
--
-- Registrations follow the backend-only shape (0012:172-175): no anon or
-- authenticated policy at all, because a roster is somebody's attendance
-- record and every legitimate read of it goes through a handler that has
-- already checked who is asking.
alter table public.facilitator_classes           enable row level security;
alter table public.facilitator_class_sessions    enable row level security;
alter table public.class_registrations           enable row level security;

grant select on public.facilitator_classes        to anon, authenticated;
grant select on public.facilitator_class_sessions to anon, authenticated;

drop policy if exists facilitator_classes_public_read on public.facilitator_classes;
create policy facilitator_classes_public_read
  on public.facilitator_classes for select
  to anon, authenticated
  using (
    is_active
    and exists (
      select 1 from public.facilitators f
       where f.id = facilitator_id and f.status = 'published'
    )
  );

drop policy if exists class_sessions_public_read on public.facilitator_class_sessions;
create policy class_sessions_public_read
  on public.facilitator_class_sessions for select
  to anon, authenticated
  using (
    status = 'scheduled'
    and exists (
      select 1 from public.facilitator_classes c
       where c.id = class_id
         and c.is_active
         and exists (
           select 1 from public.facilitators f
            where f.id = c.facilitator_id and f.status = 'published'
         )
    )
  );

-- The service role bypasses RLS but still needs explicit grants — see the note
-- in 0002_rls.sql.
grant select, insert, update, delete on public.facilitator_classes        to service_role;
grant select, insert, update, delete on public.facilitator_class_sessions to service_role;
grant select, insert, update, delete on public.class_registrations        to service_role;

-- `meeting_url` is readable through the policies above, which would publish
-- the room. Revoked at the column level: a public read that selects it now
-- errors rather than silently returning it, and the handlers that are supposed
-- to release it use the service role.
revoke select (meeting_url) on public.facilitator_classes        from anon, authenticated;
revoke select (meeting_url) on public.facilitator_class_sessions from anon, authenticated;
