-- Ratings, made readable without a join.
--
-- `facilitator_reviews` has existed since 0013 — table, RLS, a
-- pending/approved/rejected moderation status, one row per completed booking.
-- Nothing has ever written to it and nothing has ever read it. A wellness
-- marketplace with no visible social proof asks a client to book a stranger for
-- an intimate 1:1 on the strength of a self-written bio, which is the single
-- largest thing standing between a visitor and a first booking.
--
-- The reviews themselves need no schema change. What is missing is the
-- *aggregate*: the directory shows every published facilitator on one page, and
-- "4.9 (23)" on each card cannot come from a per-facilitator query without
-- turning one screen into N+1 of them, nor from fetching every approved review
-- on the site and averaging in memory, which is a query that gets slower for
-- the rest of time.
--
-- So the running total lives on the facilitator row and is maintained by a
-- trigger. Two columns rather than a stored average: an average is a float, and
-- re-deriving it from a float on every insert accumulates error, while a sum
-- and a count are exact integers that can always produce the average and can
-- always be recomputed from scratch if they ever look wrong.
alter table public.facilitators
  add column if not exists rating_count int not null default 0 check (rating_count >= 0);

alter table public.facilitators
  add column if not exists rating_sum int not null default 0 check (rating_sum >= 0);

-- ---------------------------------------------------------------------------
-- The trigger
-- ---------------------------------------------------------------------------
-- Only `approved` reviews count. That makes every transition a pair of moves —
-- remove the old contribution, add the new one — rather than a special case per
-- status change, which is what keeps the moderation screen from being able to
-- corrupt the total by taking an unusual path (approve, edit the rating,
-- reject, approve again).
--
-- Written as "subtract what this row used to contribute, add what it
-- contributes now", with a non-approved row contributing zero. Every operation
-- is then the same two statements, and no combination of them can drift.
create or replace function public.facilitator_review_aggregate()
returns trigger
language plpgsql
security definer
-- Explicit, because SECURITY DEFINER without it resolves unqualified names
-- against the caller's search_path.
set search_path = public
as $$
declare
  old_rating int := 0;
  new_rating int := 0;
  old_count  int := 0;
  new_count  int := 0;
begin
  if tg_op in ('UPDATE', 'DELETE') and old.status = 'approved' then
    old_rating := old.rating;
    old_count  := 1;
  end if;

  if tg_op in ('INSERT', 'UPDATE') and new.status = 'approved' then
    new_rating := new.rating;
    new_count  := 1;
  end if;

  -- A review moved between facilitators is not a thing that happens, but
  -- handling it costs one branch and its absence would silently mis-total two
  -- profiles at once.
  if tg_op = 'UPDATE' and old.facilitator_id <> new.facilitator_id then
    update public.facilitators
       set rating_sum = greatest(0, rating_sum - old_rating),
           rating_count = greatest(0, rating_count - old_count)
     where id = old.facilitator_id;

    update public.facilitators
       set rating_sum = rating_sum + new_rating,
           rating_count = rating_count + new_count
     where id = new.facilitator_id;

    return null;
  end if;

  update public.facilitators
     set rating_sum   = greatest(0, rating_sum - old_rating + new_rating),
         rating_count = greatest(0, rating_count - old_count + new_count)
   where id = coalesce(new.facilitator_id, old.facilitator_id);

  return null;
end;
$$;

drop trigger if exists facilitator_reviews_aggregate on public.facilitator_reviews;
create trigger facilitator_reviews_aggregate
  after insert or update or delete on public.facilitator_reviews
  for each row execute function public.facilitator_review_aggregate();

-- Backfill, and the recompute-from-scratch that makes the columns a cache
-- rather than the truth. Safe to re-run at any time; the trigger keeps it
-- correct in between, and this is what to run if it ever does not.
with totals as (
  select facilitator_id, count(*) as n, sum(rating) as s
    from public.facilitator_reviews
   where status = 'approved'
   group by facilitator_id
)
update public.facilitators f
   set rating_count = coalesce(t.n, 0),
       rating_sum   = coalesce(t.s, 0)
  from (select id from public.facilitators) ids
  left join totals t on t.facilitator_id = ids.id
 where f.id = ids.id;

-- The directory's "highest rated" ordering, should it ever want one. Partial,
-- because a facilitator with no reviews has nothing to sort by and should not
-- be ranked below one with a single three-star review.
create index if not exists facilitators_rating_idx
  on public.facilitators (rating_count desc)
  where rating_count > 0;

-- No RLS change. `facilitators` already exposes published rows to anon, and
-- these two columns say exactly what an approved review already says publicly.
