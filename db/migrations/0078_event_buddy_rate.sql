-- Buddy rate: two people, one checkout (Canny: "Additional Feature:
-- Pair-Seat Bookings"). Events only, exactly two people, full payment only;
-- the pair price is whatever the admin types on the plan.
--
-- Shape: the buyer's registration carries the one charge for the whole pair
-- price, so a PayMongo payment still maps to exactly one charge and Finance
-- sees one sale. The partner gets a registration of their own (their own row
-- on the roster, their own seat, their own confirmation email) with no charges
-- and `covered_by_registration_id` pointing at the buyer's. It is confirmed
-- when the buyer's payment clears and expires with the buyer's hold.
--
-- The partner needs no Hilom account: their name and email are on their row.

alter table public.event_payment_plans
  add column if not exists seats int not null default 1 check (seats in (1, 2));

alter table public.event_payment_plans drop constraint if exists event_payment_plans_buddy_full_only;
alter table public.event_payment_plans add constraint event_payment_plans_buddy_full_only
  check (seats = 1 or (kind = 'full' and not is_pay_what_you_want));

alter table public.event_registrations
  add column if not exists covered_by_registration_id uuid
    references public.event_registrations(id) on delete set null;

create index if not exists event_registrations_covered_by_idx
  on public.event_registrations (covered_by_registration_id)
  where covered_by_registration_id is not null;

-- Claims both seats or neither. The buyer's seat goes through claim_event_seat
-- unchanged (all its checks: open, plan, price, capacity); the partner's seat
-- is then taken under the same event row lock, in the same transaction, so a
-- failure on the second seat rolls back the first.
create or replace function public.claim_event_pair(
  p_event_id     uuid,
  p_plan_id      uuid,
  p_buyer_email  text,
  p_buyer_sub    text,
  p_registrant   jsonb,
  p_partner      jsonb,
  p_charges      jsonb,
  p_hold_minutes int
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event   public.events%rowtype;
  v_plan    public.event_payment_plans%rowtype;
  v_lead    public.event_registrations%rowtype;
  v_lead_id uuid;
  v_taken   int;
  v_seat    int;
begin
  select * into v_event from public.events where id = p_event_id for update;
  if not found then
    raise exception 'event_not_found' using errcode = 'P0002';
  end if;

  select * into v_plan from public.event_payment_plans where id = p_plan_id and event_id = p_event_id;
  if not found or v_plan.seats <> 2 then
    raise exception 'plan_not_available' using errcode = 'P0001';
  end if;
  if coalesce(p_partner->>'name', '') = '' or coalesce(p_partner->>'email', '') = '' then
    raise exception 'partner_required' using errcode = 'P0001';
  end if;
  if lower(p_partner->>'email') = lower(p_registrant->>'email') then
    raise exception 'partner_same_person' using errcode = 'P0001';
  end if;

  -- Two seats must be free, not one. Lapsed holds are released first, the
  -- same as claim_event_seat does.
  update public.event_registrations
     set status = 'expired'
   where event_id = p_event_id and status = 'pending_payment' and hold_expires_at < now();
  select count(*) into v_taken
    from public.event_registrations
   where event_id = p_event_id and status in ('pending_payment', 'confirmed');
  if v_event.capacity is not null and v_taken + 2 > v_event.capacity then
    raise exception 'sold_out' using errcode = 'P0001';
  end if;

  v_lead_id := public.claim_event_seat(
    p_event_id, p_plan_id, p_buyer_email, p_buyer_sub, p_registrant, p_charges, p_hold_minutes, null, null
  );
  select * into v_lead from public.event_registrations where id = v_lead_id;

  select min(g) into v_seat
    from generate_series(1, v_event.capacity) g
   where not exists (
     select 1 from public.event_registrations r
      where r.event_id = p_event_id and r.seat_no = g and r.status in ('pending_payment', 'confirmed'));
  if v_seat is null then
    raise exception 'sold_out' using errcode = 'P0001';
  end if;

  insert into public.event_registrations (
    event_id, plan_id, buyer_email, buyer_cognito_sub,
    registrant_name, registrant_email, registrant_phone, registrant_details,
    status, seat_no, plan_name, plan_kind, total_centavos, currency, hold_expires_at,
    covered_by_registration_id
  ) values (
    p_event_id, p_plan_id, lower(p_buyer_email), p_buyer_sub,
    p_partner->>'name', lower(p_partner->>'email'), p_partner->>'phone',
    coalesce(p_partner->'details', '{}'::jsonb),
    'pending_payment', v_seat, v_lead.plan_name, v_lead.plan_kind, 0, v_lead.currency, v_lead.hold_expires_at,
    v_lead_id
  );

  return v_lead_id;
end;
$$;

revoke all on function public.claim_event_pair(uuid, uuid, text, text, jsonb, jsonb, jsonb, int) from public, anon, authenticated;
grant execute on function public.claim_event_pair(uuid, uuid, text, text, jsonb, jsonb, jsonb, int) to service_role;

-- replace_event_plans, redefined from 0047 to also save `seats` (on new plans
-- and on plans nobody has registered for yet; a sold plan stays locked).
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
        is_pay_what_you_want, min_centavos, suggested_centavos, seats
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
          '{}'::int[]),
        coalesce((v_plan->>'seats')::int, 1)
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
                 '{}'::int[]),
               seats           = coalesce((v_plan->>'seats')::int, 1)
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
