/**
 * Admin → Community: everyone who submitted the "Join Our Community" form
 * (db/migrations/0075). One row per email; repeat sign-ups merge interests and
 * keep every message. Marketing consent is opt-in and shown with its date.
 *
 * Canny: "Community Sign-Ups – Database & CSV Export".
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { API_BASE } from '../../config';
import { EmptyState } from './ui/EmptyState';
import { adminToast } from './ui/feedback';

interface Signup {
  id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  interests: string[];
  messages: { at: string; text: string }[];
  marketing_consent: boolean;
  marketing_consent_at: string | null;
  marketing_consent_withdrawn_at: string | null;
  source: 'form' | 'import';
  submission_count: number;
  first_submitted_at: string;
  last_submitted_at: string;
}

interface ListResponse {
  signups: Signup[];
  total: number;
  consented: number;
  interests: string[];
  truncated: boolean;
}

const when = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : '—';

function qs(f: Record<string, string>): string {
  const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export default function CommunityTab({ adminKey }: { adminKey: string }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [consent, setConsent] = useState('');
  const [interest, setInterest] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filters = { q: term, consent, interest };

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/admin/community${qs({ q: term, consent, interest })}`, {
        headers: { 'x-admin-key': adminKey },
      });
      if (!res.ok) throw new Error('Could not load community sign-ups.');
      setData((await res.json()) as ListResponse);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [adminKey, term, consent, interest]);

  useEffect(() => void load(), [load]);

  const downloadCsv = async () => {
    const res = await fetch(`${API_BASE}/admin/community.csv${qs(filters)}`, { headers: { 'x-admin-key': adminKey } });
    if (!res.ok) throw new Error('Could not export sign-ups.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = res.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] ?? 'community.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const withdraw = async (s: Signup) => {
    if (!window.confirm(`Record that ${s.email} no longer wants promotional emails?`)) return;
    const res = await fetch(`${API_BASE}/admin/community/${s.id}/withdraw-consent`, {
      method: 'POST',
      headers: { 'x-admin-key': adminKey },
    });
    if (!res.ok) {
      setError('Could not update consent.');
      return;
    }
    adminToast.success('Consent withdrawn');
    void load();
  };

  const rows = data?.signups ?? [];

  return (
    <div>
      <div className="page-head">
        <div>
          <h2>Community</h2>
          <p className="small muted">
            Everyone who joined through the community form. Repeat sign-ups from the same email are merged.
          </p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, email or message…"
          aria-label="Search sign-ups"
          style={{ maxWidth: 280 }}
        />
        <select value={consent} onChange={(e) => setConsent(e.target.value)} aria-label="Filter by consent" style={{ maxWidth: 220 }}>
          <option value="">All consent states</option>
          <option value="yes">Agreed to promo emails</option>
          <option value="no">Not agreed</option>
        </select>
        <select value={interest} onChange={(e) => setInterest(e.target.value)} aria-label="Filter by interest" style={{ maxWidth: 220 }}>
          <option value="">All interests</option>
          {(data?.interests ?? []).map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: '6px 12px' }}
          onClick={() => void downloadCsv().catch((e: Error) => setError(e.message))}
        >
          Export CSV
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {data && (
        <p className="small muted" style={{ marginBottom: 12 }}>
          {data.total} {data.total === 1 ? 'person' : 'people'} in total · {data.consented} agreed to promotional emails
          {rows.length !== data.total && ` · ${rows.length} shown`}
        </p>
      )}

      {data && rows.length === 0 && (
        <div className="panel">
          <EmptyState
            icon="users"
            title={term || consent || interest ? 'Nobody matches that' : 'No sign-ups yet'}
            body="New community form submissions appear here as they arrive."
          />
        </div>
      )}

      {rows.length > 0 && (
        <div className="panel" style={{ overflowX: 'auto' }}>
          <table className="admin-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Name</th>
                <th>Email</th>
                <th>Interests</th>
                <th>Promo emails</th>
                <th>Last signed up</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <Fragment key={s.id}>
                  <tr onClick={() => setOpen(open === s.id ? null : s.id)} style={{ cursor: 'pointer' }}>
                    <td>{[s.first_name, s.last_name].filter(Boolean).join(' ') || '—'}</td>
                    <td>{s.email}</td>
                    <td>{s.interests.join(', ') || '—'}</td>
                    <td>
                      {s.marketing_consent
                        ? `Yes · ${when(s.marketing_consent_at)}`
                        : s.marketing_consent_withdrawn_at
                          ? `Withdrawn · ${when(s.marketing_consent_withdrawn_at)}`
                          : 'No'}
                    </td>
                    <td>
                      {when(s.last_submitted_at)}
                      {s.submission_count > 1 && <span className="small muted"> · {s.submission_count}×</span>}
                    </td>
                    <td className="small muted">{open === s.id ? '▲' : '▼'}</td>
                  </tr>
                  {open === s.id && (
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--cream, #faf7f0)' }}>
                        <p className="small muted" style={{ margin: '0 0 8px' }}>
                          First signed up {when(s.first_submitted_at)}
                          {s.source === 'import' && ' · imported from old notification emails'}
                        </p>
                        {s.messages.length === 0 ? (
                          <p className="small">No message.</p>
                        ) : (
                          s.messages.map((m, i) => (
                            <p key={i} className="small" style={{ margin: '0 0 6px', whiteSpace: 'pre-wrap' }}>
                              <strong>{when(m.at)}</strong> — {m.text}
                            </p>
                          ))
                        )}
                        {s.marketing_consent && (
                          <button
                            type="button"
                            className="btn btn-ghost"
                            style={{ padding: '4px 10px', marginTop: 6 }}
                            onClick={(e) => {
                              e.stopPropagation();
                              void withdraw(s);
                            }}
                          >
                            Withdraw promo-email consent
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
