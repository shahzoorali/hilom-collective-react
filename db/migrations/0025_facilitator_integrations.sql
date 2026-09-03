-- Connected meeting accounts: the shared OAuth layer behind Google Meet and Zoom.
--
-- This migration is provider-agnostic on purpose. It stores *that* a
-- facilitator connected an account and the credentials to act as them; what
-- gets created with those credentials (a Meet space, a Zoom meeting) lands in
-- a later change. See docs/meeting-link-integrations.md.
--
-- The governing constraint: these are somebody else's credentials. A leaked
-- refresh token here is a standing ability to create meetings — and, depending
-- on scope drift, read more — inside a real person's Zoom or Google account.
-- That is a materially worse failure than anything else in this schema, so the
-- tokens are encrypted at rest with KMS on top of RLS and Supabase's own
-- at-rest encryption, and the plaintext never exists outside a Lambda's memory.

-- ---------------------------------------------------------------------------
-- facilitator_integrations
-- ---------------------------------------------------------------------------
create table if not exists public.facilitator_integrations (
  id                  uuid primary key default gen_random_uuid(),
  facilitator_id      uuid not null references public.facilitators(id) on delete cascade,
  provider            text not null check (provider in ('google_meet', 'zoom')),

  -- KMS ciphertext blobs, not text. The encryption context is
  -- {facilitator_id, provider}, so a ciphertext lifted from one row cannot be
  -- decrypted against another — moving the bytes does not move the access.
  access_token_enc    bytea not null,
  refresh_token_enc   bytea not null,
  -- When the *access* token dies. The refresh token outlives it and is what
  -- actually keeps the connection alive.
  expires_at          timestamptz not null,

  -- Which account this is, so the dashboard can say "Connected as
  -- maria@example.com" instead of showing an opaque green tick. A facilitator
  -- with two Google accounts needs to know which one Hilom is holding.
  external_account_id text,
  external_email      text,
  -- What was actually granted. Providers may return less than was asked for,
  -- and a connection missing the scope it needs should be visible here rather
  -- than discovered at the moment a client books.
  scopes              text[] not null default '{}',

  -- Set when a refresh fails permanently: revoked from the provider's side, a
  -- password change, an expired refresh token. Null means healthy.
  --
  -- This exists because the alternative is discovering a dead connection when
  -- a client is already waiting on a call. The sweep checks it, the dashboard
  -- warns on it, and services pointed at a broken provider fall back to their
  -- manual link.
  broken_at           timestamptz,
  broken_reason       text,

  connected_at        timestamptz not null default now(),
  -- Bumped on every successful refresh; the health check reads it to spot a
  -- connection that has quietly stopped being exercised.
  last_refreshed_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- One account per provider per facilitator. Reconnecting overwrites rather
  -- than accumulating rows, so there is never a question of which of two Zoom
  -- connections is the live one.
  unique (facilitator_id, provider)
);

create index if not exists facilitator_integrations_facilitator_idx
  on public.facilitator_integrations (facilitator_id);

-- The health sweep's query: connections that are broken, or whose access token
-- has lapsed and needs exercising.
create index if not exists facilitator_integrations_health_idx
  on public.facilitator_integrations (provider, broken_at, expires_at);

drop trigger if exists facilitator_integrations_set_updated_at on public.facilitator_integrations;
create trigger facilitator_integrations_set_updated_at
  before update on public.facilitator_integrations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- facilitator_oauth_states
-- ---------------------------------------------------------------------------
-- The `state` parameter, stored rather than signed.
--
-- A stateless signed state (an HMAC carrying the facilitator id) would work and
-- would need no table — but it is replayable until it expires, and it needs a
-- signing secret that nothing else here requires. A row gives one-time use for
-- free: the callback deletes it as it claims it, so a captured redirect cannot
-- be replayed even once, and there is no new secret to provision or rotate.
--
-- This is also the only thing that authenticates the callback. The provider
-- redirects a *browser* to us with no Cognito token attached, so "which
-- facilitator is this?" cannot come from the request — it comes from here.
create table if not exists public.facilitator_oauth_states (
  -- The opaque value sent to the provider as `state`. Generated with
  -- randomUUID + randomBytes, never sequential.
  state          text primary key,
  facilitator_id uuid not null references public.facilitators(id) on delete cascade,
  provider       text not null check (provider in ('google_meet', 'zoom')),
  -- PKCE verifier. Google and Zoom both support PKCE; it closes the
  -- authorization-code interception window that `state` alone does not.
  code_verifier  text not null,
  -- Where to send the browser afterwards, so a connect started from the
  -- Services editor returns there rather than always to Settings.
  return_to      text,
  -- Short by design. A consent screen that has been open for an hour is a
  -- stale flow, not a slow user.
  expires_at     timestamptz not null default now() + interval '15 minutes',
  created_at     timestamptz not null default now()
);

create index if not exists facilitator_oauth_states_expiry_idx
  on public.facilitator_oauth_states (expires_at);

-- ---------------------------------------------------------------------------
-- RLS — backend only, no exceptions
-- ---------------------------------------------------------------------------
-- There is no version of either table a browser should read. The integrations
-- table holds credentials; the states table holds the one value that would let
-- someone complete a connect flow as another facilitator. Both follow the
-- `bookings` / `facilitator_payouts` pattern: RLS on, every grant revoked from
-- anon and authenticated, and no policy at all — so even a future
-- default-privileges mistake grants nothing.
alter table public.facilitator_integrations enable row level security;
alter table public.facilitator_oauth_states enable row level security;

revoke all on public.facilitator_integrations from anon, authenticated;
revoke all on public.facilitator_oauth_states from anon, authenticated;

grant select, insert, update, delete
  on public.facilitator_integrations, public.facilitator_oauth_states
  to service_role;
