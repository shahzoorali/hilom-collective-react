-- Promo codes for event tickets (0054, Phase 3).
--
-- Promo codes (0044) only ever applied to course checkout. This lets the same
-- codes discount an event registration, under three limits:
--
--   * Opt-in per code (`applies_to_events`, default false), so none of the
--     course codes already handed out start discounting retreats.
--   * Full-payment plans only. An instalment plan would need the discount
--     spread across its schedule, and a pay-what-you-want plan already lets
--     the payer set the price.
--   * The database computes the discount itself from the code row. The
--     backend passes only which code was used, never the amount.
--
-- The discount comes off the ticket price before the fee split
-- (registration-fulfillment.ts splits the charge that was actually paid),
-- so Hilom and the host share it in proportion to the commission.

alter table public.promo_codes
  add column if not exists applies_to_events boolean not null default false;

comment on column public.promo_codes.applies_to_events is
  'Whether this code also works on event tickets (0062). Off by default so '
  'codes issued for courses before events accepted codes stay course-only.';

alter table public.event_registrations
  -- ON DELETE SET NULL, like orders.promo_code_id (0044): deleting a code must
  -- never touch the record of what someone paid.
  add column if not exists promo_code_id uuid
    references public.promo_codes(id) on delete set null,
  add column if not exists discount_centavos int not null default 0
    check (discount_centavos >= 0);

comment on column public.event_registrations.discount_centavos is
  'What a promo code took off the plan price at registration. total_centavos '
  'is already net of this; it is recorded so the discount stays visible.';

drop function if exists public.claim_event_seat(uuid, uuid, text, text, jsonb, jsonb, int, int);

create function public.claim_event_seat(
  p_event_id       uuid,
  p_plan_id        uuid,
  p_buyer_email    text,
  p_buyer_sub      text,
  p_registrant     jsonb,
  p_charges        jsonb,
  p_hold_minutes   int,
  p_total_centavos int default null,
  -- Only the code, never an amount (see the header note).
  p_promo_code_id  uuid default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event    public.events%rowtype;
  v_plan     public.event_payment_plans%rowtype;
  v_promo    public.promo_codes%rowtype;
  v_taken    int;
  v_seat     int;
  v_sum      int;
  v_total    int;
  v_discount int := 0;
  v_reg_id   uuid;
  v_hold     timestamptz := now() + make_interval(mins => p_hold_minutes);
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

  if v_plan.is_pay_what_you_want then
    if p_promo_code_id is not null then
      raise exception 'promo_not_applicable' using errcode = 'P0001';
    end if;
    if p_total_centavos is null then
      raise exception 'amount_required' using errcode = 'P0001';
    end if;
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
    if p_promo_code_id is not null then
      if v_plan.kind <> 'full' then
        raise exception 'promo_not_applicable' using errcode = 'P0001';
      end if;
      select * into v_promo from public.promo_codes where id = p_promo_code_id;
      if not found or not v_promo.is_active or not v_promo.applies_to_events
         or (v_promo.expires_at is not null and v_promo.expires_at < now()) then
        raise exception 'promo_invalid' using errcode = 'P0001';
      end if;
      -- The same arithmetic as lib/promo-codes.ts: percent rounds to the
      -- nearest centavo, a fixed amount never exceeds the price.
      v_discount := case
        when v_promo.discount_type = 'percent'
          then round(v_plan.total_centavos * v_promo.discount_value / 100.0)::int
        else least(v_promo.discount_value, v_plan.total_centavos)
      end;
      -- A charge must be more than zero (0016), so a code that makes the
      -- ticket free is refused rather than producing an unpayable charge.
      if v_plan.total_centavos - v_discount <= 0 then
        raise exception 'promo_makes_free' using errcode = 'P0001';
      end if;
    end if;
    v_total := v_plan.total_centavos - v_discount;
    if v_sum <> v_total then
      raise exception 'charge_total_mismatch' using errcode = 'P0001';
    end if;
  end if;

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
    status, seat_no, plan_name, plan_kind, total_centavos, currency, hold_expires_at,
    promo_code_id, discount_centavos
  ) values (
    p_event_id, p_plan_id, lower(p_buyer_email), p_buyer_sub,
    p_registrant->>'name', lower(p_registrant->>'email'), p_registrant->>'phone',
    coalesce(p_registrant->'details', '{}'::jsonb),
    'pending_payment', v_seat, v_plan.name, v_plan.kind,
    v_total, v_plan.currency, v_hold,
    case when v_discount > 0 then p_promo_code_id end, v_discount
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
         case when coalesce((c->>'is_deposit')::boolean, false)
              then 'awaiting_payment'::public.charge_status
              else 'scheduled'::public.charge_status
         end
    from jsonb_array_elements(p_charges) c;

  return v_reg_id;
end;
$$;

revoke all on function public.claim_event_seat(uuid, uuid, text, text, jsonb, jsonb, int, int, uuid)
  from public, anon, authenticated;
grant execute on function public.claim_event_seat(uuid, uuid, text, text, jsonb, jsonb, int, int, uuid)
  to service_role;
