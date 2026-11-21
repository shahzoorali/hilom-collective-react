-- Late payments: money that arrives after its hold has lapsed.
--
-- Incident (Nov 20): a class seat was held for 20 minutes; the sweep expired
-- it; nine hours later the buyer paid the still-open PayMongo checkout. The
-- webhook's confirm matched no `pending_payment` row, reported
-- "already_confirmed", and the ₱900 was attached to nothing. Nobody was told.
--
-- Three layers now:
--   1. The sweep expires the PayMongo checkout session when it lapses a hold,
--      so a stale QR can no longer take money (code, not schema).
--   2. A payment that lands on an expired class seat or event place re-claims
--      it if there is still room (the revive_* functions below), and is then
--      confirmed exactly as an on-time payment would be.
--   3. Anything that cannot be revived — a deleted booking hold, a full class,
--      a session that has started — is written here and emailed to admin, to
--      be refunded or rebooked by hand. Revived ones are written here too, so
--      there is one place to see every late payment.

create table if not exists public.late_payments (
  id                   uuid primary key default gen_random_uuid(),
  kind                 text not null check (kind in ('booking', 'class', 'event_registration')),
  source_id            uuid not null,
  paymongo_payment_id  text not null unique,
  amount_centavos      integer,
  currency             text not null default 'PHP',
  client_email         text,
  outcome              text not null check (outcome in ('revived', 'needs_action')),
  detail               text,
  resolved_at          timestamptz,
  resolved_by          text,
  resolution_note      text,
  created_at           timestamptz not null default now()
);

create index if not exists late_payments_open_idx
  on public.late_payments (created_at desc)
  where outcome = 'needs_action' and resolved_at is null;

alter table public.late_payments enable row level security;
revoke all on public.late_payments from anon, authenticated;
grant select, insert, update on public.late_payments to service_role;

-- Re-claims an expired class seat for a payment that arrived late. Same lock
-- and capacity rule as claim_class_seat. Returns:
--   'revived'             the row is pending_payment again with a seat number
--   'not_expired'         nothing to do (already confirmed, cancelled, ...)
--   'session_unavailable' cancelled, completed, or already started
--   'full'                no seat left
create or replace function public.revive_class_registration(p_registration_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg     public.class_registrations%rowtype;
  v_session public.facilitator_class_sessions%rowtype;
  v_taken   int;
  v_seat    int;
begin
  select * into v_reg from public.class_registrations where id = p_registration_id;
  if not found then
    return 'not_found';
  end if;

  select * into v_session
    from public.facilitator_class_sessions
   where id = v_reg.session_id
     for update;

  -- Re-read under the session lock: a concurrent delivery may have revived it.
  select * into v_reg from public.class_registrations where id = p_registration_id;
  if v_reg.status <> 'expired' then
    return 'not_expired';
  end if;
  if v_session.status <> 'scheduled' or v_session.starts_at <= now() then
    return 'session_unavailable';
  end if;

  update public.class_registrations
     set status = 'expired'
   where session_id = v_reg.session_id
     and status = 'pending_payment'
     and hold_expires_at < now();

  select count(*) into v_taken
    from public.class_registrations
   where session_id = v_reg.session_id
     and status in ('pending_payment', 'confirmed');
  if v_taken >= v_session.capacity then
    return 'full';
  end if;

  select min(g) into v_seat
    from generate_series(1, v_session.capacity) g
   where not exists (
     select 1 from public.class_registrations r
      where r.session_id = v_reg.session_id
        and r.seat_no = g
        and r.status in ('pending_payment', 'confirmed'));

  update public.class_registrations
     set status = 'pending_payment',
         seat_no = v_seat,
         hold_expires_at = now() + interval '10 minutes'
   where id = p_registration_id;

  return 'revived';
end;
$$;

revoke all on function public.revive_class_registration(uuid) from public, anon, authenticated;
grant execute on function public.revive_class_registration(uuid) to service_role;

-- Same for an event place. A buddy-rate buyer (0078) brings their partner
-- back too, so both places must be free. Registration windows and plan
-- availability are deliberately not re-checked: the person paid while the
-- checkout was open, and turning them away over a closed window would only
-- create a refund. Event must still be published and not yet started.
create or replace function public.revive_event_registration(p_registration_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_reg     public.event_registrations%rowtype;
  v_event   public.events%rowtype;
  v_taken   int;
  v_need    int;
  v_seat    int;
  v_row     record;
begin
  select * into v_reg from public.event_registrations where id = p_registration_id;
  if not found then
    return 'not_found';
  end if;

  select * into v_event from public.events where id = v_reg.event_id for update;

  select * into v_reg from public.event_registrations where id = p_registration_id;
  if v_reg.status <> 'expired' then
    return 'not_expired';
  end if;
  if v_event.status <> 'published' or v_event.starts_at <= now() then
    return 'event_unavailable';
  end if;

  update public.event_registrations
     set status = 'expired'
   where event_id = v_reg.event_id
     and status = 'pending_payment'
     and hold_expires_at < now();

  select 1 + count(*) into v_need
    from public.event_registrations
   where covered_by_registration_id = p_registration_id
     and status = 'expired';

  select count(*) into v_taken
    from public.event_registrations
   where event_id = v_reg.event_id
     and status in ('pending_payment', 'confirmed');
  if v_event.capacity is not null and v_taken + v_need > v_event.capacity then
    return 'full';
  end if;

  for v_row in
    select id from public.event_registrations
     where id = p_registration_id
        or (covered_by_registration_id = p_registration_id and status = 'expired')
     order by (id = p_registration_id) desc
  loop
    v_seat := null;
    if v_event.capacity is not null then
      select min(g) into v_seat
        from generate_series(1, v_event.capacity) g
       where not exists (
         select 1 from public.event_registrations r
          where r.event_id = v_reg.event_id
            and r.seat_no = g
            and r.status in ('pending_payment', 'confirmed'));
    end if;

    update public.event_registrations
       set status = 'pending_payment',
           seat_no = coalesce(v_seat, seat_no),
           hold_expires_at = now() + interval '10 minutes'
     where id = v_row.id;
  end loop;

  return 'revived';
end;
$$;

revoke all on function public.revive_event_registration(uuid) from public, anon, authenticated;
grant execute on function public.revive_event_registration(uuid) to service_role;
