-- A subscribable calendar feed for facilitators.
--
-- Confirmed sessions live only in the Hilom dashboard. To see them alongside
-- the rest of their life a facilitator re-types each one into their own
-- calendar, which is both the tax that makes a tool feel like a website and
-- the mechanism by which someone double-books themselves.
--
-- A read-only `.ics` URL fixes it, and the awkward part is authentication:
-- calendar clients fetch on a schedule with no session, no cookie and no way
-- to send a bearer token. Every subscribable feed on the internet solves this
-- the same way, with a long random secret in the URL itself, and so does this
-- one.
--
-- The consequences of that are worth stating plainly, because the token is a
-- bearer credential in a string that ends up pasted into calendar apps:
--
--  * It is per-facilitator and reveals only that facilitator's own sessions.
--  * The feed is strictly read-only. Nothing is mutable through it.
--  * It is generated on demand, not at signup — a facilitator who never
--    subscribes never has one to leak.
--  * It is rotatable: regenerating writes a new token and the old URL stops
--    working immediately, which is the entire remedy if a link is shared by
--    accident.
--
-- 32 bytes of randomness, hex-encoded. Not a signed token: a signature would
-- have to be verified against a secret this service would then have to hold
-- and rotate, and buys nothing over a random string checked against a unique
-- index — there is no claim inside it worth protecting from tampering.
alter table public.facilitators
  add column if not exists calendar_token text unique;

-- The feed's only lookup. Partial, because the column is null for every
-- facilitator who has not subscribed.
create index if not exists facilitators_calendar_token_idx
  on public.facilitators (calendar_token)
  where calendar_token is not null;

-- No RLS change. `facilitators` already restricts anon reads to published
-- profiles by other means, and the feed is served by the backend with the
-- service key after matching the token — never by a client reading this column.
