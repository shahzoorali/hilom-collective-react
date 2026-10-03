-- Admin assistant: a read-only database role, and the tables that hold its
-- conversations and an audit trail of every tool call it makes.
--
-- **Read-only is enforced by Postgres, not by the prompt.** The assistant
-- connects as `hilom_assistant_ro`, which holds SELECT and nothing else, and
-- whose every transaction is read-only by default. A model that writes an
-- UPDATE gets `permission denied` / `cannot execute UPDATE in a read-only
-- transaction` — there is no instruction it can be talked out of.
--
-- BYPASSRLS because nearly every table here has RLS enabled with policies for
-- anon/authenticated only; without it the role would see empty tables. Being
-- able to read past RLS is the point of an admin tool. It still cannot write.
--
-- The password is NOT in this file. After applying, set it once:
--   alter role hilom_assistant_ro password '<generated>';
-- and store the matching connection details in Secrets Manager as
-- `hilom/assistant-db`. See docs/admin-assistant.md.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'hilom_assistant_ro') then
    create role hilom_assistant_ro login bypassrls noinherit;
  end if;
end
$$;

alter role hilom_assistant_ro set default_transaction_read_only = on;
alter role hilom_assistant_ro set statement_timeout = '15s';
alter role hilom_assistant_ro set idle_in_transaction_session_timeout = '30s';
alter role hilom_assistant_ro set search_path = public;

grant usage on schema public to hilom_assistant_ro;
grant select on all tables in schema public to hilom_assistant_ro;
-- New tables become readable without a grant per migration. The handler masks
-- secret-looking columns by name (backend/src/lib/assistant/redact.ts), which
-- is the second layer for anything a future table adds.
alter default privileges in schema public grant select on tables to hilom_assistant_ro;

-- Encrypted OAuth tokens and in-flight OAuth state. Ciphertext is useless to an
-- operator and nothing about a facilitator's connection needs these rows that
-- `facilitators` doesn't already say.
revoke all on public.facilitator_integrations from hilom_assistant_ro;
revoke all on public.facilitator_oauth_states from hilom_assistant_ro;

-- ---------------------------------------------------------------------------
-- Conversations and runs.
--
-- A conversation holds the full Bedrock message history (so a follow-up
-- question keeps its context). A run is one question → answer, executed
-- asynchronously by the worker Lambda because a multi-tool answer routinely
-- outlives API Gateway's 30-second ceiling; the browser polls the run row.
-- `steps` is the audit trail: every tool called, with its input (the SQL that
-- ran, the log query, the file read) and a short result summary.
-- ---------------------------------------------------------------------------

create table if not exists public.assistant_conversations (
  id           uuid primary key default gen_random_uuid(),
  actor_source text not null,
  actor_label  text not null,
  title        text not null default 'New conversation',
  messages     jsonb not null default '[]'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.assistant_runs (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.assistant_conversations(id) on delete cascade,
  actor_source    text not null,
  actor_label     text not null,
  question        text not null,
  status          text not null default 'queued'
                    check (status in ('queued', 'running', 'done', 'error')),
  steps           jsonb not null default '[]'::jsonb,
  answer          text,
  error           text,
  input_tokens    integer not null default 0,
  output_tokens   integer not null default 0,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index if not exists assistant_runs_conversation_idx
  on public.assistant_runs (conversation_id, created_at);
create index if not exists assistant_conversations_updated_idx
  on public.assistant_conversations (updated_at desc);

alter table public.assistant_conversations enable row level security;
alter table public.assistant_runs          enable row level security;

revoke all on public.assistant_conversations from anon, authenticated;
revoke all on public.assistant_runs          from anon, authenticated;

grant select, insert, update, delete on public.assistant_conversations to service_role;
grant select, insert, update         on public.assistant_runs          to service_role;
