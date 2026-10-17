-- Payment acknowledgment receipts (the "PAYMENT ACKNOWLEDGMENT RECEIPT" Hilom
-- gives a facilitator when it pays them), issued from Admin → Finance.
--
-- One row per issued receipt. `data` is the exact content rendered, so the PDF
-- can be re-rendered identically and the receipt stays true even if the
-- facilitator's name or the payments are edited later. The generated PDF and,
-- once returned, the copy the facilitator signed live in the private finance
-- receipts bucket.
--
-- Numbering is HC-AR-<year>-<seq>, sequential per year; the unique index makes
-- two admins issuing at once collide rather than share a number (the handler
-- retries).

create table if not exists public.payment_acknowledgments (
  id               uuid primary key default gen_random_uuid(),
  receipt_no       text not null unique,
  year             int  not null,
  seq              int  not null,
  facilitator_id   uuid references public.facilitators (id),
  issue_date       date not null,
  total_centavos   int  not null check (total_centavos > 0),
  data             jsonb not null,
  transaction_ids  uuid[] not null default '{}',
  payout_ids       uuid[] not null default '{}',
  pdf_key          text not null,
  signed_key       text,
  signed_name      text,
  signed_at        timestamptz,
  status           text not null default 'issued' check (status in ('issued', 'signed', 'void')),
  void_reason      text,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (year, seq)
);

create index if not exists payment_acknowledgments_fac_idx on public.payment_acknowledgments (facilitator_id);

alter table public.payment_acknowledgments enable row level security;
revoke all on public.payment_acknowledgments from anon, authenticated;
grant select, insert, update, delete on public.payment_acknowledgments to service_role;
