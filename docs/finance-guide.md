# Finance guide (Admin → Finance)

How Hilom's books work in the admin, how to do each money task, and — for the
admin assistant — where every number lives and how to query it. Replaces the
hand-kept "Sales & P&L" Excel workbook (retired October 2026).

All admin screens are under **https://www.hilomcollective.com/admin/finance/**.
Money is PHP. Database money columns are integer **centavos** (divide by 100).
Months are **Asia/Manila** calendar months.

---

## 1. The idea in one paragraph

Sales are never typed in: every PayMongo sale (course orders, event charges,
group-class seats, 1:1 bookings, session packages) is already in the platform
with the revenue split it was charged at, and PayMongo's actual fee and payout
are captured automatically after each payment and nightly. Admins only enter
what the platform cannot know: **expenses**, **offline money** (cash sales,
payments to facilitators outside a payout batch, owner money, loans,
transfers), **adjustments**, **revenue-split deals**, **account statement
balances**, and **payment acknowledgment receipts**.

## 2. The pages and how to do things

| Page | Path | Use it to |
|---|---|---|
| Overview | `finance/overview` | This month's gross, net revenue, net profit, fees; amounts owed; cash across accounts; "Needs attention" list; 6-month trend |
| Sales register | `finance/sales` | Every sale with split, PayMongo fee, refund and payout status. Filter by dates (paid date or service date), category, facilitator, status. Export CSV. Expand a row → open the source, or **Mark as test payment** |
| Profit & loss | `finance/pnl` | The monthly statement, accrual or cash, vs last month. **Add adjustment**. **Close month** / **Reopen month** |
| Payables & refunds | `finance/payables` | What each facilitator is owed (platform shares + offline sales − offline payments), refunds owed vs sent, payout batches. **Receipt** button per facilitator |
| Reconciliation | `finance/reconciliation` | Everything that doesn't add up. **Acknowledge** an item with a note (hidden until its numbers change). **Fetch missing fees** / **Refresh from PayMongo**. PayMongo payout groups to match bank deposits |
| Expenses | `finance/expenses` | **+ New expense** with receipt upload; "Paid from account"; "Paid personally by" (creates a reimbursement owed to that person); **Mark paid back** on a reimbursement; Void |
| Offline transactions | `finance/transactions` | Record money outside PayMongo (see §3). Void with reason. **Ack receipt** on a facilitator payment |
| Accounts | `finance/accounts` | Bank / GCash / cash / PayMongo balance accounts with opening balances; **Enter statement** each month end; **Movements** per account |
| Payment receipts | `finance/receipts` | Issue a numbered **Payment Acknowledgment Receipt** PDF for payments to a facilitator; upload the signed copy; void |
| Revenue splits | `finance/splits` | Deals that differ from a facilitator's standard %: flat ₱ per seat, a different %, or Hilom-owned. **Apply to unpaid charges** re-splits already-paid charges not yet in a payout batch |

Payout **batches** (build, approve, mark paid) stay on **Admin → Payouts**.

### How to… (step by step)

- **Record an expense:** Expenses → + New expense → date paid, vendor, category,
  amount (and VAT if any) → *Paid from account* (or *Paid personally by* a name)
  → attach the receipt → Save. Commitments not yet paid: status *Draft*.
- **Record an expense by chatting with the assistant:** Admin → Assistant →
  "I paid Kapitolyo ₱6,000 for the venue yesterday by GCash" (or "Help me record
  an expense"). It asks for anything missing (date, vendor, category, amount,
  which account or who paid personally, event), checks for duplicates and closed
  months, then shows a **draft card** under its answer. Review or **Edit** the
  fields, attach the receipt, and press **Save expense** — that is what records
  it, under your name (the note says it was drafted with the assistant).
  **Cancel** discards it. The assistant itself can never save.
- **Someone paid for the company personally:** enter the expense with *Paid
  personally by* = their name. It appears under Reimbursements as owed. When
  repaid: **Mark paid back** with the transfer reference.
- **Paid a facilitator outside a payout batch** (advance, flat fee, cash):
  Offline transactions → **+ Payment to facilitator** → facilitator, amount,
  account, reference → Record. Their Payables balance goes down; overpaying
  shows as a credit.
- **Cash / bank-transfer sale** (class, session, walk-in): Offline transactions
  → **+ Offline sale** → buyer, what was sold, category, facilitator (if theirs),
  event (optional), account. The split is applied automatically (event rule →
  facilitator's rate → Hilom's if no facilitator) or override Hilom's share.
- **Owner put money in / took money out, loan, moving money between accounts:**
  Offline transactions → the matching button. These change account balances
  only, never the P&L.
- **Issue a payment acknowledgment receipt:** Payment receipts → choose the
  facilitator → tick the payments → check recipient name, role, "for" line, date
  → **Preview PDF** → **Issue receipt** (gets the next number HC-AR-YYYY-NNNN).
  When it comes back signed: **Upload signed**. Wrong one: **Void** (its
  payments become available again).
- **A facilitator's deal isn't their standard %** (e.g. Batara ₱1,500 per head):
  Revenue splits → New rule → one event / series / all their events → deal →
  Save → **Apply to unpaid charges…** → Apply.
- **Month end:** (1) Reconciliation → clear or acknowledge items; (2) Accounts →
  **Enter statement** for each account; investigate any gap; (3) Profit & loss →
  check → **Close month**. A closed month refuses new expenses, transactions and
  adjustments dated in it; corrections go into an open month as an adjustment.
- **Refund sent:** mark it on the sale's own screen (Registrations / Bookings /
  Classes); it moves from "owed" to "sent".
- **A payment was a test:** Sales register → expand the row → *Mark as test
  payment* (excluded from P&L and payables).

## 3. Definitions (what the numbers mean)

- **Gross sales (GMV):** everything buyers paid, before splits and fees.
- **Hilom share:** the platform's cut of each sale (`platform_fee_centavos`; a
  charge with no split counts 100% Hilom). Facilitator share is the rest.
- **Net revenue** = Hilom share − Hilom's part of refunds + revenue adjustments.
- **Payment costs** = actual PayMongo fees (VAT-inclusive; currently 1.5% QR Ph)
  − processing fees recovered from facilitators on payout batches.
- **Gross profit** = net revenue − payment costs. **Net profit** = gross profit −
  operating expenses (approved, by date paid) + other adjustments.
- **Accrual basis:** a sale counts in the month the event/session happens
  (`service_date`); refunds when decided. **Cash basis:** when paid
  (`occurred_at`); refunds only once sent. The Overview uses accrual.
- **Test payments** (`payment_ledger.is_test`) are excluded everywhere by default.
- **Facilitator balance owed** = unbatched platform shares + batched-unpaid +
  offline-sale shares − clawbacks due − payments made outside batches. Negative =
  paid ahead (credit).
- **Account book balance** = opening balance + every movement since the opening
  date (PayMongo net payments → PayMongo account; PayMongo payouts → the account
  flagged "PayMongo pays out here", dated approximately; expenses / reimbursements
  / payout batches → their paying account; offline transactions).

## 4. Data map (for the assistant)

| Question | Source |
|---|---|
| Sales, splits, categories | view `v_revenue_lines` (one row per paid charge; `source`, `source_id`, `parent_id`, `occurred_at`, `service_date`, `buyer_name`, `buyer_email`, `item`, `category`, `facilitator_id`, `event_id`, `gross_centavos`, `hilom_share_centavos`, `facilitator_share_centavos`, `split_missing`, `paymongo_payment_id`, `payout_id`, `clawed_back_payout_id`). **Offline sales are not in this view** — they are `finance_transactions` with `kind='offline_sale'` |
| PayMongo fee / net / method / payout / test flag | `payment_ledger` (key `paymongo_payment_id`; `fee_centavos`, `fee_vat_centavos`, `net_centavos`, `method`, `payout_id`, `is_test`, `test_reason`, `fetch_error`) |
| Refunds owed / sent | view `v_refund_lines` (`refund_centavos`, `refunded_at` null = owed, `decided_at`); PayMongo-side refunds in `refund_ledger` |
| Expenses | `expenses` (`incurred_on`, `vendor`, `category`, `amount_centavos`, `paid_by` 'company' or a name, `account_id`, `status` draft/approved/void, `receipt_key` null = no receipt) |
| Reimbursements owed to people | `reimbursements` (`payee`, `status` owed/paid) ⟵ `expenses.reimbursement_id`; total = sum of its non-void expenses |
| Offline money | `finance_transactions` (`kind` offline_sale / facilitator_payment / owner_contribution / owner_withdrawal / loan_in / loan_repayment / transfer / other_in / other_out; `occurred_on`, `amount_centavos`, `account_id`, `counter_account_id`, `facilitator_id`, `hilom_share_centavos`, `facilitator_share_centavos`, `reference`, `status` posted/void) |
| Accounts & statements | `finance_accounts` (`opening_balance_centavos`, `opening_date`, `receives_paymongo`, `default_for_payouts`), `finance_account_balances` (`period` = first of month, `statement_balance_centavos`) |
| Payout batches | `facilitator_payouts` (`status` draft/approved/paid/void, `net_centavos`, `processing_fee_centavos`, `paid_at`, `reference`) |
| Revenue-split deals | `revenue_split_rules` (`scope` event/event_series/facilitator, `scope_id`, `kind`, `bps`, `flat_facilitator_centavos`; live when `voided_at is null`). Default rates: `facilitators.platform_fee_bps`, `events.platform_fee_bps` (null = no split) |
| Adjustments | `finance_adjustments` (`period`, `line` revenue/payment_costs/opex/other, signed `amount_centavos`, `reason`, `voided_at`) |
| Closed months | `finance_periods` (`status`, `snapshot` = P&L frozen at close) |
| Expense drafts from the assistant | `assistant_runs.expense_draft` (the proposed fields), `expense_draft_status` pending/saved/cancelled, `expense_id` once saved |
| Payment acknowledgment receipts | `payment_acknowledgments` (`receipt_no`, `facilitator_id`, `issue_date`, `total_centavos`, `status` issued/signed/void, `data->'lines'`, `transaction_ids`, `payout_ids`) |
| Reconciliation items an admin acknowledged | `finance_exception_acks` (`key`, `note`, `acked_by`) |

### Query recipes (PostgreSQL)

Sales by month, excluding tests (cash basis; use `service_date` for accrual):
```sql
with l as (
  select v.*, coalesce(pl.is_test,false) is_test, pl.fee_centavos
  from v_revenue_lines v left join payment_ledger pl using (paymongo_payment_id))
select to_char(occurred_at at time zone 'Asia/Manila','YYYY-MM') month, count(*),
       sum(gross_centavos)/100.0 gross, sum(hilom_share_centavos)/100.0 hilom,
       sum(coalesce(fee_centavos,0))/100.0 paymongo_fees
from l where not is_test group by 1 order by 1;
```
Add offline sales: `select to_char(occurred_on,'YYYY-MM'), sum(amount_centavos), sum(hilom_share_centavos) from finance_transactions where kind='offline_sale' and status='posted' group by 1`.

Operating expenses by month and category:
```sql
select to_char(incurred_on,'YYYY-MM') month, category, sum(amount_centavos)/100.0
from expenses where status='approved' group by 1,2 order by 1,2;
```

What a facilitator was paid, all routes:
```sql
select 'batch' via, paid_at::date, net_centavos/100.0, reference from facilitator_payouts
 where facilitator_id = :id and status='paid'
union all
select 'offline', occurred_on, amount_centavos/100.0, reference from finance_transactions
 where facilitator_id = :id and kind='facilitator_payment' and status='posted'
order by 2;
```

Refunds owed: `select * from v_refund_lines where refunded_at is null`.
Who is owed reimbursement: join `reimbursements` (status 'owed') to `expenses`.
Receipts awaiting signature: `select receipt_no, issue_date, total_centavos from payment_acknowledgments where status='issued'`.

The **P&L, facilitator balances and account balances shown on screen are
computed by the app**, not stored. Reproduce them from the definitions above,
or simply point the admin to the screen; if SQL and the screen disagree, trust
the screen and say so.

## 5. Things to know

- PayMongo's payout *date* is not captured; account movements for payouts are
  dated on the last payment in the payout (marked ≈).
- A facilitator's event with no split (`split_missing`) counts 100% Hilom and
  nothing is payable until a split rule is applied — Reconciliation flags it.
- Transactions, adjustments and receipts are never edited: void (with a reason)
  and re-enter. Every finance action is in Admin → Audit Log.
- Receipts and expense attachments are private files; open them from the admin
  (links expire after 5 minutes).
