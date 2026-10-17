-- Finance, part 2: money that moves outside the platform.
--
-- 0070 derived everything the platform itself sees. This adds what it cannot:
--
--   finance_accounts      where money sits — bank, GCash, cash box, the PayMongo
--                         balance — with an opening balance.
--   finance_transactions  one row per offline movement:
--     offline_sale         cash / transfer for a class, session, walk-in…; split
--                          like a platform sale and counted in the P&L
--     facilitator_payment  money sent to a facilitator outside a payout batch
--                          (advance, flat fee, historic transfer); reduces what
--                          they are owed, over-payment carries as a credit
--     owner_contribution / owner_withdrawal / loan_in / loan_repayment /
--     transfer / other_in / other_out
--                          balance-sheet movements: not in the P&L, but in the
--                          account balances
--   finance_account_balances  the balance an admin read off the statement at
--                          month end; reconciliation compares it to the books.
--
-- Expenses, reimbursements and payout batches gain an optional account_id so
-- the books know which account each one was paid from.

create table if not exists public.finance_accounts (
  id                       uuid primary key default gen_random_uuid(),
  name                     text not null,
  kind                     text not null check (kind in ('bank', 'ewallet', 'cash', 'paymongo')),
  opening_balance_centavos int not null default 0,
  opening_date             date not null default current_date,
  -- Where PayMongo payouts land, and where facilitator payout batches are paid
  -- from when a batch names no account. At most one of each.
  receives_paymongo        boolean not null default false,
  default_for_payouts      boolean not null default false,
  is_active                boolean not null default true,
  notes                    text,
  created_by               text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

create unique index if not exists finance_accounts_paymongo_uidx on public.finance_accounts ((true)) where receives_paymongo;
create unique index if not exists finance_accounts_payouts_uidx  on public.finance_accounts ((true)) where default_for_payouts;

create table if not exists public.finance_transactions (
  id                         uuid primary key default gen_random_uuid(),
  occurred_on                date not null,
  kind                       text not null check (kind in (
                               'offline_sale', 'facilitator_payment',
                               'owner_contribution', 'owner_withdrawal',
                               'loan_in', 'loan_repayment', 'transfer',
                               'other_in', 'other_out')),
  amount_centavos            int not null check (amount_centavos > 0),
  account_id                 uuid references public.finance_accounts (id),
  -- transfer: the receiving account (account_id is the sender)
  counter_account_id         uuid references public.finance_accounts (id),
  counterparty               text,               -- buyer, lender, owner…
  counterparty_email         text,
  item                       text,               -- offline_sale: what was sold
  category                   text,               -- offline_sale: sales category
  facilitator_id             uuid references public.facilitators (id),
  event_id                   uuid references public.events (id) on delete set null,
  -- offline_sale split, resolved at entry (rule → facilitator rate → Hilom)
  hilom_share_centavos       int,
  facilitator_share_centavos int,
  payment_method             text,
  reference                  text,
  receipt_key                text,
  receipt_name               text,
  notes                      text,
  status                     text not null default 'posted' check (status in ('posted', 'void')),
  void_reason                text,
  created_by                 text,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint finance_transactions_sale_split check (
    kind <> 'offline_sale' or (
      hilom_share_centavos is not null and facilitator_share_centavos is not null
      and hilom_share_centavos + facilitator_share_centavos = amount_centavos)),
  constraint finance_transactions_fac check (kind <> 'facilitator_payment' or facilitator_id is not null),
  constraint finance_transactions_transfer check (
    kind <> 'transfer' or (account_id is not null and counter_account_id is not null and account_id <> counter_account_id))
);

create index if not exists finance_transactions_date_idx on public.finance_transactions (occurred_on);
create index if not exists finance_transactions_fac_idx  on public.finance_transactions (facilitator_id) where facilitator_id is not null;

create table if not exists public.finance_account_balances (
  account_id                 uuid not null references public.finance_accounts (id) on delete cascade,
  period                     date not null check (extract(day from period) = 1),
  statement_balance_centavos int not null,
  note                       text,
  entered_by                 text,
  entered_at                 timestamptz not null default now(),
  primary key (account_id, period)
);

alter table public.expenses            add column if not exists account_id uuid references public.finance_accounts (id);
alter table public.reimbursements      add column if not exists account_id uuid references public.finance_accounts (id);
alter table public.facilitator_payouts add column if not exists account_id uuid references public.finance_accounts (id);

alter table public.finance_accounts         enable row level security;
alter table public.finance_transactions     enable row level security;
alter table public.finance_account_balances enable row level security;

revoke all on public.finance_accounts, public.finance_transactions, public.finance_account_balances from anon, authenticated;
grant select, insert, update, delete on public.finance_accounts, public.finance_transactions, public.finance_account_balances to service_role;
