-- Make the per-service cancellation policy real.
--
-- `facilitator_services.cancellation_policy` has existed since 0011 as free
-- text, shown to clients on the booking page and on the public profile. The
-- refund arithmetic in backend/src/lib/booking-domain.ts never read it: every
-- cancellation, on every service, applied a hardcoded 24h-full / 12h-half /
-- under-12h-nothing ladder. A facilitator who wrote "48 hours notice, no
-- refunds after" was making a promise the platform quietly broke, and the
-- client reading it was misled about their own money.
--
-- The fix is two integer columns rather than parsing the prose. The thresholds
-- are the part that has to be *executed*, and executed identically by the
-- quote the client sees before cancelling and by the amount written to the
-- row; free text cannot be either. The prose column stays, demoted to what it
-- should always have been — additional notes beside a generated, accurate
-- sentence, not the policy itself.
--
--   refund_full_hours — at or above this many hours' notice, refund in full
--   refund_half_hours — at or above this, refund half; below it, nothing
--
-- Defaults are exactly the ladder that was hardcoded, so every existing
-- service keeps behaving precisely as it did today and no facilitator's
-- clients are surprised by a migration.
--
-- Both are allowed to be 0, which is how the two degenerate policies are
-- expressed: full = 0 means "always fully refundable", and half = 0 with a
-- full above it means "never a dead zone, half right up to the start". The
-- check keeps them in order, because a half threshold above the full one
-- describes a ladder that goes backwards.

alter table public.facilitator_services
  add column if not exists refund_full_hours int not null default 24
    check (refund_full_hours between 0 and 720);

alter table public.facilitator_services
  add column if not exists refund_half_hours int not null default 12
    check (refund_half_hours between 0 and 720);

do $$ begin
  alter table public.facilitator_services
    add constraint facilitator_services_refund_tiers_ordered
      check (refund_half_hours <= refund_full_hours);
exception when duplicate_object then null;
end $$;

-- Snapshot the thresholds onto the booking, for the same reason the price and
-- the fee split are snapshotted (see 0012): a facilitator who tightens their
-- policy in October must not thereby change what a client who booked in August
-- is owed. The refund is computed from these, not from the service's current
-- values.
--
-- Nullable, and null means "the 24/12 default" rather than "no policy" — rows
-- written before this migration have no snapshot to read, and inventing one
-- retroactively would be asserting a fact about them that was never recorded.
alter table public.bookings
  add column if not exists refund_full_hours int
    check (refund_full_hours is null or refund_full_hours between 0 and 720);

alter table public.bookings
  add column if not exists refund_half_hours int
    check (refund_half_hours is null or refund_half_hours between 0 and 720);

-- No RLS change. `facilitator_services` is already selectable by anon (0011)
-- and clients need to read these to be shown the policy before they book;
-- `bookings` is backend-only.
