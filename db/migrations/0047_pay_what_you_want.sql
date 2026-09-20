-- Pay-what-you-want plans: the registrant names the amount.
--
-- Donation-based classes have no list price, but every path from the plan to
-- the receipt assumed one: buildSchedule() refuses a schedule that does not sum
-- to plan.total_centavos, claim_event_seat() re-checks the same equality under
-- the row lock, and the registration snapshot is written from the plan rather
-- than from anything the payer said. A price of "whatever you like" is
-- therefore a schema change, not a UI change.
--
-- **Free is not a pay-what-you-want amount.** A zero-peso seat is a different
-- product with a different flow — no PayMongo session, nothing to confirm, a
-- seat that cannot lapse for non-payment — and reaching it by typing 0 into a
-- donation box would be an accident rather than a decision. So the floor is
-- guarded three times over, deliberately: a table constraint that will not
-- store a non-positive minimum, a check inside the row lock that rejects a
-- non-positive amount whatever the plan says, and validation in the handler
-- for a readable message. The first two are the ones that matter; the third is
-- only there so nobody meets the others.
--
-- **Single payment only.** A variable total spread across an instalment
-- schedule means re-deriving every instalment from the chosen figure, against
-- a deferred trigger that enforces the parts summing to the whole. That is a
-- real feature and this is not it, so the combination is refused by
-- constraint rather than left half-working.

alter table public.event_payment_plans
  add column if not exists is_pay_what_you_want boolean not null default false,
  -- The floor, in centavos. Required when the plan is pay-what-you-want, and
  -- positive — see the note above.
  add column if not exists min_centavos int,
  -- Suggested amounts, shown as buttons beside the free-entry box. Purely a
  -- prompt: anything at or above the floor is accepted whether or not it
  -- appears here. Ordered as entered, because the order is the anchor.
  add column if not exists suggested_centavos int[] not null default '{}';

comment on column public.event_payment_plans.is_pay_what_you_want is
  'The registrant names the amount. total_centavos is then a suggestion only and is '
  'not what gets charged — event_registrations.total_centavos holds what they chose.';
comment on column public.event_payment_plans.min_centavos is
  'Floor for a pay-what-you-want plan, in centavos. Always positive: free is not an option here.';
comment on column public.event_payment_plans.suggested_centavos is
  'Optional preset amounts shown as buttons. Prompts, not limits.';

do $$ begin
  alter table public.event_payment_plans
    add constraint event_payment_plans_pwyw_check check (
      not is_pay_what_you_want
      or (kind = 'full' and min_centavos is not null and min_centavos > 0)
    );
exception when duplicate_object then null;
end $$;

-- Every suggested amount must itself be positive; a 0 button would hand
-- someone the free seat the floor exists to prevent.
do $$ begin
  alter table public.event_payment_plans
    add constraint event_payment_plans_suggested_positive check (
      -- `0 < all(...)` rather than a subquery, which a CHECK cannot contain.
      -- True for the empty array, which is the default and means "no presets".
      suggested_centavos is null or 0 < all(suggested_centavos)
    );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- claim_event_seat gains the chosen amount.
--
-- Dropped and recreated rather than replaced, because CREATE OR REPLACE cannot
-- change a function's argument list. The new parameter carries a default, so a
-- backend deployed before this migration — or after it but before its own
-- rollout finishes — keeps working: it omits the argument, the plan is not
-- pay-what-you-want, and the original fixed-price path runs unchanged.
-- ---------------------------------------------------------------------------

drop function if exists public.claim_event_seat(uuid, uuid, text, text, jsonb, jsonb, int);
create function public.claim_event_seat(
  p_event_id     uuid,
  p_plan_id      uuid,
  p_buyer_email  text,
  p_buyer_sub    text,
  p_registrant   jsonb,   -- {name, email, phone, details}
  p_charges      jsonb,   -- [{seq, label, is_deposit, amount_centavos, due_at}, ...]
  p_hold_minutes int,
  -- What the registrant chose to pay, for a pay-what-you-want plan. Null for
  -- every fixed-price plan, which is also what an older backend sends — so a
  -- deploy that lands after this migration keeps working unchanged.
  p_total_centavos int default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event  public.events%rowtype;
  v_plan   public.event_payment_plans%rowtype;
  v_taken  int;
  v_seat   int;
  v_sum    int;
  v_total  int;
  v_reg_id uuid;
  v_hold   timestamptz := now() + make_interval(mins => p_hold_minutes);
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;

  if not v_event.ticketing_enabled or v_event.status <> 'published' then
    raise exception 'ticketing_closed' using errcode = 'P0001';
  end if;
  if v_event.capacity is null then
    raise exception 'capacity_not_configured' using errcode = 'P0001';
  end if;
  if v_event.registration_opens_at is not null and now() < v_event.registration_opens_at then
    raise exception 'registration_not_open' using errcode = 'P0001';
  end if;
  if v_event.registration_closes_at is not null and now() > v_event.registration_closes_at then
    raise exception 'registration_closed' using errcode = 'P0001';
  end if;

  select * into v_plan from public.event_payment_plans
   where id = p_plan_id and event_id = p_event_id and is_active;
  if not found then
    raise exception 'plan_not_available' using errcode = 'P0001';
  end if;
  if (v_plan.available_from is not null and now() < v_plan.available_from)
     or (v_plan.available_until is not null and now() > v_plan.available_until) then
    raise exception 'plan_not_available' using errcode = 'P0001';
  end if;

  select coalesce(sum((c->>'amount_centavos')::int), 0) into v_sum
    from jsonb_array_elements(p_charges) c;

  -- The whole point of the original check was that passing amounts in must not
  -- become a way to sell a 30,000 retreat for 1 peso. A pay-what-you-want plan
  -- deliberately lets the payer name the figure, so the invariant changes shape
  -- rather than disappearing: the charges must still sum to exactly what the
  -- caller declared, and that declared figure must clear the plan's floor.
  -- Both halves matter. Without the first, the schedule and the recorded total
  -- could disagree; without the second, "you decide" would mean zero.
  if v_plan.is_pay_what_you_want then
    if p_total_centavos is null then
      raise exception 'amount_required' using errcode = 'P0001';
    end if;
    -- Two conditions, not one. The floor comes from the plan, but a plan whose
    -- floor was somehow left null or zero must still not yield a free seat, so
    -- the absolute "> 0" is asserted here as well as by the table constraint.
    -- Free registration is a different product with a different flow; it is not
    -- a pay-what-you-want plan where someone typed nothing.
    if p_total_centavos <= 0 then
      raise exception 'amount_below_minimum' using errcode = 'P0001';
    end if;
    if p_total_centavos < coalesce(v_plan.min_centavos, 1) then
      raise exception 'amount_below_minimum' using errcode = 'P0001';
    end if;
    if v_sum <> p_total_centavos then
      raise exception 'charge_total_mismatch' using errcode = 'P0001';
    end if;
    v_total := p_total_centavos;
  else
    if v_sum <> v_plan.total_centavos then
      raise exception 'charge_total_mismatch' using errcode = 'P0001';
    end if;
    v_total := v_plan.total_centavos;
  end if;

  -- Lapsed holds, released inline. The seat index cannot read hold_expires_at
  -- (a partial index predicate must be immutable), so without this an abandoned
  -- checkout keeps its number until the sweep next runs — the same inline
  -- release that POST /bookings does before generating slots.
  update public.event_registrations
     set status = 'expired'
   where event_id = p_event_id
     and status = 'pending_payment'
     and hold_expires_at < now();

  select count(*) into v_taken
    from public.event_registrations
   where event_id = p_event_id
     and status in ('pending_payment', 'confirmed');

  if v_taken >= v_event.capacity then
    raise exception 'sold_out' using errcode = 'P0001';
  end if;

  -- Lowest free number, so a released seat 3 is resold as seat 3 rather than
  -- the roster growing gaps as holds come and go.
  select min(g) into v_seat
    from generate_series(1, v_event.capacity) g
   where not exists (
     select 1 from public.event_registrations r
      where r.event_id = p_event_id
        and r.seat_no = g
        and r.status in ('pending_payment', 'confirmed'));

  insert into public.event_registrations (
    event_id, plan_id, buyer_email, buyer_cognito_sub,
    registrant_name, registrant_email, registrant_phone, registrant_details,
    status, seat_no, plan_name, plan_kind, total_centavos, currency, hold_expires_at
  ) values (
    p_event_id, p_plan_id, lower(p_buyer_email), p_buyer_sub,
    p_registrant->>'name', lower(p_registrant->>'email'), p_registrant->>'phone',
    coalesce(p_registrant->'details', '{}'::jsonb),
    'pending_payment', v_seat, v_plan.name, v_plan.kind,
    -- v_total, not v_plan.total_centavos: for a pay-what-you-want plan the
    -- snapshot must record what this person actually agreed to, which is the
    -- number every receipt, balance and roster figure is derived from.
    v_total, v_plan.currency, v_hold
  ) returning id into v_reg_id;

  insert into public.registration_charges (
    registration_id, event_id, seq, label, is_deposit,
    amount_centavos, currency, due_at, status
  )
  select v_reg_id,
         p_event_id,
         (c->>'seq')::int,
         c->>'label',
         coalesce((c->>'is_deposit')::boolean, false),
         (c->>'amount_centavos')::int,
         v_plan.currency,
         (c->>'due_at')::timestamptz,
         -- The deposit is payable now; everything else waits its turn, so that
         -- "pay the next instalment" has exactly one answer at any moment.
         case when coalesce((c->>'is_deposit')::boolean, false)
              then 'awaiting_payment'::public.charge_status
              else 'scheduled'::public.charge_status
         end
    from jsonb_array_elements(p_charges) c;

  return v_reg_id;
end;
$$;

revoke all on function public.claim_event_seat(uuid, uuid, text, text, jsonb, jsonb, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_event_seat(uuid, uuid, text, text, jsonb, jsonb, int, int)
  to service_role;

-- ---------------------------------------------------------------------------
-- replace_event_plans (0017) learns the new columns.
--
-- Only on the insert and on the unlocked update. A plan somebody has already
-- registered against stays restricted to cosmetics and availability, exactly as
-- 0017 decided: turning a fixed price into "name your own" is a pricing change,
-- and the whole point of that lock is that terms people signed up under do not
-- get rewritten underneath them.
-- ---------------------------------------------------------------------------

create or replace function public.replace_event_plans(
  p_event_id uuid,
  p_plans    jsonb
) returns setof uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_plan     jsonb;
  v_plan_id  uuid;
  v_locked   boolean;
  v_keep     uuid[] := '{}';
begin
  -- Same lock claim_event_seat() takes, for the same reason: an admin rewriting
  -- the plans while someone is claiming a seat against them must not interleave.
  perform 1 from public.events where id = p_event_id for update;
  if not found then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;

  for v_plan in select * from jsonb_array_elements(p_plans)
  loop
    v_plan_id := nullif(v_plan->>'id', '')::uuid;

    if v_plan_id is null then
      insert into public.event_payment_plans (
        event_id, name, description, kind, total_centavos, currency,
        available_from, available_until, is_active, sort_order,
        is_pay_what_you_want, min_centavos, suggested_centavos
      ) values (
        p_event_id,
        v_plan->>'name',
        v_plan->>'description',
        (v_plan->>'kind')::public.payment_plan_kind,
        (v_plan->>'total_centavos')::int,
        coalesce(v_plan->>'currency', 'PHP'),
        (v_plan->>'available_from')::timestamptz,
        (v_plan->>'available_until')::timestamptz,
        coalesce((v_plan->>'is_active')::boolean, true),
        coalesce((v_plan->>'sort_order')::int, 0),
        coalesce((v_plan->>'is_pay_what_you_want')::boolean, false),
        nullif(v_plan->>'min_centavos', '')::int,
        coalesce(
          (select array_agg(value::int order by ordinality)
             from jsonb_array_elements_text(coalesce(v_plan->'suggested_centavos','[]'::jsonb))
                  with ordinality),
          '{}'::int[])
      ) returning id into v_plan_id;
      v_locked := false;
    else
      -- Belongs to this event? A plan id from another event would otherwise be
      -- editable by anyone who could guess it.
      perform 1 from public.event_payment_plans
        where id = v_plan_id and event_id = p_event_id;
      if not found then
        raise exception 'plan_not_found' using errcode = 'P0002';
      end if;

      select exists (
        select 1 from public.event_registrations
         where plan_id = v_plan_id
           and status in ('pending_payment', 'confirmed', 'completed')
      ) into v_locked;

      if v_locked then
        -- Cosmetics and availability only.
        update public.event_payment_plans
           set name            = v_plan->>'name',
               description     = v_plan->>'description',
               available_from  = (v_plan->>'available_from')::timestamptz,
               available_until = (v_plan->>'available_until')::timestamptz,
               is_active       = coalesce((v_plan->>'is_active')::boolean, true),
               sort_order      = coalesce((v_plan->>'sort_order')::int, 0)
         where id = v_plan_id;
      else
        update public.event_payment_plans
           set name            = v_plan->>'name',
               description     = v_plan->>'description',
               kind            = (v_plan->>'kind')::public.payment_plan_kind,
               total_centavos  = (v_plan->>'total_centavos')::int,
               currency        = coalesce(v_plan->>'currency', 'PHP'),
               available_from  = (v_plan->>'available_from')::timestamptz,
               available_until = (v_plan->>'available_until')::timestamptz,
               is_active       = coalesce((v_plan->>'is_active')::boolean, true),
               sort_order      = coalesce((v_plan->>'sort_order')::int, 0),
               is_pay_what_you_want = coalesce((v_plan->>'is_pay_what_you_want')::boolean, false),
               min_centavos    = nullif(v_plan->>'min_centavos', '')::int,
               suggested_centavos = coalesce(
                 (select array_agg(value::int order by ordinality)
                    from jsonb_array_elements_text(coalesce(v_plan->'suggested_centavos','[]'::jsonb))
                         with ordinality),
                 '{}'::int[])
         where id = v_plan_id;
      end if;
    end if;

    -- The schedule is rewritten wholesale, but only for a plan nobody has
    -- signed. Delete-then-insert in one statement pair is safe precisely
    -- because the totals trigger is deferred to commit.
    if not v_locked then
      delete from public.event_plan_installments where plan_id = v_plan_id;

      insert into public.event_plan_installments (
        plan_id, seq, label, amount_centavos, due_at, due_offset_days, is_deposit
      )
      select v_plan_id,
             (i->>'seq')::int,
             i->>'label',
             (i->>'amount_centavos')::int,
             (i->>'due_at')::timestamptz,
             (i->>'due_offset_days')::int,
             coalesce((i->>'is_deposit')::boolean, false)
        from jsonb_array_elements(coalesce(v_plan->'installments', '[]'::jsonb)) i;
    end if;

    v_keep := v_keep || v_plan_id;
  end loop;

  -- Plans the admin removed from the payload. One with registrations is
  -- deactivated rather than deleted — the FK from event_registrations is
  -- ON DELETE RESTRICT, and a plan someone bought is part of the record of what
  -- they bought.
  update public.event_payment_plans
     set is_active = false
   where event_id = p_event_id
     and not (id = any (v_keep))
     and exists (select 1 from public.event_registrations where plan_id = event_payment_plans.id);

  delete from public.event_payment_plans
   where event_id = p_event_id
     and not (id = any (v_keep))
     and not exists (select 1 from public.event_registrations where plan_id = event_payment_plans.id);

  return query select unnest(v_keep);
end;
$$;
