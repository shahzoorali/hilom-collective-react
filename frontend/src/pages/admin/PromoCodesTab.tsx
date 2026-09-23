import { useEffect, useState, type FormEvent } from 'react';
import {
  adminListPromoCodes,
  adminCreatePromoCode,
  adminUpdatePromoCode,
  adminDeletePromoCode,
  type AdminPromoCode,
} from '../../lib/api';
import { money } from '../../components/Layout';
import { adminConfirm, adminToast } from './ui/feedback';
import { DataTable, downloadCsv, type Column } from './ui/DataTable';

/**
 * Promo codes: percentage or fixed-peso discounts applied at checkout.
 *
 * Deletion is a real delete (see 0044's `orders.promo_code_id` ON DELETE SET
 * NULL) — a historical order keeps the discount it actually charged even
 * after the code that produced it is gone, so there's no "archive instead of
 * delete" dance here the way there is for products.
 *
 * Activate / deactivate is reversible, so it offers Undo instead of asking.
 * Bulk generate makes PREFIX-XXXXXX codes for a campaign and downloads them as
 * CSV, since the list is the thing you hand to the partner.
 */

function describeDiscount(p: AdminPromoCode): string {
  return p.discount_type === 'percent' ? `${p.discount_value}% off` : `${money(p.discount_value)} off`;
}

function isExpired(p: AdminPromoCode): boolean {
  return Boolean(p.expires_at && new Date(p.expires_at).getTime() < Date.now());
}

function expiryText(p: AdminPromoCode): string {
  if (!p.expires_at) return 'Never';
  const days = Math.ceil((new Date(p.expires_at).getTime() - Date.now()) / 86400000);
  const date = new Date(p.expires_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
  if (days < 0) return `${date} (ended)`;
  if (days === 0) return `${date} (today)`;
  return days <= 14 ? `${date} · ${days} day${days === 1 ? '' : 's'} left` : date;
}

interface FormState {
  code: string;
  label: string;
  discountType: 'percent' | 'fixed';
  discountValue: string;
  expiresAt: string;
}

const EMPTY_FORM: FormState = { code: '', label: '', discountType: 'percent', discountValue: '', expiresAt: '' };

export default function PromoCodesTab({ adminKey }: { adminKey: string }) {
  const [codes, setCodes] = useState<AdminPromoCode[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(false);

  async function load() {
    setError(null);
    try {
      setCodes(await adminListPromoCodes(adminKey));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onCreate(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const discountValue = Number(form.discountValue.trim());
    if (!form.code.trim()) return setError('Enter a code');
    if (!Number.isInteger(discountValue)) {
      return setError(form.discountType === 'fixed' ? 'Discount must be a whole peso amount' : 'Discount must be a whole percent');
    }
    if (form.discountType === 'percent' && (discountValue < 1 || discountValue > 100)) {
      return setError('A percent discount must be between 1 and 100');
    }
    if (discountValue <= 0) return setError('Discount must be more than zero');

    setBusy(true);
    try {
      await adminCreatePromoCode(adminKey, {
        code: form.code.trim(),
        label: form.label.trim() || undefined,
        discount_type: form.discountType,
        // Fixed discounts are entered in pesos here, stored in centavos everywhere else.
        discount_value: form.discountType === 'fixed' ? Math.round(discountValue * 100) : discountValue,
        expires_at: form.expiresAt ? new Date(form.expiresAt).toISOString() : null,
      });
      adminToast.success(`Created ${form.code.trim().toUpperCase()}`);
      setForm(EMPTY_FORM);
      setFormOpen(false);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onToggleActive(p: AdminPromoCode) {
    try {
      await adminUpdatePromoCode(adminKey, p.id, { is_active: !p.is_active });
      await load();
      adminToast.success(`${p.code} ${p.is_active ? 'deactivated' : 'activated'}`, {
        label: 'Undo',
        run: async () => {
          await adminUpdatePromoCode(adminKey, p.id, { is_active: p.is_active });
          await load();
        },
      });
    } catch (e) {
      adminToast.error((e as Error).message);
    }
  }

  async function onToggleEvents(p: AdminPromoCode) {
    try {
      await adminUpdatePromoCode(adminKey, p.id, { applies_to_events: !p.applies_to_events });
      await load();
      adminToast.success(`${p.code} ${p.applies_to_events ? 'no longer works' : 'now works'} on event tickets`);
    } catch (e) {
      adminToast.error((e as Error).message);
    }
  }

  async function onDelete(p: AdminPromoCode) {
    if (
      !(await adminConfirm({
        title: `Delete promo code ${p.code}?`,
        body: 'Checkouts will stop accepting it. Deactivate instead if you might want it back.',
        confirmLabel: 'Delete',
        danger: true,
      }))
    )
      return;
    try {
      await adminDeletePromoCode(adminKey, p.id);
      adminToast.success(`Deleted ${p.code}`);
      await load();
    } catch (e) {
      adminToast.error((e as Error).message);
    }
  }

  async function setActive(rows: AdminPromoCode[], active: boolean) {
    try {
      await Promise.all(
        rows.filter((p) => p.is_active !== active).map((p) => adminUpdatePromoCode(adminKey, p.id, { is_active: active })),
      );
      adminToast.success(`${rows.length} code${rows.length === 1 ? '' : 's'} ${active ? 'activated' : 'deactivated'}`);
    } catch (e) {
      adminToast.error((e as Error).message);
    }
    await load();
  }

  async function bulkDelete(rows: AdminPromoCode[]) {
    const yes = await adminConfirm({
      title: `Delete ${rows.length} promo code${rows.length === 1 ? '' : 's'}?`,
      body: rows.map((r) => r.code).join(', '),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!yes) return;
    try {
      await Promise.all(rows.map((p) => adminDeletePromoCode(adminKey, p.id)));
      adminToast.success(`Deleted ${rows.length}`);
    } catch (e) {
      adminToast.error((e as Error).message);
    }
    await load();
  }

  async function bulkGenerate() {
    const prefix = window.prompt('Code prefix (e.g. LAUNCH):', 'HILOM')?.trim().toUpperCase();
    if (!prefix) return;
    const count = Number(window.prompt('How many codes? (1–50)', '10'));
    if (!Number.isInteger(count) || count < 1 || count > 50) return adminToast.error('Enter a whole number from 1 to 50');
    const pct = Number(window.prompt('Percent off (1–100):', '10'));
    if (!Number.isInteger(pct) || pct < 1 || pct > 100) return adminToast.error('Percent must be a whole number from 1 to 100');
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rand = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => alphabet[b % alphabet.length]).join('');
    setBusy(true);
    const made: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = `${prefix}-${rand()}`;
      try {
        await adminCreatePromoCode(adminKey, { code, label: `Bulk: ${prefix}`, discount_type: 'percent', discount_value: pct });
        made.push(code);
      } catch {
        /* collision or validation — skipped, reported in the count below */
      }
    }
    setBusy(false);
    await load();
    if (made.length) {
      downloadCsv(`promo-${prefix.toLowerCase()}`, ['code', 'percent_off'], made.map((c) => [c, pct]));
      adminToast.success(`Generated ${made.length} of ${count} codes — CSV downloaded`);
    } else {
      adminToast.error('No codes were created');
    }
  }

  const columns: Column<AdminPromoCode>[] = [
    {
      key: 'code',
      header: 'Code',
      pinned: true,
      sortValue: (p) => p.code,
      render: (p) => (
        <span className="row" style={{ gap: '0.35rem' }}>
          <strong className="mono">{p.code}</strong>
          <button
            type="button"
            className="ord-copy"
            title="Copy code"
            onClick={() => void navigator.clipboard.writeText(p.code).then(() => adminToast.success(`Copied ${p.code}`))}
          >
            copy
          </button>
        </span>
      ),
    },
    { key: 'label', header: 'Label', sortValue: (p) => p.label ?? '', render: (p) => <span className="small muted">{p.label || '—'}</span> },
    {
      key: 'discount',
      header: 'Discount',
      sortValue: (p) => (p.discount_type === 'percent' ? p.discount_value * 1e6 : p.discount_value),
      csv: describeDiscount,
      render: describeDiscount,
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (p) => (isExpired(p) ? 'expired' : p.is_active ? 'active' : 'inactive'),
      render: (p) =>
        isExpired(p) ? (
          <span className="pill pill-bad">expired</span>
        ) : p.is_active ? (
          <span className="pill pill-ok">active</span>
        ) : (
          <span className="pill pill-warn">inactive</span>
        ),
    },
    {
      key: 'events',
      header: 'Events',
      sortValue: (p) => (p.applies_to_events ? 1 : 0),
      csv: (p) => (p.applies_to_events ? 'yes' : 'no'),
      render: (p) => (
        <button
          className="btn btn-ghost small"
          title="Whether this code also discounts event tickets (paid in full only)"
          onClick={() => void onToggleEvents(p)}
        >
          {p.applies_to_events ? 'On' : 'Off'}
        </button>
      ),
    },
    { key: 'expires', header: 'Expires', sortValue: (p) => p.expires_at ?? '9999', csv: (p) => p.expires_at, render: (p) => <span className="small">{expiryText(p)}</span> },
    {
      key: 'created',
      header: 'Created',
      defaultHidden: true,
      sortValue: (p) => p.created_at,
      render: (p) => <span className="small muted">{new Date(p.created_at).toLocaleDateString()}</span>,
    },
    {
      key: 'actions',
      header: '',
      pinned: true,
      align: 'right',
      render: (p) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-ghost small" onClick={() => void onToggleActive(p)}>
            {p.is_active ? 'Deactivate' : 'Activate'}
          </button>{' '}
          <button className="btn btn-ghost small" onClick={() => void onDelete(p)}>
            Delete
          </button>
        </span>
      ),
    },
  ];

  const pctTooHigh = form.discountType === 'percent' && Number(form.discountValue) > 100;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Promo Codes</h2>
          <p className="small muted">Discounts applied at checkout — e.g. an affiliate or referral code.</p>
        </div>
        <div className="page-head__actions">
          <button type="button" className="btn btn-ghost small" onClick={() => void bulkGenerate()} disabled={busy}>
            Bulk generate…
          </button>
          <button className="btn btn-primary small" onClick={() => setFormOpen((v) => !v)}>
            {formOpen ? 'Cancel' : '+ New code'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {formOpen && (
        <form className="panel" onSubmit={onCreate} style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
            <div className="field">
              <label htmlFor="pc-code">Code</label>
              <input id="pc-code" value={form.code} placeholder="e.g. KUYA10" onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="pc-label">Label (internal)</label>
              <input id="pc-label" value={form.label} placeholder="e.g. Jonathan Brown" onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="pc-type">Discount type</label>
              <select
                id="pc-type"
                value={form.discountType}
                onChange={(e) => setForm((f) => ({ ...f, discountType: e.target.value as 'percent' | 'fixed' }))}
              >
                <option value="percent">Percent off</option>
                <option value="fixed">Fixed amount off (PHP)</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="pc-value">{form.discountType === 'percent' ? 'Percent (1-100)' : 'Amount (PHP)'}</label>
              <input
                id="pc-value"
                inputMode="decimal"
                value={form.discountValue}
                placeholder={form.discountType === 'percent' ? '10' : '150'}
                onChange={(e) => setForm((f) => ({ ...f, discountValue: e.target.value }))}
                aria-invalid={pctTooHigh}
              />
              {pctTooHigh && <div className="small" style={{ color: 'var(--danger-fg)' }}>Over 100% would make the course free and then some.</div>}
            </div>
            <div className="field">
              <label htmlFor="pc-expires">Expires (optional)</label>
              <input id="pc-expires" type="date" value={form.expiresAt} onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))} />
            </div>
          </div>
          <button className="btn btn-accent" type="submit" disabled={busy || pctTooHigh} style={{ marginTop: '1rem' }}>
            {busy ? 'Creating…' : 'Create code'}
          </button>
        </form>
      )}

      <div className="panel">
        <DataTable
          id="promo-codes"
          rows={codes}
          rowKey={(p) => p.id}
          columns={columns}
          searchText={(p) => `${p.code} ${p.label ?? ''}`}
          searchPlaceholder="Search code or label…"
          csvName="promo-codes"
          defaultSort={{ key: 'created', dir: 'desc' }}
          rowClassName={(p) => (isExpired(p) || !p.is_active ? 'row-muted' : undefined)}
          bulkActions={[
            { label: 'Activate', run: (rows) => setActive(rows, true) },
            { label: 'Deactivate', run: (rows) => setActive(rows, false) },
            { label: 'Delete', danger: true, run: (rows) => bulkDelete(rows) },
          ]}
          empty={{
            title: 'No promo codes yet',
            body: 'Create a code for an affiliate, a partner or a launch — it applies at checkout.',
            action: (
              <button className="btn btn-primary small" onClick={() => setFormOpen(true)}>
                + New code
              </button>
            ),
          }}
        />
      </div>
    </div>
  );
}
