/**
 * Admin → Finance.
 *
 * The section that replaces the hand-kept "Sales & P&L" workbook. Nothing on
 * these pages is typed in except what the platform cannot know — expenses,
 * adjustments and non-standard revenue-share deals. Sales, splits, refunds and
 * payouts come from the platform's own tables; PayMongo's actual fees come
 * from payment_ledger (captured after each webhook and nightly).
 */
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import OverviewPage from './finance/OverviewPage';
import SalesPage from './finance/SalesPage';
import PnlPage from './finance/PnlPage';
import PayablesPage from './finance/PayablesPage';
import ReconciliationPage from './finance/ReconciliationPage';
import ExpensesPage from './finance/ExpensesPage';
import SplitRulesPage from './finance/SplitRulesPage';
import TransactionsPage from './finance/TransactionsPage';
import AccountsPage from './finance/AccountsPage';
import ReceiptsPage from './finance/ReceiptsPage';
import './finance/finance.css';

export const FINANCE_PAGES = [
  { path: 'overview', label: 'Overview' },
  { path: 'sales', label: 'Sales register' },
  { path: 'pnl', label: 'Profit & loss' },
  { path: 'payables', label: 'Payables & refunds' },
  { path: 'reconciliation', label: 'Reconciliation' },
  { path: 'expenses', label: 'Expenses' },
  { path: 'transactions', label: 'Offline transactions' },
  { path: 'accounts', label: 'Accounts' },
  { path: 'receipts', label: 'Payment receipts' },
  { path: 'splits', label: 'Revenue splits' },
] as const;

export default function FinanceTab({ adminKey }: { adminKey: string }) {
  return (
    <div>
      <nav className="fin-subnav" aria-label="Finance">
        {FINANCE_PAGES.map((p) => (
          <NavLink key={p.path} to={`/admin/finance/${p.path}`} className={({ isActive }) => (isActive ? 'active' : '')}>
            {p.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<OverviewPage adminKey={adminKey} />} />
        <Route path="sales" element={<SalesPage adminKey={adminKey} />} />
        <Route path="pnl" element={<PnlPage adminKey={adminKey} />} />
        <Route path="payables" element={<PayablesPage adminKey={adminKey} />} />
        <Route path="reconciliation" element={<ReconciliationPage adminKey={adminKey} />} />
        <Route path="expenses" element={<ExpensesPage adminKey={adminKey} />} />
        <Route path="splits" element={<SplitRulesPage adminKey={adminKey} />} />
        <Route path="transactions" element={<TransactionsPage adminKey={adminKey} />} />
        <Route path="accounts" element={<AccountsPage adminKey={adminKey} />} />
        <Route path="receipts" element={<ReceiptsPage adminKey={adminKey} />} />
        <Route path="*" element={<Navigate to="overview" replace />} />
      </Routes>
    </div>
  );
}
