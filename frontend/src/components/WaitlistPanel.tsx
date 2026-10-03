import type { WaitlistEntry } from '../lib/cms';

const joined = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(
    new Date(iso),
  );

const csvCell = (v: string) => `"${v.replace(/"/g, '""')}"`;

function download(entries: WaitlistEntry[], eventTitle: string) {
  const rows = [
    ['Name', 'Email', 'Phone', 'Status', 'Joined', 'Notified'],
    ...entries.map((w) => [w.name, w.email, w.phone ?? '', w.status, w.joined_at, w.notified_at ?? '']),
  ];
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `waitlist-${eventTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

/** Who asked to be told when a place opens, in the order they joined. Shared by the admin and facilitator rosters. */
export default function WaitlistPanel({ entries = [], eventTitle }: { entries?: WaitlistEntry[]; eventTitle: string }) {
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <h3 style={{ margin: 0 }}>Waitlist ({entries.length})</h3>
        {entries.length > 0 && (
          <button type="button" className="btn btn-ghost" style={{ padding: '6px 12px' }} onClick={() => download(entries, eventTitle)}>
            Export waitlist (CSV)
          </button>
        )}
      </div>
      {entries.length === 0 ? (
        <p className="small muted">Nobody is on the waitlist.</p>
      ) : (
        <>
          <p className="small muted">
            Joined order. “Told” means they were emailed that a place opened; it does not hold the place for them.
          </p>
          {entries.map((w, i) => (
            <div key={w.id} className="card" style={{ marginBottom: '0.5rem' }}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <strong>
                    {i + 1}. {w.name}
                  </strong>
                  <p className="small muted" style={{ margin: '0.15rem 0 0' }}>
                    <a href={`mailto:${w.email}`}>{w.email}</a>
                    {w.phone ? ` · ${w.phone}` : ''}
                  </p>
                </div>
                <span className="small">{w.status === 'notified' ? 'Told' : 'Waiting'}</span>
              </div>
              <p className="small muted" style={{ margin: '0.4rem 0 0' }}>
                Joined {joined(w.joined_at)}
                {w.notified_at && ` · told ${joined(w.notified_at)}`}
              </p>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
