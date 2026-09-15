import { useEffect, useState, type FormEvent } from 'react';
import {
  adminListPromoCodes,
  adminCreatePromoCode,
  adminUpdatePromoCode,
  adminDeletePromoCode,
  type AdminPromoCode,
} from '../../lib/api';
import { money } from '../../components/Layout';

/**
 * Promo codes: percentage or fixed-peso discounts applied at checkout.
 *
 * Deletion is a real delete (see 0044's `orders.promo_code_id` ON DELETE SET
 * NULL) — a historical order keeps the discount it actually charged even
 * after the code that produced it is gone, so there's no "archive instead of
 * delete" dance here the way there is for products.
 */

function describeDiscount(p: AdminPromoCode): string {
  return p.discount_type === 'percent' ? `${p.discount_value}% off` : `${money(p.discount_value)} off`;
}

function isExpired(p: AdminPromoCode): boolean {
  return Boolean(p.expires_at && new Date(p.expires_at).getTime() < Date.now());
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
  const [codes, setCodes] = useState<AdminPromoCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    setNotice(null);

    const discountValue = Number(form.discountValue.trim());
    if (!form.code.trim()) return setError('Enter a code');
    if (!Number.isInteger(discountValue)) {
      return setError(form.discountType === 'fixed' ? 'Discount must be a whole peso amount' : 'Discount must be a whole percent');
    }

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
      setForm(EMPTY_FORM);
      setFormOpen(false);
      setNotice(`Created ${form.code.trim().toUpperCase()}`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onToggleActive(p: AdminPromoCode) {
    setError(null);
    try {
      await adminUpdatePromoCode(adminKey, p.id, { is_active: !p.is_active });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function onDelete(p: AdminPromoCode) {
    if (!window.confirm(`Delete promo code ${p.code}? This cannot be undone.`)) return;
    setError(null);
    try {
      await adminDeletePromoCode(adminKey, p.id);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.15rem' }}>Promo Codes</h2>
          <p className="small muted" style={{ margin: '0.25rem 0 0' }}>
            Discounts applied at checkout — e.g. an affiliate or referral code.
          </p>
        </div>
        <button className="btn btn-primary" onClick={() => setFormOpen((v) => !v)}>
          {formOpen ? 'Cancel' : '+ New code'}
        </button>
      </div>

      {error && <div className="alert alert-error" style={{ marginBottom: '1rem' }}>{error}</div>}
      {notice && <div className="alert alert-info" style={{ marginBottom: '1rem' }}>{notice}</div>}

      {formOpen && (
        <form className="panel" onSubmit={onCreate} style={{ marginBottom: '1.5rem' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
            <div className="field">
              <label htmlFor="pc-code">Code</label>
              <input
                id="pc-code"
                value={form.code}
                placeholder="e.g. KUYA10"
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
              />
            </div>
            <div className="field">
              <label htmlFor="pc-label">Label (internal)</label>
              <input
                id="pc-label"
                value={form.label}
                placeholder="e.g. Jonathan Brown"
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
              />
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
              />
            </div>
            <div className="field">
              <label htmlFor="pc-expires">Expires (optional)</label>
              <input
                id="pc-expires"
                type="date"
                value={form.expiresAt}
                onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
              />
            </div>
          </div>
          <button className="btn btn-accent" type="submit" disabled={busy} style={{ marginTop: '1rem' }}>
            {busy ? 'Creating…' : 'Create code'}
          </button>
        </form>
      )}

      <div className="panel" style={{ padding: 0 }}>
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Label</th>
              <th>Discount</th>
              <th>Status</th>
              <th>Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {codes.length === 0 && (
              <tr>
                <td colSpan={6} className="small muted" style={{ padding: '1rem' }}>
                  No promo codes yet.
                </td>
              </tr>
            )}
            {codes.map((p) => {
              const expired = isExpired(p);
              return (
                <tr key={p.id}>
                  <td><strong>{p.code}</strong></td>
                  <td className="small muted">{p.label || '—'}</td>
                  <td>{describeDiscount(p)}</td>
                  <td>
                    {expired ? (
                      <span className="pill pill-bad">expired</span>
                    ) : p.is_active ? (
                      <span className="pill pill-ok">active</span>
                    ) : (
                      <span className="pill pill-warn">inactive</span>
                    )}
                  </td>
                  <td className="small muted">
                    {p.expires_at ? new Date(p.expires_at).toLocaleDateString() : 'Never'}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
                    <button className="btn btn-ghost small" onClick={() => onToggleActive(p)}>
                      {p.is_active ? 'Deactivate' : 'Activate'}
                    </button>{' '}
                    <button className="btn btn-ghost small" onClick={() => onDelete(p)}>
                      Delete
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
