-- Facilitator marketplace, part 1 of 3: the facilitator entity and what they sell.
--
-- Design notes:
--  * This is the first user-ish table in the schema. Until now identity lived
--    entirely in Cognito and the only user key in Postgres was
--    orders.buyer_email. A facilitator needs a real row because they own
--    content (profile, services, availability) and money (fee rate, payouts),
--    none of which fits in a JWT claim. Buyers still get no row — they are
--    still just an email on an order or a booking.
--  * `cognito_sub` is the join back to identity, not email: Cognito lets a user
--    change their address, and a fee rate silently reattaching to a different
--    person would be a money bug. Email is kept for display and for the
--    application flow, where a row can exist before the Cognito user does.
--  * `platform_fee_bps` is per-facilitator (default 1500 = 15%) rather than a
--    constant in code, so the 15/12/10% partner tiers are a data change. Basis
--    points, not a percent float — fee arithmetic runs in integer centavos and
--    a float rate would reintroduce rounding drift at the last step.
--  * No payout-processor columns (sub-account ids, KYC state). Hilom collects
--    and pays out manually for now; `payout_details` is deliberately jsonb so
--    that bank details today and a processor sub-account id later do not each
--    need a migration.

-- ---------------------------------------------------------------------------
-- Lifecycle
-- ---------------------------------------------------------------------------
-- applied   — submitted the form, not yet reviewed
-- approved  — vetted, may configure services/availability, NOT publicly listed
-- published — visible in the directory and bookable
-- suspended — hidden and unbookable, but rows and history retained
-- rejected  — terminal
--
-- approved and published are separate on purpose: a facilitator needs to be
-- able to set up services and hours before they go live, and Hilom needs to be
-- able to pull someone from the directory without destroying their bookings.
do $$ begin
  create type public.facilitator_status as enum
    ('applied', 'approved', 'published', 'suspended', 'rejected');
exception when duplicate_object then null;
end $$;

do $$ begin
  create type public.delivery_mode as enum ('online', 'in_person', 'both');
exception when duplicate_object then null;
end $$;

-- exploratory — the free "Explore Your Fit" call; capped at one per client per
--               facilitator (enforced in 0012_bookings.sql)
-- standard    — a single paid session
-- package     — N sessions sold together
do $$ begin
  create type public.service_kind as enum ('exploratory', 'standard', 'package');
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- facilitators
-- ---------------------------------------------------------------------------
create table if not exists public.facilitators (
  id               uuid primary key default gen_random_uuid(),
  -- Null until the person signs in for the first time: an application can be
  -- submitted (or entered by Hilom staff) before a Cognito user exists.
  cognito_sub      text unique,
  email            text not null,
  -- Directory URL segment. Generated with normalizeSlug/findAvailableSlug from
  -- backend/src/lib/slug.ts, same as pages and posts.
  slug             text not null unique,

  -- Public identity
  display_name     text not null,
  headline         text,
  bio              text,
  photo_media_id   uuid references public.media_assets(id) on delete set null,
  photo_url        text,
  -- Free text lines ("MA Counselling Psychology, UP Diliman"), rendered as a
  -- list. Not a lookup table: credentials in this field are wildly
  -- heterogeneous and normalizing them would be a taxonomy project.
  credentials      text[] not null default '{}',
  specialties      text[] not null default '{}',
  languages        text[] not null default '{}',
  location         text,
  delivery_mode    public.delivery_mode not null default 'online',
  -- Scope-of-practice statement, shown verbatim on the profile. Exists because
  -- coaches, breathwork facilitators and licensed psychologists are not
  -- interchangeable, and the platform must not let a booking description imply
  -- clinical treatment by someone unqualified to provide it.
  scope_note       text,
  social_links     jsonb not null default '{}'::jsonb,

  -- Private / operational
  legal_name       text,
  phone            text,
  -- IANA zone. Availability is stored as weekday + minutes-from-local-midnight,
  -- so this is what projects those rules onto real instants.
  timezone         text not null default 'Asia/Manila',
  status           public.facilitator_status not null default 'applied',
  platform_fee_bps int not null default 1500 check (platform_fee_bps between 0 and 10000),
  -- Vacation mode: blocks all new bookings up to this instant without the
  -- facilitator having to delete their weekly availability and retype it later.
  vacation_until   timestamptz,
  payout_details   jsonb not null default '{}'::jsonb,
  admin_notes      text,

  applied_at       timestamptz not null default now(),
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Email is matched case-insensitively everywhere it is used (applications,
-- lookups), so the constraint has to be too.
create unique index if not exists facilitators_email_lower_idx
  on public.facilitators (lower(email));

-- The directory query: published only, ordered by name.
create index if not exists facilitators_status_idx
  on public.facilitators (status, display_name);

-- Specialty filter on the directory ("what are you looking for?").
create index if not exists facilitators_specialties_idx
  on public.facilitators using gin (specialties);

drop trigger if exists facilitators_set_updated_at on public.facilitators;
create trigger facilitators_set_updated_at
  before update on public.facilitators
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- facilitator_services — what a facilitator sells
-- ---------------------------------------------------------------------------
create table if not exists public.facilitator_services (
  id                 uuid primary key default gen_random_uuid(),
  facilitator_id     uuid not null references public.facilitators(id) on delete cascade,
  kind               public.service_kind not null default 'standard',
  title              text not null,
  description        text,
  duration_minutes   int  not null check (duration_minutes between 5 and 480),
  price_centavos     int  not null default 0 check (price_centavos >= 0),
  currency           text not null default 'PHP',
  -- >1 only for `package`. Kept on the service rather than derived from `kind`
  -- so a 3-session and a 6-session package are two rows, not two enum values.
  sessions_count     int  not null default 1 check (sessions_count >= 1),
  delivery_mode      public.delivery_mode not null default 'online',
  -- The facilitator's own standing room (Zoom/Meet/etc). Snapshotted onto each
  -- booking at confirmation time so that changing it later cannot silently
  -- redirect sessions that are already on someone's calendar.
  meeting_url        text,

  -- Scheduling rules. Defaults chosen to be safe rather than permissive: a
  -- facilitator who never opens this screen still gets 12 hours' notice.
  buffer_minutes     int not null default 0   check (buffer_minutes between 0 and 240),
  min_notice_minutes int not null default 720 check (min_notice_minutes >= 0),
  max_advance_days   int not null default 60  check (max_advance_days between 1 and 365),
  -- Null = unlimited. Guards against a fully-open Saturday turning into eight
  -- back-to-back sessions.
  max_per_day        int check (max_per_day >= 1),
  cancellation_policy text,

  is_active          boolean not null default true,
  sort_order         int not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- At most one active free call per facilitator. Without this the "one
-- exploratory booking per client" rule in 0012 could be sidestepped by
-- publishing a second free service.
create unique index if not exists facilitator_services_one_exploratory_idx
  on public.facilitator_services (facilitator_id)
  where kind = 'exploratory' and is_active;

create index if not exists facilitator_services_facilitator_idx
  on public.facilitator_services (facilitator_id, is_active, sort_order);

drop trigger if exists facilitator_services_set_updated_at on public.facilitator_services;
create trigger facilitator_services_set_updated_at
  before update on public.facilitator_services
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- facilitator_availability — recurring weekly hours
-- ---------------------------------------------------------------------------
-- Stored as (weekday, minutes-from-local-midnight) rather than timestamps
-- because the rule is genuinely recurring: "Mondays 9am-12pm" is one row
-- forever, not 52 rows a year. backend/src/lib/slots.ts projects these onto
-- real instants using the facilitator's timezone.
--
-- Multiple rows per weekday are allowed and expected (a 9-12 and a 2-6 block
-- is a lunch break expressed as two windows).
create table if not exists public.facilitator_availability (
  id             uuid primary key default gen_random_uuid(),
  facilitator_id uuid not null references public.facilitators(id) on delete cascade,
  weekday        int not null check (weekday between 0 and 6), -- 0 = Sunday
  start_minute   int not null check (start_minute between 0 and 1440),
  end_minute     int not null check (end_minute   between 0 and 1440),
  created_at     timestamptz not null default now(),
  -- Windows do not wrap past local midnight; an overnight block is two rows.
  constraint facilitator_availability_range check (end_minute > start_minute)
);

create index if not exists facilitator_availability_facilitator_idx
  on public.facilitator_availability (facilitator_id, weekday);

-- ---------------------------------------------------------------------------
-- facilitator_blackouts — one-off unavailability
-- ---------------------------------------------------------------------------
-- The exception layer over the weekly rules: a holiday, a conference, an
-- afternoon off. Subtracted from generated slots in slots.ts.
create table if not exists public.facilitator_blackouts (
  id             uuid primary key default gen_random_uuid(),
  facilitator_id uuid not null references public.facilitators(id) on delete cascade,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  reason         text,
  created_at     timestamptz not null default now(),
  constraint facilitator_blackouts_range check (ends_at > starts_at)
);

create index if not exists facilitator_blackouts_facilitator_idx
  on public.facilitator_blackouts (facilitator_id, starts_at);

-- ---------------------------------------------------------------------------
-- RLS
--
-- Everything here is served through Lambda, which uses the secret key. anon is
-- given read access only to published profiles and their active services, so
-- that the default-privileges footgun described in 0002_rls.sql cannot quietly
-- expose the private columns.
--
-- Note availability, blackouts and payout details are NOT readable by anon: a
-- facilitator's full working calendar and bank details are not public. The
-- public availability endpoint returns computed free slots, not the rules.
-- ---------------------------------------------------------------------------
alter table public.facilitators             enable row level security;
alter table public.facilitator_services     enable row level security;
alter table public.facilitator_availability enable row level security;
alter table public.facilitator_blackouts    enable row level security;

revoke all on public.facilitators             from anon, authenticated;
revoke all on public.facilitator_availability from anon, authenticated;
revoke all on public.facilitator_blackouts    from anon, authenticated;

-- Column-level grant: the private columns (legal_name, phone, payout_details,
-- admin_notes, cognito_sub, platform_fee_bps) are deliberately absent.
grant select (
  id, slug, display_name, headline, bio, photo_url, photo_media_id,
  credentials, specialties, languages, location, delivery_mode, scope_note,
  social_links, timezone, status
) on public.facilitators to anon, authenticated;

grant select on public.facilitator_services to anon, authenticated;

drop policy if exists facilitators_public_read on public.facilitators;
create policy facilitators_public_read
  on public.facilitators for select
  to anon, authenticated
  using (status = 'published');

drop policy if exists facilitator_services_public_read on public.facilitator_services;
create policy facilitator_services_public_read
  on public.facilitator_services for select
  to anon, authenticated
  using (
    is_active
    and exists (
      select 1 from public.facilitators f
      where f.id = facilitator_services.facilitator_id
        and f.status = 'published'
    )
  );

-- service_role bypasses RLS but still needs explicit privileges, or every
-- backend query fails with 42501. See the note in 0002_rls.sql.
grant select, insert, update, delete on
  public.facilitators,
  public.facilitator_services,
  public.facilitator_availability,
  public.facilitator_blackouts
  to service_role;

grant usage, select on all sequences in schema public to service_role;
