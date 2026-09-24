-- Pay-what-you-want for group classes, mirroring 0047 for events.
--
-- Same rules as the event version: the floor is always positive (a free class
-- is the price-0 path, not a PWYW seat where someone typed 0), and the chosen
-- amount is checked inside the session row lock. Settings snapshot from class
-- to session at scheduling, like price already does.

alter table public.facilitator_classes
  add column if not exists is_pay_what_you_want boolean not null default false,
  add column if not exists min_centavos int,
  add column if not exists suggested_centavos int[] not null default '{}';

alter table public.facilitator_class_sessions
  add column if not exists is_pay_what_you_want boolean not null default false,
  add column if not exists min_centavos int,
  add column if not exists suggested_centavos int[] not null default '{}';

do $$ begin
  alter table public.facilitator_classes
    add constraint facilitator_classes_pwyw_check check (
      not is_pay_what_you_want or (min_centavos is not null and min_centavos > 0)
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.facilitator_classes
    add constraint facilitator_classes_suggested_positive check (
      suggested_centavos is null or 0 < all(suggested_centavos)
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.facilitator_class_sessions
    add constraint class_sessions_pwyw_check check (
      not is_pay_what_you_want or (min_centavos is not null and min_centavos > 0)
    );
exception when duplicate_object then null;
end $$;

do $$ begin
  alter table public.facilitator_class_sessions
    add constraint class_sessions_suggested_positive check (
      suggested_centavos is null or 0 < all(suggested_centavos)
    );
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- claim_class_seat gains the chosen amount. Dropped and recreated because the
-- argument list changes; the new parameter defaults to null so a backend
-- deployed before this migration keeps working on fixed-price sessions.
-- ---------------------------------------------------------------------------

drop function if exists public.claim_class_seat(uuid, text, text, text, text, int);
drop function if exists public.claim_class_seat(uuid, text, text, text, text, int, int);
create function public.claim_class_seat(
  p_session_id     uuid,
  p_client_email   text,
  p_client_sub     text,
  p_client_name    text,
  p_client_notes   text,
  p_hold_minutes   int,
  p_price_centavos int default null
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.facilitator_class_sessions%rowtype;
  v_taken   int;
  v_seat    int;
  v_price   int;
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

  if v_session.is_pay_what_you_want then
    if p_price_centavos is null then
      raise exception 'amount_required' using errcode = 'P0001';
    end if;
    -- The absolute "> 0" is asserted as well as the floor, so a session whose
    -- floor were somehow null still cannot yield a free seat.
    if p_price_centavos < greatest(coalesce(v_session.min_centavos, 1), 1) or p_price_centavos > 100000000 then
      raise exception 'amount_below_minimum' using errcode = 'P0001';
    end if;
    v_price := p_price_centavos;
  else
    v_price := v_session.price_centavos;
  end if;

  update public.class_registrations
     set status = 'expired'
   where session_id = p_session_id
     and status = 'pending_payment'
     and hold_expires_at < now();

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
    v_price, v_session.currency, v_hold
  ) returning id into v_reg_id;

  return v_reg_id;
end;
$$;

revoke all on function public.claim_class_seat(uuid, text, text, text, text, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_class_seat(uuid, text, text, text, text, int, int)
  to service_role;
