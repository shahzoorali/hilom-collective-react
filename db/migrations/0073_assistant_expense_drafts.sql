-- Expense drafts prepared by the admin assistant.
--
-- The assistant stays read-only: its draft_expense tool only validates. The
-- latest complete draft of a run is stored here and shown to the admin as a
-- confirmation card; the admin saves it themselves through the Finance
-- expenses endpoint, under their own identity. These columns record what was
-- proposed and what the admin did with it.
alter table public.assistant_runs
  add column if not exists expense_draft        jsonb,
  add column if not exists expense_draft_status text
    check (expense_draft_status in ('pending', 'saved', 'cancelled')),
  add column if not exists expense_id           uuid references public.expenses (id) on delete set null;
