-- Ticketed events, part 2 of 2: instalment reminders, the admin audit log, and
-- the plan-write RPC that 0016's deferred constraint trigger requires.

-- ---------------------------------------------------------------------------
-- Instalment reminders
-- ---------------------------------------------------------------------------
-- 0015_booking_reminders.sql chose a single nullable column and said exactly
-- when to revisit that: "If a second tier is ever added, that is the point to
-- promote this to a table — not before." An instalment schedule has four tiers
-- per charge by definition and up to four charges per registration, so the
-- column form was never on the table here.
--
-- The unique constraint below is a stronger idempotency guard than the
-- claim-then-stamp idiom in booking-sweep.ts:134-179: **the claim is the
-- insert**. Two overlapping sweep invocations cannot both send, and the loser
-- gets a plain 23505 rather than a filtered update that quietly matched
-- nothing. On send failure the sweep deletes its row so the next pass retries —
-- same accepted narrow window as 0015 (a crash between send and rollback can
-- duplicate a reminder; that is preferred over losing one, because a lost
-- reminder costs someone their seat).

-- due_in_7d  — a week out, while there is still time to move money
-- due_today  — the due date itself
-- overdue_3d — first chase
-- overdue_7d — final notice, and the point the admin queue gets involved
do $$ begin
  create type public.charge_reminder_tier as enum (
    'due_in_7d',
    'due_today',
    'overdue_3d',
    'overdue_7d'
  );
exception when duplicate_object then null;
end $$;

create table if not exists public.registration_charge_reminders (
  id        uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.registration_charges(id) on delete cascade,
  tier      public.charge_reminder_tier not null,
  sent_at   timestamptz not null default now(),
  -- The address it actually went to, snapshotted. "Did we remind them?" must
  -- stay answerable after the attendee is transferred or an email changes.
  sent_to   text
);

-- The idempotency guard. One reminder per charge per tier, ever.
create unique index if not exists registration_charge_reminders_unique_idx
  on public.registration_charge_reminders (charge_id, tier);

-- The reminder history shown on the admin's registration detail panel.
create index if not exists registration_charge_reminders_charge_idx
  on public.registration_charge_reminders (charge_id, sent_at desc);

-- ---------------------------------------------------------------------------
-- Admin audit log
-- ---------------------------------------------------------------------------
-- Append-only by grant: service_role gets select and insert and nothing else,
-- so nothing in the application can rewrite history even by mistake. There is
-- no updated_at and no trigger, deliberately — a row here is a fact about a
-- moment, and a mutable audit log is not an audit log.
--
-- On the actor. These endpoints authorize with the shared admin key
-- (isAuthorizedAdmin, backend/src/lib/http.ts:83), which identifies an office,
-- not a person. That is a deliberate decision and it bounds what actor_label
-- can honestly mean, so actor_source records which credential was used and no
-- reader is misled:
--
--   shared_key — actor_label is a name the operator typed into the admin UI.
--                It is an attestation, corroborated only by source_ip. Anyone
--                holding the key can type any name.
--   cognito    — actor_label is a verified email and actor_sub a verified
--                subject. Available if these handlers later move to
--                isAdminCaller (http.ts:123), which already accepts both
--                credentials; http.ts's own comment calls migrating the older
--                endpoints follow-up work.
--   system     — the actor is not an admin at all: a registrant editing their
--                own attendee details, or the sweep flagging an overdue charge.
--
-- Recording the weaker form is still worth doing. It turns "someone marked this
-- ₱8,333 paid" into "Rina's session marked this paid at 14:02 from
-- 112.198.x.x", which is what internal reconciliation actually needs. It is not
-- evidence in a dispute, and the admin UI labels it as such.
do $$ begin
  create type public.audit_actor_source as enum ('shared_key', 'cognito', 'system');
exception when duplicate_object then null;
end $$;

create table if not exists public.admin_audit_log (
  id           uuid primary key default gen_random_uuid(),

  actor_source public.audit_actor_source not null,
  actor_label  text not null,
  actor_sub    text,
  source_ip    text,
  user_agent   text,

  -- Dotted, stable and greppable: 'charge.mark_paid_offline', 'charge.waive',
  -- 'charge.void', 'registration.cancel', 'registration.price_override',
  -- 'registration.transferred', 'event.ticketing_updated',
  -- 'event.roster_exported', 'plan.replaced'.
  action       text not null,
  target_table text not null,
  target_id    uuid,
  -- Denormalized so the per-event audit view is one indexed read.
  event_id     uuid references public.events(id) on delete set null,

  -- The money this action moved, where it moved any. Null for a config edit —
  -- which is what makes the money-only index below partial, and the "show me
  -- everything that touched a number" view cheap.
  amount_centavos int,
  currency        text,

  before jsonb,
  after  jsonb,
  note   text,

  created_at timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);

create index if not exists admin_audit_log_target_idx
  on public.admin_audit_log (target_table, target_id, created_at desc);

create index if not exists admin_audit_log_event_idx
  on public.admin_audit_log (event_id, created_at desc);

-- Every action that moved money, newest first.
create index if not exists admin_audit_log_money_idx
  on public.admin_audit_log (created_at desc)
  where amount_centavos is not null;

-- ---------------------------------------------------------------------------
-- replace_event_plans — the only supported way to write a plan schedule
-- ---------------------------------------------------------------------------
-- 0016's totals trigger is DEFERRABLE INITIALLY DEFERRED, and every PostgREST
-- call is its own transaction. Writing instalments one row at a time through
-- supabase-js therefore fails on the first insert, because a one-row schedule
-- never sums to the plan total. This function does the whole set in a single
-- statement so the trigger fires once, at commit, against a complete schedule.
--
-- It also enforces the rule that a plan is a contract once someone has signed
-- it. A plan with registrations attached may have its name, description,
-- sort order and active flag edited — cosmetics and availability — but not its
-- kind, total or instalment schedule; those would restate what a registrant
-- already agreed to. The admin UI surfaces "3 people are on this plan" and
-- offers to create a new one instead. Registrations carry their own snapshots
-- either way (0016), so this is belt and braces on top of that.
--
-- p_plans shape:
--   [{ id?, name, description?, kind, total_centavos, currency?,
--      available_from?, available_until?, is_active?, sort_order?,
--      installments: [{ seq, label, amount_centavos, due_at?,
--                       due_offset_days?, is_deposit? }] }]
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
        available_from, available_until, is_active, sort_order
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
        coalesce((v_plan->>'sort_order')::int, 0)
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
               sort_order      = coalesce((v_plan->>'sort_order')::int, 0)
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

revoke all on function public.replace_event_plans(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_event_plans(uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- RLS — both tables are backend-only.
--
-- Reminders reveal who is behind on payments; the audit log reveals every
-- money movement on the platform. Neither is ever read from the browser
-- directly.
-- ---------------------------------------------------------------------------
alter table public.registration_charge_reminders enable row level security;
revoke all on public.registration_charge_reminders from anon, authenticated;
-- Delete is granted because the sweep rolls a claim back when the send fails.
grant select, insert, delete on public.registration_charge_reminders to service_role;

alter table public.admin_audit_log enable row level security;
revoke all on public.admin_audit_log from anon, authenticated;

-- Append-only is enforced here, by grant, not by convention in the handler.
--
-- The revoke is not redundant with the narrow grant below it. Supabase sets
-- default privileges on the public schema, so a newly created table arrives
-- with rights service_role was never granted by this file — verified against
-- the live database, where the audit table came up holding TRUNCATE. Granting
-- only select and insert does not take that away; revoking does. Without this
-- line the whole log is one statement away from being erased by the same
-- credential that writes it.
revoke update, delete, truncate on public.admin_audit_log from service_role;
grant select, insert on public.admin_audit_log to service_role;
