/**
 * The history of one record, read from the audit log.
 *
 * Every money-affecting or status-changing admin action already writes an
 * `admin_audit_log` row with a target id; this is that trail rendered where
 * the record is, instead of only on the Audit Log screen. Optional `extra`
 * events (created, paid — facts the record itself carries) are merged in so
 * the timeline starts at the beginning, not at the first admin action.
 */
import { useEffect, useState } from 'react';
import { adminListAuditLog, type AuditEntry } from '../../../lib/cms';
import { money } from '../../../components/Layout';

export interface TimelineEvent {
  at: string;
  label: string;
  detail?: string;
  tone?: 'ok' | 'warn' | 'bad';
}

const when = (iso: string) =>
  new Intl.DateTimeFormat('en-PH', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));

export const humanAction = (a: string) =>
  a
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const toneFor = (a: string): TimelineEvent['tone'] =>
  /revok|cancel|void|reject|refund|delete/.test(a) ? 'bad' : /retry|nudge|override|waive/.test(a) ? 'warn' : 'ok';

export function entryToEvent(e: AuditEntry): TimelineEvent {
  const parts = [
    e.amount_centavos != null ? money(e.amount_centavos, e.currency ?? 'PHP') : null,
    e.note,
  ].filter(Boolean);
  return {
    at: e.created_at,
    label: `${humanAction(e.action)} — ${e.actor_label}${e.actor_source === 'shared_key' ? ' (self-declared)' : ''}`,
    detail: parts.join(' · ') || undefined,
    tone: toneFor(e.action),
  };
}

export function Timeline({
  adminKey,
  targetId,
  extra = [],
}: {
  adminKey: string;
  targetId: string;
  extra?: TimelineEvent[];
}) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    adminListAuditLog(adminKey, { targetId, limit: '100' })
      .then((r) => live && setEntries(r))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [adminKey, targetId]);

  const events = [...extra, ...(entries ?? []).map(entryToEvent)].sort(
    (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
  );

  return (
    <div className="timeline">
      <div className="timeline__head">History</div>
      {error && <div className="small muted">History unavailable: {error}</div>}
      {entries == null && !error && <div className="small muted">Loading history…</div>}
      {entries != null && events.length === 0 && <div className="small muted">No recorded activity yet.</div>}
      <ol className="timeline__list">
        {events.map((ev, i) => (
          <li key={`${ev.at}-${i}`} className={`timeline__item timeline__item--${ev.tone ?? 'ok'}`}>
            <span className="timeline__dot" aria-hidden="true" />
            <div>
              <div className="timeline__label">{ev.label}</div>
              {ev.detail && <div className="small muted">{ev.detail}</div>}
              <div className="timeline__at">{when(ev.at)}</div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
