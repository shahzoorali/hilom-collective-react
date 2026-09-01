/**
 * Admin → Accounts: the Cognito user pool.
 *
 * People (the tab next to this one) is derived from Postgres, so it only lists
 * someone once they have bought, booked, registered or enquired. This screen is
 * the other half: it reads the user pool directly, so an account that has only
 * ever signed in still shows up somewhere.
 *
 * **Read-only.** Cognito is the system of record for identity, and disabling or
 * deleting an account has consequences that belong in the AWS console behind
 * IAM — not behind the shared admin key. Rows expand to show attributes and
 * group membership; nothing here writes.
 *
 * **Pagination is Cognito's.** `ListUsers` hands back one page (≤60) and a
 * token for the next; there is no total and no jump-to-page, so this is a
 * plain "Load more". Search matches the *start* of the email address — the
 * only filter the API reliably supports — so it is labelled that way.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  adminListCognitoUsers,
  adminGetCognitoUser,
  type CognitoAccount,
  type CognitoAccountDetail,
} from '../../lib/cms';

const manilaDateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

/** How each Cognito account status reads, and whether it is a problem. */
const STATUS_PILL: Record<string, string> = {
  CONFIRMED: 'pill-ok',
  EXTERNAL_PROVIDER: 'pill-ok',
  UNCONFIRMED: 'pill-warn',
  FORCE_CHANGE_PASSWORD: 'pill-warn',
  RESET_REQUIRED: 'pill-warn',
  ARCHIVED: 'pill-bad',
  COMPROMISED: 'pill-bad',
  UNKNOWN: 'pill-warn',
};

export default function CognitoUsersTab({ adminKey }: { adminKey: string }) {
  const [users, setUsers] = useState<CognitoAccount[] | null>(null);
  const [nextToken, setNextToken] = useState<string | null>(null);
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [openUser, setOpenUser] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced so the prefix search does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const load = useCallback(async () => {
    setError(null);
    setUsers(null);
    setOpenUser(null);
    try {
      const res = await adminListCognitoUsers(adminKey, { q: term });
      setUsers(res.users);
      setNextToken(res.nextToken);
      setScope(res.scope);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [adminKey, term]);

  useEffect(() => void load(), [load]);

  async function loadMore() {
    if (!nextToken) return;
    setLoadingMore(true);
    setError(null);
    try {
      const res = await adminListCognitoUsers(adminKey, { q: term, token: nextToken });
      setUsers((prev) => [...(prev ?? []), ...res.users]);
      setNextToken(res.nextToken);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  const rows = users ?? [];
  const confirmed = rows.filter((u) => u.status === 'CONFIRMED').length;
  const unverified = rows.filter((u) => !u.email_verified).length;

  return (
    <div>
      <h2 style={{ fontSize: '1.15rem', marginTop: 0 }}>Accounts</h2>
      <p className="small muted" style={{ marginTop: '-0.25rem', marginBottom: '1.25rem' }}>
        {scope ||
          'Every account in the Cognito user pool, including ones that have never transacted.'}
      </p>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Email starts with…"
          aria-label="Search accounts by email prefix"
          style={{ maxWidth: 280 }}
        />
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      {users !== null && (
        <div className="admin-stats-grid">
          <Stat label="Loaded" value={String(rows.length)} hint={nextToken ? 'more available' : 'all shown'} />
          <Stat label="Confirmed" value={String(confirmed)} hint="of loaded" />
          <Stat label="Email unverified" value={String(unverified)} hint="of loaded" />
        </div>
      )}

      {users === null && !error && <div className="spinner" aria-label="Loading" />}

      {users !== null && rows.length === 0 && (
        <div className="panel">
          <p style={{ margin: 0 }}>
            {term
              ? 'No account whose email starts with that. The search only matches the beginning of the address.'
              : 'The user pool is empty.'}
          </p>
        </div>
      )}

      <div style={{ display: 'grid', gap: 10 }}>
        {rows.map((u) => (
          <AccountRow
            key={u.username}
            adminKey={adminKey}
            account={u}
            open={openUser === u.username}
            onToggle={() => setOpenUser(openUser === u.username ? null : u.username)}
          />
        ))}
      </div>

      {nextToken && (
        <div style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-ghost" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="admin-stat-card">
      <span className="admin-stat-card__label">{label}</span>
      <span className="admin-stat-card__value">{value}</span>
      {hint && <span className="small muted">{hint}</span>}
    </div>
  );
}

function StatusPill({ status }: { status: string | null }) {
  if (!status) return null;
  return (
    <span className={`pill ${STATUS_PILL[status] ?? 'pill-warn'}`}>
      {status.replace(/_/g, ' ').toLowerCase()}
    </span>
  );
}

function AccountRow({
  adminKey,
  account,
  open,
  onToggle,
}: {
  adminKey: string;
  account: CognitoAccount;
  open: boolean;
  onToggle: () => void;
}) {
  const [detail, setDetail] = useState<CognitoAccountDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Fetched on expand: the detail is two more Cognito calls per account, not
  // worth making for every row of a pool that only ever grows.
  useEffect(() => {
    if (!open || detail) return;
    adminGetCognitoUser(adminKey, account.username)
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [open, detail, adminKey, account.username]);

  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        style={{
          width: '100%',
          background: 'none',
          border: 0,
          padding: '0.9rem 1.1rem',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          gap: 12,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        <span style={{ flex: '1 1 240px', minWidth: 0 }}>
          <strong style={{ display: 'block' }}>{account.email ?? account.username}</strong>
          {account.name && <span className="small muted">{account.name}</span>}
        </span>

        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <StatusPill status={account.status} />
          {!account.enabled && <span className="pill pill-bad">disabled</span>}
          {!account.email_verified && <span className="pill pill-warn">email unverified</span>}
        </span>

        <span style={{ textAlign: 'right', minWidth: 150 }}>
          <span className="small muted" style={{ display: 'block' }}>
            {account.created_at ? `joined ${manilaDateTime(account.created_at)}` : ''}
          </span>
        </span>

        <span aria-hidden style={{ color: 'var(--muted)' }}>{open ? '▲' : '▼'}</span>
      </button>

      {open && (
        <div style={{ padding: '0 1.1rem 1.1rem', borderTop: '1px solid var(--line)' }}>
          {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}
          {!detail && !error && <div className="spinner" aria-label="Loading" />}
          {detail && <AccountDetail detail={detail} />}
        </div>
      )}
    </div>
  );
}

function AccountDetail({ detail }: { detail: CognitoAccountDetail }) {
  const { user, groups } = detail;
  return (
    <div style={{ display: 'grid', gap: 16, marginTop: 14 }}>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <Figure label="Cognito sub" value={user.sub ?? '—'} mono />
        <Figure label="Username" value={user.username} mono />
        {user.last_modified_at && (
          <Figure label="Last modified" value={manilaDateTime(user.last_modified_at)} />
        )}
      </div>

      <div>
        <p className="small" style={{ fontWeight: 700, margin: '0 0 6px' }}>
          Groups ({groups.length})
        </p>
        {groups.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>None. A plain member with no elevated access.</p>
        ) : (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {groups.map((g) => (
              <span key={g.name} className="pill pill-ok" title={g.description ?? undefined}>
                {g.name}
              </span>
            ))}
          </div>
        )}
      </div>

      <div>
        <p className="small" style={{ fontWeight: 700, margin: '0 0 6px' }}>
          Attributes ({user.attributes.length})
        </p>
        <div style={{ display: 'grid', gap: 4 }}>
          {user.attributes.map((a) => (
            <div
              key={a.name}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 12,
                padding: '4px 0',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span className="small muted">{a.name}</span>
              <span className="small" style={{ wordBreak: 'break-all', textAlign: 'right' }}>
                {a.value}
              </span>
            </div>
          ))}
        </div>
      </div>

      <p className="small muted" style={{ margin: 0 }}>
        Read-only. Disable, delete or reset an account from the Cognito console.
      </p>
    </div>
  );
}

function Figure({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <span>
      <span className="small muted" style={{ display: 'block' }}>
        {label}
      </span>
      <strong style={mono ? { fontFamily: 'var(--mono, monospace)', fontWeight: 600 } : undefined}>
        {value}
      </strong>
    </span>
  );
}
