-- Which charges a balance payment stands in for.
--
-- Paying a plan off early creates one new charge for the outstanding amount;
-- the instalments it replaces are voided when that payment clears. This column
-- is what records the link between them.
--
-- It exists on the row rather than only in the PayMongo session's metadata
-- because metadata reaches exactly one of the three paths that can settle a
-- charge. The webhook has it; the SQS retry consumer does not (it carries only
-- a charge id, by design — see retry-queue.ts); and an admin marking a balance
-- payment received by bank transfer never touches PayMongo at all. All three
-- go through applyChargePayment, and all three have to void the same rows, so
-- the fact has to live where all three can read it.
--
-- uuid[] rather than a join table: this is a short list, written once at
-- checkout and read once at fulfillment, and it never needs to be queried from
-- the other direction ("which balance payment voided me?" is answerable from
-- void_reason plus paid_at).

alter table public.registration_charges
  add column if not exists supersedes uuid[] not null default '{}';

comment on column public.registration_charges.supersedes is
  'Charge ids this one replaces, for an early payoff. Voided by applyChargePayment once this charge is paid — never before, so an abandoned payoff leaves the original schedule intact.';
